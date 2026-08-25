import { App, MarkdownView, Modal, Notice, Plugin, Setting, TFile, parseYaml } from 'obsidian';
import { WordCountSettings, DEFAULT_SETTINGS } from './settings';
import { WordCounter } from './word-counter';
import { CalendarView, VIEW_TYPE_CALENDAR } from './calendar-view';
import { WordCountSettingTab } from './settings-tab';
import { FocusTimeTracker, formatFocusDuration } from './focus-time';

type FrontmatterRecord = Record<string, unknown>;

type LegacyColorSettings = Partial<WordCountSettings> & {
    emptyCellColor?: unknown;
};

interface PendingWordUpdate {
    increment: number;
    sourceFiles: Map<string, TFile>;
}

const WORD_COUNT_FLUSH_INTERVAL_MS = 2_000;
const MANAGED_MODIFY_IGNORE_MS = 250;

/**
 * 表示当前文件不适合被后台属性同步改写。
 * 调用方应保留本次更新，待下一次安全时机重试。
 */
class UnsafeFileWriteError extends Error {
    constructor(path: string, reason: string) {
        super(`跳过不安全的 Markdown 写入：${path}（${reason}）`);
        this.name = 'UnsafeFileWriteError';
    }
}

/**
 * 字数统计日历插件主类
 */
export default class WordCountCalendarPlugin extends Plugin {
    settings: WordCountSettings;
    wordCounter: WordCounter;
    focusTracker: FocusTimeTracker;
    statusBarItem: HTMLElement;
    todayWordCount: number = 0;

    /**
     * 码字速度计算器
     */
    private wphCalculator = new WPHCalculator();
    private wpmTimer: number | null = null;
    private settingsSaveTimer: number | null = null;
    private wordCountFlushTimer: number | null = null;
    private pendingWordUpdates = new Map<string, PendingWordUpdate>();
    private frontmatterWriteQueues = new Map<string, Promise<void>>();
    private fileModifyQueues = new Map<string, Promise<void>>();
    private ignoredModifyUntil = new Map<string, number>();
    private recentLargeDeletions = new Map<string, { time: number; amount: number }>();
    private unloading = false;

    /**
     * 获取当前码字速度（字/时）
     */
    getCurrentWPH(): number {
        return this.wphCalculator.getWPH();
    }

    async onload() {
        // 加载设置
        await this.loadSettings();

        // 初始化字数统计器
        this.wordCounter = new WordCounter(this.app, this.settings);

        // 初始化专注时长统计。专注数据使用独立文件保存，避免与高频变化的字数缓存互相覆盖。
        this.focusTracker = new FocusTimeTracker(
            this,
            () => this.settings.focusTrackingEnabled,
            () => this.settings.focusStrictMode,
            () => this.settings.focusWriteProperties,
            () => this.updateStatusBar()
        );
        await this.focusTracker.start();

        // 注册日历视图
        this.registerView(
            VIEW_TYPE_CALENDAR,
            (leaf) => new CalendarView(leaf, this)
        );

        // 添加ribbon图标
        this.addRibbonIcon('calendar', '字数统计日历', () => {
            void this.activateView();
        });

        this.addRibbonIcon('timer', '专注时长统计', () => {
            void this.activateFocusView();
        });

        // 添加命令
        this.addCommand({
            id: 'open-calendar',
            name: '打开字数统计日历',
            callback: () => {
                void this.activateView();
            }
        });

        this.addCommand({
            id: 'open-focus-time-statistics',
            name: '打开专注时长统计',
            callback: () => {
                void this.activateFocusView();
            }
        });

        this.addCommand({
            id: 'rebuild-focus-properties',
            name: '从专注账本重建笔记属性',
            callback: () => {
                void this.focusTracker.rebuildProperties();
            }
        });

        // Add "设置专注时长" to the file context menu (editor "more-options" button,
        // file explorer right-click). Lets the user fix a file whose focus duration was
        // inflated by inherited history.
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (!(file instanceof TFile) || file.extension !== 'md') return;
                menu.addItem(item => {
                    item.setTitle('设置专注时长')
                        .setIcon('timer')
                        .onClick(() => void this.openFocusDurationModal(file));
                });
            })
        );

        // 监听文件修改
        this.registerEvent(
            this.app.vault.on('modify', file => {
                if (file instanceof TFile && file.extension === 'md') {
                    if (this.shouldIgnoreManagedModify(file.path)) return;
                    void this.queueFileModified(file);
                }
            })
        );

        // 监听文件创建
        this.registerEvent(
            this.app.vault.on('create', file => {
                if (file instanceof TFile && file.extension === 'md') {
                    void this.onFileCreated(file);
                }
            })
        );

        // 监听元数据缓存变化（frontmatter更新时刷新界面）
        this.registerEvent(
            this.app.metadataCache.on('changed', file => {
                // 如果是今天的日记文件，刷新状态栏和日历
                const today = this.getDateString(new Date());
                if (file instanceof TFile && file.basename === today) {
                    void this.updateTodayWordCount();
                    this.refreshCalendarView();
                }
            })
        );

        // 添加设置页面
        this.addSettingTab(new WordCountSettingTab(this.app, this));

        // 添加状态栏
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('今日码字: 加载中...'); // 显示占位文本

        // 延迟加载，等 Obsidian 完全启动后再执行
        window.setTimeout(() => {
            void this.updateTodayWordCount();
        }, 1000); // 延迟 1 秒

        // 启动定时器，每2秒刷新一次状态栏（用于速度衰减）
        this.registerInterval(
            window.setInterval(() => {
                const wph = this.wphCalculator.getWPH();
                if (wph > 0 || this.statusBarItem.getText().includes('🚀')) {
                    this.updateStatusBar();
                }
            }, 2000)
        );
    }

    onunload() {
        this.unloading = true;
        if (this.wordCountFlushTimer !== null) {
            window.clearTimeout(this.wordCountFlushTimer);
            this.wordCountFlushTimer = null;
        }
        // Obsidian 不会等待插件的异步 onunload。退出阶段不再发起任何文件写入，
        // 宁可舍弃最后几秒尚未落盘的统计，也不能让进程在写入中途退出。
        this.pendingWordUpdates.clear();
        if (this.settingsSaveTimer !== null) {
            window.clearTimeout(this.settingsSaveTimer);
            this.settingsSaveTimer = null;
        }
        this.focusTracker?.prepareForUnload();
    }

    /**
     * 获取日期字符串 YYYY-MM-DD
     */
    getDateString(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * 获取模板文件，自动处理 .md 扩展名
     * @param templatePath 用户配置的模板路径
     * @returns 模板文件对象，如果找不到则返回 null
     */
    private getTemplateFile(templatePath: string): TFile | null {
        if (!templatePath) return null;

        // 1. 首先尝试直接使用用户提供的路径
        let templateFile = this.app.vault.getAbstractFileByPath(templatePath);
        if (templateFile instanceof TFile) {
            return templateFile;
        }

        // 2. 如果路径不以 .md 结尾，尝试添加 .md 扩展名
        if (!templatePath.endsWith('.md')) {
            const pathWithExtension = `${templatePath}.md`;
            templateFile = this.app.vault.getAbstractFileByPath(pathWithExtension);
            if (templateFile instanceof TFile) {
                return templateFile;
            }
        }

        // 3. 都失败了，返回 null
        return null;
    }

    /**
     * 查找日记文件
     */
    async findDailyNote(dateStr: string): Promise<TFile | null> {
        // 先检查缓存
        if (this.settings.dailyNotePaths[dateStr]) {
            const cachedFile = this.app.vault.getAbstractFileByPath(this.settings.dailyNotePaths[dateStr]);
            if (cachedFile instanceof TFile) {
                return cachedFile;
            }
            // 缓存失效，清除
            delete this.settings.dailyNotePaths[dateStr];
        }

        const folder = this.settings.dailyNotesFolder || '';
        
        // 优先使用 dailyNotesFolder 设置
        if (folder) {
            const expectedPath = `${folder}/${dateStr}.md`;
            const directFile = this.app.vault.getAbstractFileByPath(expectedPath);
            if (directFile instanceof TFile) {
                this.settings.dailyNotePaths[dateStr] = directFile.path;
                this.saveSettings();
                return directFile;
            }
        }

        // 如果 dailyNotesFolder 为空，在 includeFolders 中查找
        if (this.settings.includeFolders.length > 0) {
            for (const includeFolder of this.settings.includeFolders) {
                const expectedPath = `${includeFolder}/${dateStr}.md`;
                const directFile = this.app.vault.getAbstractFileByPath(expectedPath);
                if (directFile instanceof TFile) {
                    this.settings.dailyNotePaths[dateStr] = directFile.path;
                    this.saveSettings();
                    return directFile;
                }
            }
        }

        // 只有找不到时才遍历所有文件（作为后备方案）
        const files = this.app.vault.getMarkdownFiles();
        const found = files.find(f => f.basename === dateStr);
        if (found) {
            // 缓存找到的路径
            this.settings.dailyNotePaths[dateStr] = found.path;
            this.saveSettings();
        }
        return found || null;
    }

    /**
     * 创建日记文件
     */
    async createDailyNote(dateStr: string): Promise<TFile | null> {
        const folder = this.settings.dailyNotesFolder || '';

        // 确保文件夹存在
        if (folder) {
            const folderExists = this.app.vault.getAbstractFileByPath(folder);
            if (!folderExists) {
                try {
                    await this.app.vault.createFolder(folder);
                } catch (e) {
                    console.error('创建文件夹失败:', e);
                }
            }
        }

        const path = folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;

        try {
            const content = await this.getDailyNoteTemplateContent(dateStr);
            const file = await this.app.vault.create(path, content);
            return file;
        } catch (e) {
            console.error('创建日记失败:', e);
            new Notice(`创建日记失败: ${e.message}`);
            return null;
        }
    }

    /**
     * 获取或创建日记
     */
    async getOrCreateDailyNote(dateStr: string): Promise<TFile | null> {
        let dailyNote = await this.findDailyNote(dateStr);
        if (!dailyNote) {
            dailyNote = await this.createDailyNote(dateStr);
        }
        return dailyNote;
    }

    /**
     * 向日记增加字数
     */
    async addWordCountToDailyNote(dateStr: string, increment: number, sourceFile?: TFile): Promise<void> {
        await this.applyWordCountToDailyNote(
            dateStr,
            increment,
            sourceFile ? [sourceFile] : []
        );
    }

    /**
     * 安全、串行地更新 Markdown 属性。
     * 若属性更新意外清空了原本存在的正文，则自动把写入前正文拼回去。
     */
    async processFrontMatterSafely(
        file: TFile,
        mutate: (frontmatter: FrontmatterRecord) => void,
        protectBody = true
    ): Promise<void> {
        if (this.unloading) return;
        const previous = this.frontmatterWriteQueues.get(file.path) ?? Promise.resolve();
        const current = previous
            .catch(error => {
                console.error(`等待属性写入队列失败: ${file.path}`, error);
            })
            .then(async () => {
                if (this.unloading) return;
                // 当前活动编辑器拥有尚未落盘的内存内容。此时调用
                // processFrontMatter/vault.modify 可能用旧 Vault 快照覆盖用户刚输入的文字。
                // 直接放弃本次写入，由调用方保留并重试，绝不拿旧快照覆盖编辑器。
                if (this.isFileBeingEdited(file)) {
                    throw new UnsafeFileWriteError(file.path, '文件正在活动编辑器中编辑');
                }

                const originalBefore = await this.app.vault.read(file);
                if (this.unloading) return;
                if (this.isFileBeingEdited(file)) {
                    throw new UnsafeFileWriteError(file.path, '读取后文件进入活动编辑器');
                }

                const repair = await this.repairResetDailyNote(file, originalBefore);
                if (this.unloading) return;
                const before = repair.content;
                const beforeParts = this.splitFrontmatter(before);

                // 再读一次做乐观并发校验，防止读取快照后被 Obsidian、同步工具或其他插件修改。
                // processFrontMatter 会重写整个文件，不能接受任何旧快照写回。
                const latestBefore = await this.app.vault.read(file);
                if (this.unloading) return;
                if (latestBefore !== before) {
                    throw new UnsafeFileWriteError(file.path, '文件在写入前已发生变化');
                }
                if (this.isFileBeingEdited(file)) {
                    throw new UnsafeFileWriteError(file.path, '写入前文件正在活动编辑器中编辑');
                }
                if (this.unloading) return;

                this.markManagedModify(file.path);
                await this.app.fileManager.processFrontMatter(file, frontmatter => {
                    // 只能修改 processFrontMatter 回调提供的当前 frontmatter。
                    // 禁止把此前 vault.read 得到的旧属性或旧正文拼回文件。
                    mutate(frontmatter as FrontmatterRecord);
                });

                // 不再自动调用 vault.modify 恢复正文。即使正文异常变化，
                // 也不能用旧快照覆盖用户内容；记录并让用户从 Obsidian 历史恢复。
                if (!protectBody || this.unloading) return;
                const after = await this.app.vault.read(file);
                const afterParts = this.splitFrontmatter(after);
                if (afterParts.body !== beforeParts.body) {
                    console.error(`属性写入后正文发生变化，未执行自动恢复: ${file.path}`);
                    new Notice(`检测到正文变化，请检查：${file.basename}`);
                }
            });

        this.frontmatterWriteQueues.set(file.path, current);
        try {
            await current;
        } finally {
            if (this.frontmatterWriteQueues.get(file.path) === current) {
                this.frontmatterWriteQueues.delete(file.path);
            }
        }
    }

    private async applyWordCountToDailyNote(
        dateStr: string,
        increment: number,
        sourceFiles: TFile[]
    ): Promise<void> {
        const dailyNote = await this.getOrCreateDailyNote(dateStr);
        if (!dailyNote) {
            return;
        }

        await this.processFrontMatterSafely(dailyNote, frontmatter => {
            const rawCurrent = frontmatter['码字数'];
            const current = typeof rawCurrent === 'number' ? rawCurrent : 0;
            // 计入删除，但最小值为 0（不允许负数）
            frontmatter['码字数'] = Math.max(0, current + increment);

            let related = this.normalizeRelatedLinks(frontmatter['related']);
            sourceFiles.forEach(sourceFile => {
                const link = `[[${sourceFile.basename}]]`;
                if (!related.includes(link)) {
                    related.push(link);
                }
            });
            if (sourceFiles.length > 0) {
                frontmatter['related'] = related;
            }
        });
    }

    private enqueueWordCountUpdate(dateStr: string, increment: number, sourceFile: TFile): void {
        if (this.unloading) return;
        const pending = this.pendingWordUpdates.get(dateStr) ?? {
            increment: 0,
            sourceFiles: new Map<string, TFile>()
        };
        pending.increment += increment;
        pending.sourceFiles.set(sourceFile.path, sourceFile);
        this.pendingWordUpdates.set(dateStr, pending);

        if (this.wordCountFlushTimer === null) {
            this.wordCountFlushTimer = window.setTimeout(() => {
                this.wordCountFlushTimer = null;
                void this.flushPendingWordCountUpdates();
            }, WORD_COUNT_FLUSH_INTERVAL_MS);
        }
    }

    private scheduleWordCountFlushRetry(): void {
        if (this.unloading || this.wordCountFlushTimer !== null) return;
        this.wordCountFlushTimer = window.setTimeout(() => {
            this.wordCountFlushTimer = null;
            void this.flushPendingWordCountUpdates();
        }, WORD_COUNT_FLUSH_INTERVAL_MS);
    }

    private async flushPendingWordCountUpdates(): Promise<void> {
        if (this.unloading) {
            this.pendingWordUpdates.clear();
            return;
        }
        if (this.pendingWordUpdates.size === 0) return;

        const updates = Array.from(this.pendingWordUpdates.entries());
        this.pendingWordUpdates.clear();

        for (const [dateStr, update] of updates) {
            if (update.increment === 0 && update.sourceFiles.size === 0) continue;
            try {
                await this.applyWordCountToDailyNote(
                    dateStr,
                    update.increment,
                    Array.from(update.sourceFiles.values())
                );
            } catch (error) {
                const retry = this.pendingWordUpdates.get(dateStr) ?? {
                    increment: 0,
                    sourceFiles: new Map<string, TFile>()
                };
                retry.increment += update.increment;
                update.sourceFiles.forEach((file, path) => retry.sourceFiles.set(path, file));
                this.pendingWordUpdates.set(dateStr, retry);
                this.scheduleWordCountFlushRetry();
                console.error(`批量写入日记字数失败，将在下次重试: ${dateStr}`, error);
            }
        }

        await this.updateTodayWordCount();
        this.refreshCalendarView();
    }

    private getDefaultDailyNoteContent(dateStr: string): string {
        return `---\n码字数: 0\nrelated: []\n---\n# ${dateStr}\n\n`;
    }

    private async getDailyNoteTemplateContent(dateStr: string): Promise<string> {
        if (!this.settings.dailyNoteTemplate) {
            return this.getDefaultDailyNoteContent(dateStr);
        }

        const templateFile = this.getTemplateFile(this.settings.dailyNoteTemplate);
        if (!templateFile) {
            console.warn(`模板文件不存在: ${this.settings.dailyNoteTemplate}，使用默认模板`);
            return this.getDefaultDailyNoteContent(dateStr);
        }

        const content = await this.app.vault.read(templateFile);
        if (!content.trim()) {
            console.warn(`模板文件为空: ${this.settings.dailyNoteTemplate}，使用默认模板`);
            return this.getDefaultDailyNoteContent(dateStr);
        }
        return content.replace(/\{\{date\}\}/g, dateStr);
    }

    private async repairResetDailyNote(
        file: TFile,
        currentContent: string
    ): Promise<{ content: string; preservedProperties: FrontmatterRecord }> {
        // Disabled: auto-repair is too aggressive and can destroy user content.
        // The original logic would overwrite any daily note that had only plugin-managed
        // properties, even if the note body was intentionally left blank by the user.
        // This caused data loss when legitimate content was accidentally cleared.
        return { content: currentContent, preservedProperties: {} };
    }

    private getDailyNoteDate(file: TFile): string | null {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) return null;

        const configuredPath = this.settings.dailyNotePaths[file.basename];
        if (configuredPath === file.path) return file.basename;

        const folder = this.settings.dailyNotesFolder || '';
        const expectedPath = folder
            ? `${folder}/${file.basename}.md`
            : `${file.basename}.md`;
        return file.path === expectedPath ? file.basename : null;
    }

    private parseFrontmatterProperties(content: string): FrontmatterRecord {
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
        if (!match) return {};
        try {
            const parsed: unknown = parseYaml(match[1]);
            return isRecord(parsed) ? parsed : {};
        } catch (error) {
            console.warn('无法解析疑似被重置日记的属性，跳过自动模板恢复:', error);
            return {};
        }
    }

    private normalizeRelatedLinks(value: unknown): string[] {
        if (Array.isArray(value)) {
            return value.filter((item): item is string => typeof item === 'string');
        }
        return typeof value === 'string' ? [value] : [];
    }

    private splitFrontmatter(content: string): { frontmatter: string; body: string } {
        const match = /^---(?:\r?\n|$)[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
        if (!match) return { frontmatter: '', body: content };
        return {
            frontmatter: match[0],
            body: content.slice(match[0].length)
        };
    }

    /**
     * 判断目标文件是否正由当前 Markdown 编辑器持有。
     * 只要是活动编辑器中的文件，就禁止后台整文件写回。
     */
    private isFileBeingEdited(file: TFile): boolean {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const activeEditor = this.app.workspace.activeEditor;
        return Boolean(
            view?.file?.path === file.path &&
            view.getMode() === 'source' &&
            activeEditor?.file?.path === file.path &&
            activeEditor.editor
        );
    }

    private markManagedModify(path: string): void {
        this.ignoredModifyUntil.set(path, Date.now() + MANAGED_MODIFY_IGNORE_MS);
    }

    private shouldIgnoreManagedModify(path: string): boolean {
        const ignoreUntil = this.ignoredModifyUntil.get(path) ?? 0;
        if (ignoreUntil <= Date.now()) {
            this.ignoredModifyUntil.delete(path);
            return false;
        }
        return true;
    }

    private async queueFileModified(file: TFile): Promise<void> {
        const previous = this.fileModifyQueues.get(file.path) ?? Promise.resolve();
        const current = previous
            .catch(error => {
                console.error(`等待字数统计队列失败: ${file.path}`, error);
            })
            .then(() => this.onFileModified(file))
            .catch(error => {
                console.error(`统计文件字数失败: ${file.path}`, error);
            });

        this.fileModifyQueues.set(file.path, current);
        try {
            await current;
        } finally {
            if (this.fileModifyQueues.get(file.path) === current) {
                this.fileModifyQueues.delete(file.path);
            }
        }
    }

    /**
     * 更新状态栏显示
     */
    updateStatusBar() {
        if (!this.statusBarItem) return;

        const wph = this.wphCalculator.getWPH();
        let text = `今日码字: ${this.todayWordCount}`;

        if (wph > 0) {
            text += ` | 🚀 ${wph} 字/时`;
        }

        if (this.focusTracker && this.settings.focusTrackingEnabled) {
            text += ` | ⏱ ${formatFocusDuration(this.focusTracker.getTodayDuration())}`;
        }

        this.statusBarItem.setText(text);
    }

    /**
     * 更新今日字数显示（同时更新状态栏）
     */
    async updateTodayWordCount(): Promise<void> {
        const today = this.getDateString(new Date());
        const dailyNote = await this.findDailyNote(today);

        if (dailyNote) {
            const cache = this.app.metadataCache.getFileCache(dailyNote);
            const wordCount: unknown = cache?.frontmatter?.['码字数'];
            this.todayWordCount = typeof wordCount === 'number' ? wordCount : 0;
        } else {
            this.todayWordCount = 0;
        }

        this.updateStatusBar();
    }

    /**
     * 激活日历视图
     */
    async activateView() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];

        if (!leaf) {
            // 在右侧边栏创建视图
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({
                    type: VIEW_TYPE_CALENDAR,
                    active: true,
                });
                leaf = rightLeaf;
            }
        }

        if (leaf) {
            void workspace.revealLeaf(leaf);
        }
    }

    /**
     * 打开同一侧边栏视图中的专注统计标签页
     */
    async activateFocusView(): Promise<void> {
        await this.activateView();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
        if (leaf?.view instanceof CalendarView) {
            leaf.view.showFocusTab();
        }
    }

    /**
     * 手动设置某篇笔记的累计专注时长。清除该文件继承来的历史事件，重置为用户输入的值。
     */
    private async openFocusDurationModal(file: TFile): Promise<void> {
        const currentMs = this.focusTracker.getFileDuration(file);
        const minutes = await new FocusDurationInputModal(
            this.app,
            file.basename,
            currentMs
        ).waitForInput();
        if (minutes === null) return;

        const targetMs = Math.round(minutes * 60_000);
        await this.focusTracker.setFocusDuration(file, targetMs);
        new Notice(`「${file.basename}」专注时长已设为 ${formatFocusDuration(targetMs)}`);
    }

    /**
     * 文件修改时的处理 - 增量统计
     */
    private async onFileModified(file: TFile) {
        if (this.unloading) return;
        if (this.shouldIgnoreManagedModify(file.path)) {
            return;
        }
        if (file.path.startsWith('components/view/relationship-dashboard/')) {
            return;
        }
        if (!this.wordCounter.shouldCountFile(file)) {
            return;
        }

        const today = this.getDateString(new Date());
        const currentCount = await this.wordCounter.countWords(file);
        const hasCachedCount = Object.prototype.hasOwnProperty.call(
            this.settings.wordCountCache,
            file.path
        );
        const cache = this.wordCounter.getCachedWordCount(file, this.settings);

        // 🔑 核心逻辑：首次检测到文件时，只记录基线
        if (!hasCachedCount) {
            this.wordCounter.updateCache(file, currentCount, today, this.settings);
            void this.saveSettings();
            return;
        }

        // 计算增量
        const increment = currentCount - cache.lastCount;

        const PASTE_THRESHOLD = 100;
        const DELETION_WINDOW_MS = 60_000; // 60-second window after large deletion

        // Check if there was a recent large deletion
        const recentDeletion = this.recentLargeDeletions.get(file.path);
        const now = Date.now();
        const hasRecentDeletion = recentDeletion && (now - recentDeletion.time < DELETION_WINDOW_MS);

        // Record large deletions
        if (increment < -PASTE_THRESHOLD) {
            this.recentLargeDeletions.set(file.path, { time: now, amount: -increment });
        }

        // Determine if this is a paste that should be ignored
        // Allow paste if it follows a recent large deletion (likely delete + paste workflow)
        const isPaste = increment > PASTE_THRESHOLD && !hasRecentDeletion;

        // Clear deletion record after use
        if (hasRecentDeletion && increment > 0) {
            this.recentLargeDeletions.delete(file.path);
        }

        // 速度统计（只统计正增长，且非粘贴）
        if (increment > 0 && !isPaste) {
            this.wphCalculator.add(increment);
            // 立即更新状态栏，让他跳动起来
            this.updateStatusBar();
        }

        // 更新缓存（always update baseline, even for pastes）
        this.wordCounter.updateCache(file, currentCount, today, this.settings);
        void this.saveSettings();

        // 批量写入日记（粘贴产生的增量不计入，只记录手工输入/删除）
        if (increment !== 0 && !isPaste) {
            this.enqueueWordCountUpdate(today, increment, file);
            this.todayWordCount = Math.max(0, this.todayWordCount + increment);
            this.updateStatusBar();
        }

        this.refreshCalendarView();
    }

    /**
     * 文件创建时的处理
     */
    private async onFileCreated(file: TFile) {
        if (file.path.startsWith('components/view/relationship-dashboard/')) {
            return;
        }
        if (!this.wordCounter.shouldCountFile(file)) {
            return;
        }

        const today = this.getDateString(new Date());
        this.wordCounter.updateCache(file, 0, today, this.settings);
        void this.saveSettings();
    }

    /**
     * 刷新日历视图
     */
    refreshCalendarView() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
        leaves.forEach(leaf => {
            if (leaf.view instanceof CalendarView) {
                leaf.view.refresh();
            }
        });
    }

    /**
     * 加载设置
     */
    async loadSettings() {
        const loadedSettings: unknown = await this.loadData();
        const settingsPatch = isRecord(loadedSettings) ? loadedSettings : {};

        // 合并设置，确保新字段有默认值
        this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsPatch);
        
        // 数据迁移：兼容旧版本设置
        this.migrateSettings();
        
        // 清理 7 天前的缓存数据
        this.cleanOldCache();
    }

    /**
     * 数据迁移：确保旧版本设置能够正常工作
     */
    private migrateSettings() {
        // 兼容旧版本：如果 emptyCellColor 是字符串，转换为 ColorWithOpacity
        const legacySettings = this.settings as LegacyColorSettings;
        if (typeof legacySettings.emptyCellColor === 'string') {
            this.settings.emptyCellColor = { color: legacySettings.emptyCellColor, opacity: 100 };
        }
        
        // 确保所有颜色字段都存在
        if (!this.settings.level1Color) {
            this.settings.level1Color = DEFAULT_SETTINGS.level1Color;
        }
        if (!this.settings.level2Color) {
            this.settings.level2Color = DEFAULT_SETTINGS.level2Color;
        }
        if (!this.settings.level3Color) {
            this.settings.level3Color = DEFAULT_SETTINGS.level3Color;
        }
        if (!this.settings.level4Color) {
            this.settings.level4Color = DEFAULT_SETTINGS.level4Color;
        }
        
        // 确保格子大小字段存在
        if (typeof this.settings.cellSize === 'undefined') {
            this.settings.cellSize = DEFAULT_SETTINGS.cellSize;
        }

        // 确保日记模板字段存在
        if (typeof this.settings.dailyNoteTemplate === 'undefined') {
            this.settings.dailyNoteTemplate = DEFAULT_SETTINGS.dailyNoteTemplate;
        }

        if (typeof this.settings.focusTrackingEnabled === 'undefined') {
            this.settings.focusTrackingEnabled = DEFAULT_SETTINGS.focusTrackingEnabled;
        }
        if (typeof this.settings.focusStrictMode === 'undefined') {
            this.settings.focusStrictMode = DEFAULT_SETTINGS.focusStrictMode;
        }
        if (typeof this.settings.focusWriteProperties === 'undefined') {
            this.settings.focusWriteProperties = DEFAULT_SETTINGS.focusWriteProperties;
        }
    }

    /**
     * 清理过期缓存数据
     */
    private cleanOldCache() {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = this.getDateString(sevenDaysAgo);
        
        let cleanedCount = 0;
        for (const filePath in this.settings.wordCountCache) {
            const cache = this.settings.wordCountCache[filePath];
            
            // 清理条件：
            // 1. 超过 7 天未更新
            // 2. 或者 lastCount 为 0（只是记录了基线，没有实际统计）
            if (cache.lastUpdateDate < sevenDaysAgoStr || cache.lastCount === 0) {
                delete this.settings.wordCountCache[filePath];
                cleanedCount++;
            }
        }
        
        // 清理日记路径缓存（只保留最近 7 天的）
        for (const dateStr in this.settings.dailyNotePaths) {
            if (dateStr < sevenDaysAgoStr) {
                delete this.settings.dailyNotePaths[dateStr];
            }
        }
        
        if (cleanedCount > 0) {
            this.saveSettings();
        }
    }

    /**
     * 保存设置（延迟保存，避免频繁写入）
     */
    saveSettings(): void {
        if (this.unloading) return;
        // 清除之前的定时器
        if (this.settingsSaveTimer !== null) {
            window.clearTimeout(this.settingsSaveTimer);
        }
        
        // 延迟 1 秒保存
        this.settingsSaveTimer = window.setTimeout(() => {
            void this.saveData(this.settings).finally(() => {
                this.settingsSaveTimer = null;
            });
        }, 1000);
    }
}

/**
 * 手动输入专注时长（分钟）的弹窗。确认返回分钟数，取消/关闭返回 null。
 */
class FocusDurationInputModal extends Modal {
    private settled = false;
    private resolveFn: ((minutes: number | null) => void) | null = null;

    constructor(
        app: App,
        private readonly displayName: string,
        private readonly currentMs: number
    ) {
        super(app);
    }

    waitForInput(): Promise<number | null> {
        return new Promise(resolve => {
            this.resolveFn = resolve;
            this.open();
        });
    }

    private settle(value: number | null): void {
        if (this.settled) return;
        this.settled = true;
        this.resolveFn?.(value);
        this.close();
    }

    onOpen(): void {
        this.titleEl.setText('设置专注时长');
        const currentMinutes = Math.round(this.currentMs / 60_000);

        const setting = new Setting(this.contentEl)
            .setName(`「${this.displayName}」专注时长（分钟）`)
            .setDesc(
                `当前：${formatFocusDuration(this.currentMs)}（约 ${currentMinutes} 分钟）。输入 0 即清除全部专注记录。`
            );
        const input = setting.controlEl.createEl('input', {
            type: 'number',
            cls: 'word-count-calendar-focus-duration-input'
        });
        input.value = String(currentMinutes);
        input.min = '0';
        input.step = '1';

        const confirmBtn = this.contentEl.createEl('button', {
            text: '确认',
            cls: 'mod-cta word-count-calendar-modal-primary-button'
        });
        confirmBtn.addEventListener('click', () => {
            const minutes = Number(input.value);
            if (!Number.isFinite(minutes) || minutes < 0) {
                new Notice('请输入有效的非负数字');
                return;
            }
            this.settle(minutes);
        });

        const cancelBtn = this.contentEl.createEl('button', {
            text: '取消',
            cls: 'word-count-calendar-modal-secondary-button'
        });
        cancelBtn.addEventListener('click', () => this.settle(null));

        input.focus();
        input.select();
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                confirmBtn.click();
            } else if (event.key === 'Escape') {
                this.settle(null);
            }
        });
    }

    onClose(): void {
        // Closing the modal counts as cancel.
        if (!this.settled) {
            this.settled = true;
            this.resolveFn?.(null);
        }
        this.contentEl.empty();
    }
}

/**
 * 码字速度计算辅助类
 * 使用 60 秒滑动窗口统计输入量，外推为每小时字数
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class WPHCalculator {
    private history: { time: number; count: number }[] = [];
    private readonly WINDOW_MS = 60 * 1000; // 60-second sliding window

    /**
     * 添加输入记录
     */
    add(count: number) {
        if (count <= 0) return;
        this.history.push({ time: Date.now(), count });
    }

    /**
     * 获取当前码字速度（字/时）
     */
    getWPH(): number {
        const now = Date.now();
        // 移除过期数据（滑出窗口）
        this.history = this.history.filter(item => now - item.time < this.WINDOW_MS);

        // 60 秒窗口内字数 × 60 = 字/时
        return this.history.reduce((sum, item) => sum + item.count, 0) * 60;
    }
}
