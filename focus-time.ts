import { App, Modal, Notice, Plugin, TFile, normalizePath } from 'obsidian';

export interface FocusRecord {
    filePath: string;
    durationMs: number;
    openCount: number;
    fileExists: boolean;
}

export type FocusLeaderboardPeriod = 'week' | 'month' | 'quarter' | 'year' | 'all';

type FocusEventKind = 'session' | 'legacy-total' | 'legacy-daily';

interface FocusEvent {
    id: string;
    kind: FocusEventKind;
    deviceId: string;
    filePath: string;
    date: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    finalized: boolean;
    openCount?: number;
}

interface PathAlias {
    to: string;
    updatedAt: number;
}

interface FocusData {
    version: 2;
    events: Record<string, FocusEvent>;
    pathAliases: Record<string, PathAlias>;
    deletedPaths: Record<string, number>;
    legacyImportCompleted: boolean;
    updatedAt: string;
}

interface LegacyFocusRecord {
    fileId?: string;
    filePath?: string;
    duration?: number;
    openCount?: number;
}

interface LegacySnapshot {
    version?: number;
    records?: Record<string, FocusRecord>;
    daily?: Record<string, Record<string, number>>;
    pathAliases?: Record<string, string | PathAlias>;
    legacyImportCompleted?: boolean;
    updatedAt?: string;
}

interface FocusHostPlugin extends Plugin {
    findDailyNote(dateStr: string): Promise<TFile | null>;
    getOrCreateDailyNote(dateStr: string): Promise<TFile | null>;
    processFrontMatterSafely(
        file: TFile,
        mutate: (frontmatter: Record<string, unknown>) => void,
        protectBody?: boolean
    ): Promise<void>;
}

const CHECKPOINT_INTERVAL_MS = 60_000;
const PROPERTY_SYNC_INTERVAL_MS = 5 * 60_000;
const STORE_SAVE_INTERVAL_MS = 60_000;
const BACKUP_INTERVAL_MS = 5 * 60_000;
const ROLLING_BACKUP_COUNT = 3;
const MAX_SEGMENT_MS = 2 * 60_000;
const NOTE_FOCUS_PROPERTY = '累计专注秒';
const DAILY_FOCUS_PROPERTY = '当日专注秒';

function createEmptyData(): FocusData {
    return {
        version: 2,
        events: {},
        pathAliases: {},
        deletedPaths: {},
        legacyImportCompleted: false,
        updatedAt: new Date(0).toISOString()
    };
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Shared rule for "transient" file names (Untitled / 未命名). Such paths are reused
// across many short-lived notes and must not anchor aliases or tracking.
function isTransientBasename(basename: string): boolean {
    const lower = basename.toLowerCase();
    return lower === '未命名' || lower === 'untitled' || lower === '无标题';
}

function getLocalDateString(timestamp: number): string {
    const date = new Date(timestamp);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function getLeaderboardStartDate(period: FocusLeaderboardPeriod, timestamp = Date.now()): string | null {
    if (period === 'all') return null;

    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    if (period === 'week') {
        const daysSinceMonday = (date.getDay() + 6) % 7;
        date.setDate(date.getDate() - daysSinceMonday);
    } else if (period === 'month') {
        date.setDate(1);
    } else if (period === 'quarter') {
        date.setMonth(Math.floor(date.getMonth() / 3) * 3, 1);
    } else {
        date.setMonth(0, 1);
    }
    return getLocalDateString(date.getTime());
}

function createLegacyTotalId(path: string): string {
    return `legacy-total:${encodeURIComponent(path)}`;
}

function createLegacyDailyId(date: string, path: string): string {
    return `legacy-daily:${date}:${encodeURIComponent(path)}`;
}

function createLegacyEvent(
    id: string,
    kind: 'legacy-total' | 'legacy-daily',
    path: string,
    date: string,
    durationMs: number,
    openCount = 0
): FocusEvent {
    return {
        id,
        kind,
        deviceId: 'legacy',
        filePath: path,
        date,
        startedAt: 0,
        endedAt: 0,
        durationMs,
        finalized: true,
        openCount
    };
}

function sanitizeEvent(value: unknown, fallbackId: string): FocusEvent | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<FocusEvent>;
    if (
        !raw.filePath ||
        !isFiniteNonNegative(raw.durationMs) ||
        !['session', 'legacy-total', 'legacy-daily'].includes(raw.kind ?? '')
    ) {
        return null;
    }

    const startedAt = isFiniteNonNegative(raw.startedAt) ? raw.startedAt : 0;
    const endedAt = isFiniteNonNegative(raw.endedAt) ? raw.endedAt : startedAt;
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
        kind: raw.kind as FocusEventKind,
        deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : 'unknown',
        filePath: raw.filePath,
        date: typeof raw.date === 'string' && raw.date
            ? raw.date
            : getLocalDateString(startedAt || Date.now()),
        startedAt,
        endedAt,
        durationMs: raw.durationMs,
        finalized: raw.finalized === true,
        openCount: isFiniteNonNegative(raw.openCount) ? raw.openCount : undefined
    };
}

function sanitizeV2Data(value: unknown): FocusData | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<FocusData>;
    if (raw.version !== 2 || !raw.events || typeof raw.events !== 'object') return null;

    const clean = createEmptyData();
    clean.legacyImportCompleted = raw.legacyImportCompleted === true;
    clean.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : clean.updatedAt;

    Object.entries(raw.events).forEach(([id, value]) => {
        const event = sanitizeEvent(value, id);
        if (event) clean.events[event.id] = event;
    });

    if (raw.pathAliases && typeof raw.pathAliases === 'object') {
        Object.entries(raw.pathAliases).forEach(([oldPath, alias]) => {
            if (!alias || typeof alias !== 'object') return;
            const candidate = alias as Partial<PathAlias>;
            if (typeof candidate.to !== 'string' || !candidate.to) return;
            clean.pathAliases[oldPath] = {
                to: candidate.to,
                updatedAt: isFiniteNonNegative(candidate.updatedAt) ? candidate.updatedAt : 0
            };
        });
    }

    if (raw.deletedPaths && typeof raw.deletedPaths === 'object') {
        Object.entries(raw.deletedPaths).forEach(([path, deletedAt]) => {
            if (path && isFiniteNonNegative(deletedAt)) {
                clean.deletedPaths[path] = deletedAt;
            }
        });
    }

    return clean;
}

function convertLegacySnapshot(value: unknown): FocusData | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as LegacySnapshot;
    if (!raw.records && !raw.daily) return null;

    const converted = createEmptyData();
    converted.legacyImportCompleted = raw.legacyImportCompleted === true;
    converted.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : converted.updatedAt;

    Object.entries(raw.records ?? {}).forEach(([path, record]) => {
        if (!record || !isFiniteNonNegative(record.durationMs)) return;
        const filePath = record.filePath || path;
        const event = createLegacyEvent(
            createLegacyTotalId(filePath),
            'legacy-total',
            filePath,
            'legacy',
            record.durationMs,
            isFiniteNonNegative(record.openCount) ? record.openCount : 0
        );
        converted.events[event.id] = event;
    });

    Object.entries(raw.daily ?? {}).forEach(([date, entries]) => {
        Object.entries(entries ?? {}).forEach(([path, durationMs]) => {
            if (!isFiniteNonNegative(durationMs)) return;
            const event = createLegacyEvent(
                createLegacyDailyId(date, path),
                'legacy-daily',
                path,
                date,
                durationMs
            );
            converted.events[event.id] = event;
        });
    });

    Object.entries(raw.pathAliases ?? {}).forEach(([oldPath, alias]) => {
        if (typeof alias === 'string') {
            converted.pathAliases[oldPath] = { to: alias, updatedAt: 0 };
        } else if (alias && typeof alias.to === 'string') {
            converted.pathAliases[oldPath] = {
                to: alias.to,
                updatedAt: isFiniteNonNegative(alias.updatedAt) ? alias.updatedAt : 0
            };
        }
    });

    return converted;
}

export function parseFocusData(value: unknown): FocusData | null {
    return sanitizeV2Data(value) ?? convertLegacySnapshot(value);
}

function mergeEvent(base: FocusEvent, incoming: FocusEvent): FocusEvent {
    const later = incoming.endedAt >= base.endedAt ? incoming : base;
    return {
        ...later,
        durationMs: Math.max(base.durationMs, incoming.durationMs),
        endedAt: Math.max(base.endedAt, incoming.endedAt),
        finalized: base.finalized || incoming.finalized,
        openCount: Math.max(base.openCount ?? 0, incoming.openCount ?? 0) || undefined
    };
}

/**
 * 同 ID 表示同一专注段，保留更完整的检查点；不同 ID 表示独立专注段，直接并集。
 */
export function mergeFocusData(base: FocusData, incoming: FocusData): FocusData {
    const merged = createEmptyData();
    merged.legacyImportCompleted = base.legacyImportCompleted || incoming.legacyImportCompleted;
    merged.updatedAt = base.updatedAt > incoming.updatedAt ? base.updatedAt : incoming.updatedAt;

    for (const source of [base.events, incoming.events]) {
        Object.entries(source).forEach(([id, event]) => {
            const current = merged.events[id];
            merged.events[id] = current ? mergeEvent(current, event) : { ...event };
        });
    }

    for (const source of [base.pathAliases, incoming.pathAliases]) {
        Object.entries(source).forEach(([path, alias]) => {
            const current = merged.pathAliases[path];
            if (
                !current ||
                alias.updatedAt > current.updatedAt ||
                (alias.updatedAt === current.updatedAt && alias.to > current.to)
            ) {
                merged.pathAliases[path] = { ...alias };
            }
        });
    }

    for (const source of [base.deletedPaths, incoming.deletedPaths]) {
        Object.entries(source).forEach(([path, deletedAt]) => {
            const resolvedPath = resolvePath(merged.pathAliases, path);
            merged.deletedPaths[resolvedPath] = Math.max(
                merged.deletedPaths[resolvedPath] ?? 0,
                deletedAt
            );
        });
    }

    Object.entries(merged.events).forEach(([id, event]) => {
        const resolvedPath = resolvePath(merged.pathAliases, event.filePath);
        const deletedAt = merged.deletedPaths[resolvedPath];
        if (deletedAt !== undefined && event.endedAt <= deletedAt) {
            delete merged.events[id];
        }
    });

    return merged;
}

function resolvePath(aliases: Record<string, PathAlias>, path: string): string {
    const visited = new Set<string>();
    let current = path;
    while (
        aliases[current] &&
        aliases[current].to !== current &&
        !visited.has(current)
    ) {
        visited.add(current);
        current = aliases[current].to;
    }
    return current;
}

export function formatFocusDuration(durationMs: number): string {
    if (durationMs > 0 && durationMs < 60_000) return '<1分钟';
    const totalMinutes = Math.floor(Math.max(0, durationMs) / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}小时 ${minutes}分钟` : `${minutes}分钟`;
}

interface FocusDataHealth {
    eventCount: number;
    durationMs: number;
}

function getDataHealth(data: FocusData): FocusDataHealth {
    return Object.values(data.events).reduce(
        (health, event) => ({
            eventCount: health.eventCount + 1,
            durationMs: health.durationMs + event.durationMs
        }),
        { eventCount: 0, durationMs: 0 }
    );
}

function isMaterialShrink(candidate: FocusData, reference: FocusData): boolean {
    const candidateHealth = getDataHealth(candidate);
    const referenceHealth = getDataHealth(reference);
    if (referenceHealth.eventCount < 100 || referenceHealth.durationMs <= 0) return false;

    return candidateHealth.eventCount < referenceHealth.eventCount * 0.7 &&
        candidateHealth.durationMs < referenceHealth.durationMs * 0.7;
}

function mergePreservingHistory(base: FocusData, incoming: FocusData): FocusData {
    // A stale deletion tombstone must not erase a known-good snapshot during recovery.
    return mergeFocusData(base, { ...incoming, deletedPaths: {} });
}

class FocusRecoveryModal extends Modal {
    private settled = false;
    private resolveDecision: ((restore: boolean) => void) | null = null;

    constructor(app: App, private readonly message: string) {
        super(app);
    }

    waitForDecision(): Promise<boolean> {
        return new Promise(resolve => {
            this.resolveDecision = resolve;
            this.open();
        });
    }

    private decide(restore: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolveDecision?.(restore);
        this.close();
    }

    onOpen(): void {
        this.titleEl.setText('\u68c0\u6d4b\u5230\u4e13\u6ce8\u6570\u636e\u53ef\u80fd\u5f02\u5e38');
        this.contentEl.empty();
        this.contentEl.createEl('p', {
            text: this.message,
            cls: 'word-count-calendar-recovery-message'
        });
        const restore = this.contentEl.createEl('button', {
            text: '\u6062\u590d\u5907\u4efd',
            cls: 'mod-cta'
        });
        restore.addEventListener('click', () => this.decide(true));
        const keep = this.contentEl.createEl('button', {
            text: '\u4fdd\u7559\u5f53\u524d\u6570\u636e',
            cls: 'word-count-calendar-modal-secondary-button'
        });
        keep.addEventListener('click', () => this.decide(false));
        restore.focus();

        // Recovery warnings must be acknowledged with the button, not Escape.
        this.modalEl.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
    }

    onClose(): void {
        // Closing the window chrome counts as choosing to keep current data.
        if (!this.settled) {
            this.settled = true;
            this.resolveDecision?.(false);
        }
        this.contentEl.empty();
    }
}

class FocusTimeStore {
    private data = createEmptyData();
    private saveQueue: Promise<void> = Promise.resolve();
    private saveQueued = false;
    private scheduledSaveTimer: number | null = null;
    private lastBackupAt = 0;
    private readonly dataPath: string;
    private readonly backupPath: string;
    private readonly rollingBackupDir: string;
    private readonly pluginDir: string;
    private declinedRecoveryUpdatedAt: string | null = null;

    constructor(private plugin: Plugin) {
        this.pluginDir = normalizePath(
            plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
        );
        this.dataPath = normalizePath(`${this.pluginDir}/focus-time-data.json`);
        this.backupPath = normalizePath(`${this.pluginDir}/focus-time-data.backup.json`);
        this.rollingBackupDir = normalizePath(`${this.pluginDir}/focus-time-backups`);
    }

    private async shouldRestoreFromBackup(candidate: FocusData, recovery: FocusData): Promise<boolean> {
        if (!isMaterialShrink(candidate, recovery)) return false;
        if (this.declinedRecoveryUpdatedAt === recovery.updatedAt) return false;

        const candidateHealth = getDataHealth(candidate);
        const recoveryHealth = getDataHealth(recovery);
        const hours = (durationMs: number) => (durationMs / 3_600_000).toFixed(1);
        /*
        const restore = await new FocusRecoveryModal(
            this.plugin.app,
            `\u4e3b\u6570\u636e：${candidateHealth.eventCount} \u6761\u4e8b\u4ef6 / ${hours(candidateHealth.durationMs)} \u5c0f\u65f6\uff1b\u672c\u5730\u5907\u4efd：${recoveryHealth.eventCount} \u6761\u4e8b\u4ef6 / ${hours(recoveryHealth.durationMs)} \u5c0f\u65f6\u3002\n\u8bf7\u624b\u52a8\u5224\u65ad\u662f\u5426\u6062\u590d\u3002'
        ).waitForDecision();
        */
        const message =
            '主数据: ' + candidateHealth.eventCount +
            ' 条事件 / ' + hours(candidateHealth.durationMs) +
            ' 小时; 本地备份: ' + recoveryHealth.eventCount +
            ' 条事件 / ' + hours(recoveryHealth.durationMs) +
            ' 小时。\n请手动判断是否恢复。';
        const restore = await new FocusRecoveryModal(this.plugin.app, message).waitForDecision();
        if (!restore) this.declinedRecoveryUpdatedAt = recovery.updatedAt;
        return restore;
    }

    async load(): Promise<void> {
        let loaded = createEmptyData();
        const candidates = new Set<string>([this.dataPath, this.backupPath]);

        try {
            const listed = await this.plugin.app.vault.adapter.list(this.pluginDir);
            // Only merge canonical and sync conflict snapshots. Cleanup/recovery
            // artifacts are reports, not authoritative event sources.
            listed.files
                .filter(path => /focus-time-data(?: \([^/]*\))?\.json$/i.test(path))
                .forEach(path => candidates.add(normalizePath(path)));
        } catch (error) {
            console.warn('无法扫描专注事件账本的冲突副本:', error);
        }

        for (const path of candidates) {
            const candidate = await this.readData(path);
            if (candidate) loaded = mergeFocusData(loaded, candidate);
        }

        const recovery = await this.readBestRollingBackup();
        if (recovery && await this.shouldRestoreFromBackup(loaded, recovery)) {
            loaded = mergePreservingHistory(recovery, loaded);
        }

        this.data = loaded;
    }

    getData(): FocusData {
        return this.data;
    }

    async importLegacyData(): Promise<number> {
        if (this.data.legacyImportCompleted) return 0;

        const legacyDir = normalizePath(`${this.plugin.app.vault.configDir}/plugins/focus-time`);
        const adapter = this.plugin.app.vault.adapter;
        const importedIds = new Set<string>();
        const fileIdToPath = new Map<string, string>();

        try {
            if (!(await adapter.exists(legacyDir))) {
                this.data.legacyImportCompleted = true;
                await this.save();
                return 0;
            }

            const listed = await adapter.list(legacyDir);
            const legacyFiles = listed.files.filter(path => /\/data(?: .*|-[^/]*)?\.json$/i.test(path));

            for (const path of legacyFiles) {
                try {
                    const parsed = JSON.parse(await adapter.read(path)) as {
                        readData?: Record<string, LegacyFocusRecord>;
                    };
                    Object.entries(parsed.readData ?? {}).forEach(([key, record]) => {
                        const filePath = record.filePath || key;
                        if (!filePath || !isFiniteNonNegative(record.duration)) return;
                        const id = createLegacyTotalId(filePath);
                        const event = createLegacyEvent(
                            id,
                            'legacy-total',
                            filePath,
                            'legacy',
                            record.duration,
                            record.openCount ?? 0
                        );
                        this.upsertEvent(event);
                        importedIds.add(id);
                        if (record.fileId) fileIdToPath.set(record.fileId, filePath);
                    });
                } catch (error) {
                    console.warn(`跳过无法读取的旧专注数据: ${path}`, error);
                }
            }

            await this.importLegacyDailyData(legacyDir, fileIdToPath, importedIds);
        } catch (error) {
            console.warn('导入旧专注数据失败，将在下次启动时重试:', error);
            return importedIds.size;
        }

        this.data.legacyImportCompleted = true;
        await this.save();
        return importedIds.size;
    }

    private async importLegacyDailyData(
        legacyDir: string,
        fileIdToPath: Map<string, string>,
        importedIds: Set<string>
    ): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const dailyDir = normalizePath(`${legacyDir}/data`);
        if (!(await adapter.exists(dailyDir))) return;

        const listed = await adapter.list(dailyDir);
        for (const path of listed.files.filter(file => file.endsWith('.json'))) {
            try {
                const rawDate = path.split('/').pop()?.replace(/\.json$/i, '');
                if (!rawDate) continue;
                const parts = rawDate.split('-').map(Number);
                if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) continue;
                const date = `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
                const parsed = JSON.parse(await adapter.read(path)) as {
                    dailyReadData?: Record<string, { fileId?: string; duration?: number }>;
                };
                Object.values(parsed.dailyReadData ?? {}).forEach(record => {
                    const filePath = record.fileId ? fileIdToPath.get(record.fileId) : undefined;
                    if (!filePath || !isFiniteNonNegative(record.duration)) return;
                    const id = createLegacyDailyId(date, filePath);
                    this.upsertEvent(createLegacyEvent(
                        id,
                        'legacy-daily',
                        filePath,
                        date,
                        record.duration
                    ));
                    importedIds.add(id);
                });
            } catch (error) {
                console.warn(`跳过无法读取的旧每日专注数据: ${path}`, error);
            }
        }
    }

    private upsertEvent(event: FocusEvent): void {
        const current = this.data.events[event.id];
        this.data.events[event.id] = current ? mergeEvent(current, event) : event;
    }

    save(): Promise<void> {
        if (this.scheduledSaveTimer !== null) {
            window.clearTimeout(this.scheduledSaveTimer);
            this.scheduledSaveTimer = null;
        }
        if (this.saveQueued) return this.saveQueue;
        this.saveQueued = true;
        this.saveQueue = this.saveQueue
            .then(async () => {
                this.saveQueued = false;
                await this.writeMergedSnapshot();
            })
            .catch(error => {
                this.saveQueued = false;
                console.error('保存专注事件账本失败:', error);
            });
        return this.saveQueue;
    }

    scheduleSave(): void {
        if (this.scheduledSaveTimer !== null) return;
        this.scheduledSaveTimer = window.setTimeout(() => {
            this.scheduledSaveTimer = null;
            void this.save();
        }, STORE_SAVE_INTERVAL_MS);
    }

    cancelScheduledSave(): void {
        if (this.scheduledSaveTimer === null) return;
        window.clearTimeout(this.scheduledSaveTimer);
        this.scheduledSaveTimer = null;
    }

    async flush(): Promise<void> {
        if (this.scheduledSaveTimer !== null) {
            window.clearTimeout(this.scheduledSaveTimer);
            this.scheduledSaveTimer = null;
        }
        await this.save();
        await this.saveQueue;
    }

    private async writeMergedSnapshot(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        let finalData = this.data;

        if (!(await adapter.exists(this.dataPath))) {
            finalData.updatedAt = new Date().toISOString();
            const initial = JSON.stringify(finalData, null, 2);
            await adapter.write(this.dataPath, initial);
            await adapter.write(this.backupPath, initial);
            await this.writeRollingBackup(finalData);
            this.lastBackupAt = Date.now();
            this.data = finalData;
            return;
        }

        const external = await this.readData(this.dataPath);
        if (external) finalData = mergeFocusData(external, finalData);

        const recovery = await this.readBestRollingBackup();
        const approvedRecovery = recovery
            ? await this.shouldRestoreFromBackup(finalData, recovery)
            : false;
        if (approvedRecovery && recovery) {
            finalData = mergePreservingHistory(recovery, finalData);
        }

        const written = await adapter.process(this.dataPath, currentText => {
            if (currentText.trim() && !approvedRecovery) {
                try {
                    const external = parseFocusData(JSON.parse(currentText));
                    if (external) finalData = mergeFocusData(external, finalData);
                } catch (error) {
                    console.warn('主专注账本损坏，使用内存与备份恢复:', error);
                }
            }
            finalData.updatedAt = new Date().toISOString();
            return JSON.stringify(finalData, null, 2);
        });

        const persisted = parseFocusData(JSON.parse(written));
        this.data = persisted
            ? (approvedRecovery
                ? mergePreservingHistory(persisted, this.data)
                : mergeFocusData(persisted, this.data))
            : finalData;
        if (Date.now() - this.lastBackupAt >= BACKUP_INTERVAL_MS) {
            await adapter.write(this.backupPath, JSON.stringify(this.data, null, 2));
            await this.writeRollingBackup(this.data);
            this.lastBackupAt = Date.now();
        }
    }

    private async writeRollingBackup(data: FocusData): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        try {
            if (!(await adapter.exists(this.rollingBackupDir))) {
                await adapter.mkdir(this.rollingBackupDir);
            }

            const stamp = new Date().toISOString().replace(/[.:]/g, '-');
            const path = normalizePath(`${this.rollingBackupDir}/focus-time-data.${stamp}.json`);
            await adapter.write(path, JSON.stringify(data, null, 2));

            const listed = await adapter.list(this.rollingBackupDir);
            const snapshots = listed.files
                .filter(file => /focus-time-data\.[^/]+\.json$/i.test(file))
                .sort()
                .reverse();
            for (const stale of snapshots.slice(ROLLING_BACKUP_COUNT)) {
                await adapter.remove(stale);
            }
        } catch (error) {
            console.warn('无法写入专注数据滚动备份:', error);
        }
    }

    private async readBestRollingBackup(): Promise<FocusData | null> {
        const adapter = this.plugin.app.vault.adapter;
        try {
            if (!(await adapter.exists(this.rollingBackupDir))) return null;
            const listed = await adapter.list(this.rollingBackupDir);
            const paths = listed.files
                .filter(file => /focus-time-data\.[^/]+\.json$/i.test(file))
                .sort()
                .reverse();
            let best: FocusData | null = null;
            for (const path of paths) {
                const candidate = await this.readData(path);
                if (!candidate) continue;
                if (!best) {
                    best = candidate;
                    continue;
                }
                const currentHealth = getDataHealth(candidate);
                const bestHealth = getDataHealth(best);
                if (
                    currentHealth.eventCount > bestHealth.eventCount ||
                    (currentHealth.eventCount === bestHealth.eventCount &&
                        currentHealth.durationMs > bestHealth.durationMs)
                ) {
                    best = candidate;
                }
            }
            return best;
        } catch (error) {
            console.warn('无法读取专注数据滚动备份:', error);
            return null;
        }
    }

    private async readData(path: string): Promise<FocusData | null> {
        try {
            const adapter = this.plugin.app.vault.adapter;
            if (!(await adapter.exists(path))) return null;
            return parseFocusData(JSON.parse(await adapter.read(path)));
        } catch (error) {
            console.warn(`无法读取专注事件账本: ${path}`, error);
            return null;
        }
    }
}

export class FocusTimeTracker {
    private readonly store: FocusTimeStore;
    private readonly deviceId: string;
    private currentFile: TFile | null = null;
    private currentSessionId: string | null = null;
    private lastTick = Date.now();
    private windowFocused = document.hasFocus();
    private started = false;
    private dirtyPaths = new Set<string>();
    private dirtyDates = new Set<string>();
    private projectionQueue: Promise<void> = Promise.resolve();

    constructor(
        private plugin: FocusHostPlugin,
        private isTrackingEnabled: () => boolean,
        private isStrictMode: () => boolean,
        private isPropertySyncEnabled: () => boolean,
        private onUpdate: () => void
    ) {
        this.store = new FocusTimeStore(plugin);
        this.deviceId = this.getOrCreateDeviceId();
    }

    /**
     * Drop stale aliases and orphan events left by the pre-fix rename logic:
     *   - alias keys whose basename is 未命名/Untitled/无标题 (they chained unrelated history)
     *   - events whose filePath basename is transient AND the file no longer exists
     *     (a real note still named 未命名 is preserved).
     * Idempotent — safe to run on every load.
     */
    private cleanupTransientAliases(): { aliases: number; events: number } {
        const data = this.store.getData();
        let removedAliases = 0;
        let removedEvents = 0;

        Object.keys(data.pathAliases).forEach(path => {
            const filename = path.split('/').pop() ?? '';
            const basename = filename.replace(/\.[^.]+$/, '');
            if (isTransientBasename(basename)) {
                delete data.pathAliases[path];
                removedAliases++;
            }
        });

        Object.keys(data.events).forEach(id => {
            const filePath = data.events[id].filePath;
            const filename = filePath.split('/').pop() ?? '';
            const basename = filename.replace(/\.[^.]+$/, '');
            if (!isTransientBasename(basename)) return;
            // Keep events for a real note still named 未命名; only drop orphans.
            if (this.plugin.app.vault.getFileByPath(normalizePath(filePath))) return;
            delete data.events[id];
            removedEvents++;
        });

        return { aliases: removedAliases, events: removedEvents };
    }

    async start(): Promise<void> {
        await this.store.load();
        const imported = await this.store.importLegacyData();
        if (imported > 0) {
            new Notice(`已转换并导入 ${imported} 条旧专注记录`);
        }

        const cleaned = this.cleanupTransientAliases();
        if (cleaned.aliases > 0 || cleaned.events > 0) {
            await this.store.save();
            new Notice(`已清理 ${cleaned.aliases} 条失效别名、${cleaned.events} 条未命名孤儿事件`);
        }

        this.started = true;
        this.setCurrentFile(this.plugin.app.workspace.getActiveFile());

        this.plugin.registerEvent(
            this.plugin.app.workspace.on('file-open', file => this.setCurrentFile(file))
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) this.handleRename(file, oldPath);
            })
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on('create', file => {
                if (file instanceof TFile) this.handleCreate(file);
            })
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on('delete', file => {
                if (file instanceof TFile) this.handleDelete(file);
            })
        );
        this.plugin.registerDomEvent(window, 'focus', () => {
            if (!this.isStrictMode()) this.captureNow();
            this.windowFocused = true;
            this.lastTick = Date.now();
            this.startSessionIfNeeded(this.lastTick);
        });
        this.plugin.registerDomEvent(window, 'blur', () => {
            const shouldFinalize = this.isStrictMode();
            this.captureNow(shouldFinalize);
            this.windowFocused = false;
            this.lastTick = Date.now();
            if (shouldFinalize) void this.flushDirtyProperties();
        });
        this.plugin.registerInterval(window.setInterval(() => {
            this.captureNow();
        }, CHECKPOINT_INTERVAL_MS));
        this.plugin.registerInterval(window.setInterval(() => {
            void this.flushDirtyProperties();
        }, PROPERTY_SYNC_INTERVAL_MS));

        this.onUpdate();
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.captureNow(true);
        await this.store.flush();
        await this.flushDirtyProperties();
        this.started = false;
    }

    prepareForUnload(): void {
        this.started = false;
        this.currentSessionId = null;
        this.dirtyPaths.clear();
        this.dirtyDates.clear();
        this.store.cancelScheduledSave();
    }

    captureNow(finalize = false): void {
        const now = Date.now();
        this.captureElapsed(now);
        if (finalize) this.finalizeCurrentSession(now);
        this.lastTick = now;
        this.onUpdate();
    }

    syncTrackingState(): void {
        const now = Date.now();
        if (this.canTrack()) {
            this.startSessionIfNeeded(now);
        } else {
            this.finalizeCurrentSession(now);
        }
        this.lastTick = now;
    }

    getCurrentFileDuration(): number {
        if (!this.currentFile) return 0;
        return this.getRecordDuration(this.currentFile.path) + this.getLiveSegment();
    }

    getTodayDuration(): number {
        const today = getLocalDateString(Date.now());
        const stored = Object.values(this.store.getData().events)
            .filter(event => event.kind !== 'legacy-total' && event.date === today)
            .reduce((sum, event) => sum + event.durationMs, 0);
        return stored + this.getLiveSegment();
    }

    getTotalDuration(): number {
        const stored = Object.values(this.store.getData().events)
            .filter(event => event.kind !== 'legacy-daily')
            .reduce((sum, event) => sum + event.durationMs, 0);
        return stored + this.getLiveSegment();
    }

    getCurrentFilePath(): string | null {
        return this.currentFile?.path ?? null;
    }

    getFileDuration(file: TFile): number {
        return this.getRecordDuration(file.path);
    }

    getLeaderboard(period: FocusLeaderboardPeriod = 'all'): FocusRecord[] {
        const records = this.buildRecordMap(period);
        const livePath = this.currentFile?.path;
        if (livePath) {
            const resolvedPath = this.resolvePath(livePath);
            const record = records.get(resolvedPath) ?? {
                filePath: resolvedPath,
                durationMs: 0,
                openCount: 0,
                fileExists: true
            };
            record.durationMs += this.getLiveSegment();
            records.set(resolvedPath, record);
        }

        return Array.from(records.values())
            .filter(record => record.durationMs >= 60_000)
            .sort((a, b) => b.durationMs - a.durationMs);
    }

    async openRecord(record: FocusRecord): Promise<void> {
        const file = this.plugin.app.vault.getFileByPath(normalizePath(record.filePath));
        if (!file) {
            new Notice(`文件不存在：${record.filePath}。可右键删除这条历史记录。`);
            return;
        }
        await this.plugin.app.workspace.getLeaf('tab').openFile(file);
    }

    async deleteRecord(record: FocusRecord): Promise<number> {
        const targetPath = this.resolvePath(record.filePath);
        const currentPath = this.currentFile ? this.resolvePath(this.currentFile.path) : null;
        const deletingCurrentRecord = currentPath === targetPath;

        if (deletingCurrentRecord) this.captureNow(true);

        const deletedAt = Date.now();
        const affectedDates = new Set<string>();
        let deletedCount = 0;

        Object.entries(this.store.getData().events).forEach(([id, event]) => {
            if (this.resolvePath(event.filePath) !== targetPath) return;
            if (event.kind !== 'legacy-total') affectedDates.add(event.date);
            delete this.store.getData().events[id];
            deletedCount++;
        });

        const deletedPaths = this.store.getData().deletedPaths;
        deletedPaths[targetPath] = Math.max(deletedPaths[targetPath] ?? 0, deletedAt);
        this.dirtyPaths.add(targetPath);
        affectedDates.forEach(date => this.dirtyDates.add(date));

        await this.store.save();
        await this.flushDirtyProperties();

        if (deletingCurrentRecord) {
            this.lastTick = Date.now();
            this.startSessionIfNeeded(this.lastTick);
        }

        this.onUpdate();
        return deletedCount;
    }

    /**
     * Manually override a file's cumulative focus duration. Wipes every event that
     * resolves to this file (including inherited history) and writes a single base
     * event of the requested size. Pass 0 to fully clear. Bypasses the max() guard in
     * writeNoteProjection so the frontmatter property can also decrease.
     */
    async setFocusDuration(file: TFile, targetMs: number): Promise<void> {
        const isCurrent = this.currentFile?.path === file.path;
        if (isCurrent) this.captureNow(true);

        const resolvedPath = this.resolvePath(file.path);
        const events = this.store.getData().events;

        Object.entries(events).forEach(([id, event]) => {
            if (this.resolvePath(event.filePath) === resolvedPath) {
                delete events[id];
            }
        });

        if (targetMs > 0) {
            const now = Date.now();
            const id = this.createEventId(now);
            events[id] = {
                id,
                kind: 'session',
                deviceId: this.deviceId,
                filePath: file.path,
                // 'manual-adjustment' keeps this base event out of any specific day's
                // daily total (it is not real activity on that date) while still
                // counting toward the file's cumulative duration and all-time leaderboard.
                date: 'manual-adjustment',
                startedAt: now,
                endedAt: now,
                durationMs: targetMs,
                finalized: true
            };
        }

        this.dirtyPaths.add(resolvedPath);
        await this.store.save();

        if (this.isPropertySyncEnabled()) {
            await this.writeNoteProjection(file.path, true);
        }

        if (isCurrent) {
            this.lastTick = Date.now();
            this.startSessionIfNeeded(this.lastTick);
        }

        this.onUpdate();
    }

    async reassignRecord(record: FocusRecord, targetPath: string): Promise<number> {
        this.captureNow(true);

        const sourcePath = record.filePath;
        const resolvedTarget = this.resolvePath(targetPath);
        if (sourcePath === resolvedTarget) return 0;

        const aliases = this.store.getData().pathAliases;

        // Count BEFORE creating the alias — resolvePath result changes after.
        let count = 0;
        Object.values(this.store.getData().events).forEach(event => {
            if (this.resolvePath(event.filePath) === sourcePath) count++;
        });

        const now = Date.now();
        aliases[sourcePath] = { to: resolvedTarget, updatedAt: now };
        Object.entries(aliases).forEach(([path, alias]) => {
            if (path !== sourcePath && alias.to === sourcePath) {
                aliases[path] = { to: resolvedTarget, updatedAt: now };
            }
        });

        this.dirtyPaths.add(resolvedTarget);

        await this.store.save();
        await this.flushDirtyProperties();
        this.onUpdate();
        return count;
    }

    async rebuildProperties(): Promise<void> {
        this.captureNow();
        if (!this.isPropertySyncEnabled()) {
            new Notice('请先在设置中启用“同步专注数据到笔记属性”');
            return;
        }

        const paths = new Set<string>();
        const dates = new Set<string>();
        Object.values(this.store.getData().events).forEach(event => {
            if (event.kind !== 'legacy-daily') paths.add(this.resolvePath(event.filePath));
            if (event.kind !== 'legacy-total') dates.add(event.date);
        });

        let noteCount = 0;
        let dayCount = 0;
        for (const path of paths) {
            if (await this.writeNoteProjection(path)) noteCount++;
        }
        for (const date of dates) {
            const dailyNote = await this.plugin.findDailyNote(date);
            if (dailyNote && await this.writeDailyProjection(date, dailyNote)) dayCount++;
        }

        new Notice(`专注属性重建完成：${noteCount} 篇笔记，${dayCount} 篇日记`);
    }

    private setCurrentFile(file: TFile | null): void {
        if (this.currentFile?.path === file?.path) return;
        this.captureNow(true);
        void this.flushDirtyProperties();
        this.currentFile = file;
        this.lastTick = Date.now();
        this.startSessionIfNeeded(this.lastTick);
        this.onUpdate();
    }

    private captureElapsed(now: number): void {
        if (!this.canTrack() || !this.currentFile) return;
        this.startSessionIfNeeded(this.lastTick);
        if (!this.currentSessionId) return;

        const elapsed = Math.min(Math.max(0, now - this.lastTick), MAX_SEGMENT_MS);
        if (elapsed <= 0) return;

        const effectiveStart = now - elapsed;
        const currentDate = getLocalDateString(effectiveStart);
        const endDate = getLocalDateString(now);

        const currentEvent = this.currentSessionId
            ? this.store.getData().events[this.currentSessionId]
            : null;
        if (currentEvent && currentEvent.date !== currentDate) {
            this.finalizeCurrentSession(effectiveStart);
            this.startSessionIfNeeded(effectiveStart);
        }

        if (currentDate !== endDate) {
            const end = new Date(now);
            const midnight = new Date(
                end.getFullYear(),
                end.getMonth(),
                end.getDate()
            ).getTime();
            const firstPart = Math.max(0, midnight - effectiveStart);
            const secondPart = Math.max(0, now - midnight);
            if (firstPart > 0) this.appendToCurrentSession(firstPart, midnight);
            this.finalizeCurrentSession(midnight);
            this.startSessionIfNeeded(midnight);
            if (secondPart > 0) this.appendToCurrentSession(secondPart, now);
        } else {
            this.appendToCurrentSession(elapsed, now);
        }

        this.store.scheduleSave();
    }

    private startSessionIfNeeded(startedAt: number): void {
        if (this.currentSessionId || !this.currentFile || !this.canTrack()) return;
        const id = this.createEventId(startedAt);
        this.store.getData().events[id] = {
            id,
            kind: 'session',
            deviceId: this.deviceId,
            filePath: this.currentFile.path,
            date: getLocalDateString(startedAt),
            startedAt,
            endedAt: startedAt,
            durationMs: 0,
            finalized: false
        };
        this.currentSessionId = id;
    }

    private appendToCurrentSession(durationMs: number, endedAt: number): void {
        if (!this.currentSessionId) return;
        const event = this.store.getData().events[this.currentSessionId];
        if (!event) return;
        event.durationMs += durationMs;
        event.endedAt = endedAt;
        this.dirtyPaths.add(this.resolvePath(event.filePath));
        this.dirtyDates.add(event.date);
    }

    private finalizeCurrentSession(endedAt: number): void {
        if (!this.currentSessionId) return;
        const event = this.store.getData().events[this.currentSessionId];
        if (event) {
            if (event.durationMs <= 0) {
                delete this.store.getData().events[event.id];
            } else {
                event.finalized = true;
                event.endedAt = Math.max(event.endedAt, endedAt);
                void this.store.save();
            }
        }
        this.currentSessionId = null;
    }

    private handleRename(file: TFile, oldPath: string): void {
        this.captureNow(true);
        const aliases = this.store.getData().pathAliases;
        const now = Date.now();

        // Skip alias creation when leaving a transient path (未命名/Untitled). These paths
        // are reused by every new note, so they accumulate orphan events from unrelated
        // files. Aliasing them would drag that history into the renamed file.
        const oldFilename = oldPath.split('/').pop() ?? '';
        const oldBasename = oldFilename.replace(/\.[^.]+$/, '');
        if (!isTransientBasename(oldBasename)) {
            // Create oldPath -> newPath alias to preserve history across renames
            aliases[oldPath] = { to: file.path, updatedAt: now };

            // Update any aliases pointing to oldPath to point to the new path
            Object.entries(aliases).forEach(([path, alias]) => {
                if (path !== oldPath && alias.to === oldPath) {
                    aliases[path] = { to: file.path, updatedAt: now };
                }
            });
        }

        this.dirtyPaths.delete(oldPath);
        this.dirtyPaths.add(file.path);
        if (this.currentFile?.path === file.path || this.currentFile?.path === oldPath) {
            this.currentFile = file;
        }
        this.lastTick = now;
        this.startSessionIfNeeded(now);
        void this.store.save();
        void this.flushDirtyProperties();
        this.onUpdate();
    }

    private handleCreate(file: TFile): void {
        // Mark the created path as a new identity terminus to prevent inheriting
        // stale alias chains when a file is recreated at a previously used path.
        const aliases = this.store.getData().pathAliases;
        const now = Date.now();
        aliases[file.path] = { to: file.path, updatedAt: now };
        void this.store.save();
    }

    private handleDelete(file: TFile): void {
        if (this.currentFile?.path === file.path) {
            this.captureNow(true);
            this.currentFile = null;
            this.lastTick = Date.now();
        }

        // Keep history when a note disappears. A later sync may recreate the
        // same path, and historical focus time should remain recoverable.
        this.dirtyPaths.delete(file.path);

        void this.store.save();
        void this.flushDirtyProperties();
        this.onUpdate();
    }

    private buildRecordMap(period: FocusLeaderboardPeriod = 'all'): Map<string, FocusRecord> {
        const records = new Map<string, FocusRecord>();
        const startDate = getLeaderboardStartDate(period);
        const endDate = getLocalDateString(Date.now());
        Object.values(this.store.getData().events).forEach(event => {
            if (period === 'all') {
                if (event.kind === 'legacy-daily') return;
            } else {
                if (
                    event.kind === 'legacy-total' ||
                    !startDate ||
                    event.date < startDate ||
                    event.date > endDate
                ) return;
            }
            const filePath = this.resolvePath(event.filePath);
            const record = records.get(filePath) ?? {
                filePath,
                durationMs: 0,
                openCount: 0,
                fileExists: this.plugin.app.vault.getFileByPath(normalizePath(filePath)) !== null
            };
            record.durationMs += event.durationMs;
            record.openCount += event.kind === 'session' && event.durationMs > 0
                ? 1
                : event.openCount ?? 0;
            records.set(filePath, record);
        });
        return records;
    }

    private getRecordDuration(path: string): number {
        return this.buildRecordMap().get(this.resolvePath(path))?.durationMs ?? 0;
    }

    private getDateDuration(date: string): number {
        return Object.values(this.store.getData().events)
            .filter(event => event.kind !== 'legacy-total' && event.date === date)
            .reduce((sum, event) => sum + event.durationMs, 0);
    }

    private getLiveSegment(): number {
        if (!this.canTrack() || !this.currentFile || !this.currentSessionId) return 0;
        return Math.min(Math.max(0, Date.now() - this.lastTick), MAX_SEGMENT_MS);
    }

    private resolvePath(path: string): string {
        return resolvePath(this.store.getData().pathAliases, path);
    }

    private canTrack(): boolean {
        if (!this.started || !this.isTrackingEnabled()) return false;
        if (this.isStrictMode() && !this.windowFocused) return false;

        // Exclude untitled/unnamed files from tracking
        if (this.currentFile && isTransientBasename(this.currentFile.basename)) {
            return false;
        }

        return true;
    }

    private flushDirtyProperties(): Promise<void> {
        if (
            !this.started ||
            !this.isPropertySyncEnabled() ||
            (this.dirtyPaths.size === 0 && this.dirtyDates.size === 0)
        ) {
            return this.projectionQueue;
        }

        const paths = Array.from(this.dirtyPaths);
        const dates = Array.from(this.dirtyDates);
        this.dirtyPaths.clear();
        this.dirtyDates.clear();

        this.projectionQueue = this.projectionQueue.then(async () => {
            if (!this.started) return;
            for (const path of paths) {
                try {
                    await this.writeNoteProjection(path);
                } catch (error) {
                    this.dirtyPaths.add(path);
                    console.error(`写入笔记专注属性失败: ${path}`, error);
                }
            }
            for (const date of dates) {
                try {
                    const dailyNote = await this.plugin.getOrCreateDailyNote(date);
                    if (dailyNote) {
                        await this.writeDailyProjection(date, dailyNote);
                    } else {
                        this.dirtyDates.add(date);
                    }
                } catch (error) {
                    this.dirtyDates.add(date);
                    console.error(`写入日记专注属性失败: ${date}`, error);
                }
            }
        });

        return this.projectionQueue;
    }

    private async writeNoteProjection(path: string, force = false): Promise<boolean> {
        const file = this.plugin.app.vault.getFileByPath(normalizePath(path));
        if (!file || file.extension !== 'md') return false;

        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const currentProperty = cache?.frontmatter?.[NOTE_FOCUS_PROPERTY];
        const calculatedSeconds = Math.round(this.getRecordDuration(path) / 1000);

        // Use max(current, calculated) to respect manual increases while continuing to track.
        // When force (manual override via setFocusDuration), write calculated directly so
        // the property can also decrease, not just increase.
        const finalValue = force
            ? calculatedSeconds
            : (typeof currentProperty === 'number'
                ? Math.max(currentProperty, calculatedSeconds)
                : calculatedSeconds);

        if (currentProperty === finalValue) return false;

        await this.plugin.processFrontMatterSafely(file, frontmatter => {
            frontmatter[NOTE_FOCUS_PROPERTY] = finalValue;
        });
        return true;
    }

    private async writeDailyProjection(date: string, dailyNote: TFile): Promise<boolean> {
        const cache = this.plugin.app.metadataCache.getFileCache(dailyNote);
        const currentProperty = cache?.frontmatter?.[DAILY_FOCUS_PROPERTY];
        const calculatedSeconds = Math.round(this.getDateDuration(date) / 1000);

        // Use max(current, calculated) to respect manual increases while continuing to track
        const finalValue = typeof currentProperty === 'number'
            ? Math.max(currentProperty, calculatedSeconds)
            : calculatedSeconds;

        if (currentProperty === finalValue) return false;

        await this.plugin.processFrontMatterSafely(dailyNote, frontmatter => {
            frontmatter[DAILY_FOCUS_PROPERTY] = finalValue;
        });
        return true;
    }

    private async syncPropertyToEvents(path: string, targetDurationMs: number): Promise<void> {
        const resolvedPath = this.resolvePath(path);
        const currentDurationMs = this.getRecordDuration(path);
        const diff = targetDurationMs - currentDurationMs;

        if (Math.abs(diff) < 1000) return; // Ignore sub-second differences

        // Create a manual adjustment event
        const now = Date.now();
        const adjustmentEvent: FocusEvent = {
            id: this.createEventId(now),
            kind: 'session',
            deviceId: this.deviceId,
            filePath: resolvedPath,
            date: 'manual-adjustment',
            startedAt: now,
            endedAt: now,
            durationMs: diff,
            finalized: true
        };

        this.store.getData().events[adjustmentEvent.id] = adjustmentEvent;
        await this.store.save();
        this.onUpdate();
    }

    private async syncDailyPropertyToEvents(date: string, targetDurationMs: number): Promise<void> {
        const currentDurationMs = this.getDateDuration(date);
        const diff = targetDurationMs - currentDurationMs;

        if (Math.abs(diff) < 1000) return; // Ignore sub-second differences

        // Create a manual adjustment event for this date
        const now = Date.now();
        const adjustmentEvent: FocusEvent = {
            id: this.createEventId(now),
            kind: 'session',
            deviceId: this.deviceId,
            filePath: `daily-adjustment-${date}`,
            date: date,
            startedAt: now,
            endedAt: now,
            durationMs: diff,
            finalized: true
        };

        this.store.getData().events[adjustmentEvent.id] = adjustmentEvent;
        await this.store.save();
        this.onUpdate();
    }

    private createEventId(timestamp: number): string {
        const random = Math.random().toString(36).slice(2, 10);
        return `${this.deviceId}:${timestamp.toString(36)}:${random}`;
    }

    private getOrCreateDeviceId(): string {
        const key = `word-count-calendar:focus-device:${this.plugin.app.vault.getName()}`;
        try {
            const existing = window.localStorage.getItem(key);
            if (existing) return existing;
            const created = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
            window.localStorage.setItem(key, created);
            return created;
        } catch {
            return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        }
    }
}
