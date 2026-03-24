import { Plugin, TFile, Notice } from 'obsidian';
import { WordCountSettings, DEFAULT_SETTINGS } from './settings';
import { WordCounter } from './word-counter';
import { CalendarView, VIEW_TYPE_CALENDAR } from './calendar-view';
import { WordCountSettingTab } from './settings-tab';

/**
 * 字数统计日历插件主类
 */
export default class WordCountCalendarPlugin extends Plugin {
    settings: WordCountSettings;
    wordCounter: WordCounter;
    statusBarItem: HTMLElement;
    todayWordCount: number = 0;

    /**
     * WPM计算器
     */
    private wpmCalculator = new WPMCalculator();
    private wpmTimer: number | null = null;
    private settingsSaveTimer: number | null = null;

    async onload() {
        console.log('加载字数统计日历插件');

        // 加载设置
        await this.loadSettings();

        // 初始化字数统计器
        this.wordCounter = new WordCounter(this.app, this.settings);

        // 注册日历视图
        this.registerView(
            VIEW_TYPE_CALENDAR,
            (leaf) => new CalendarView(leaf, this)
        );

        // 添加ribbon图标
        this.addRibbonIcon('calendar', '字数统计日历', () => {
            this.activateView();
        });

        // 添加命令
        this.addCommand({
            id: 'open-word-count-calendar',
            name: '打开字数统计日历',
            callback: () => {
                this.activateView();
            }
        });

        // 监听文件修改
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    await this.onFileModified(file);
                }
            })
        );

        // 监听文件创建
        this.registerEvent(
            this.app.vault.on('create', async (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    await this.onFileCreated(file);
                }
            })
        );

        // 监听元数据缓存变化（frontmatter更新时刷新界面）
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                // 如果是今天的日记文件，刷新状态栏和日历
                const today = this.getDateString(new Date());
                if (file instanceof TFile && file.basename === today) {
                    this.updateTodayWordCount();
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
        setTimeout(() => {
            this.updateTodayWordCount();
        }, 1000); // 延迟 1 秒

        // 启动定时器，每2秒刷新一次状态栏（用于WPM衰减）
        this.registerInterval(
            window.setInterval(() => {
                const wpm = this.wpmCalculator.getWPM();
                if (wpm > 0 || this.statusBarItem.getText().includes('🚀')) {
                    this.updateStatusBar();
                }
            }, 2000)
        );
    }

    onunload() {
        console.log('卸载字数统计日历插件');
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
                console.log(`自动添加 .md 扩展名: ${templatePath} -> ${pathWithExtension}`);
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
                await this.saveSettings();
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
                    await this.saveSettings();
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
            await this.saveSettings();
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
            let content = '';

            // 如果设置了模板，则读取模板内容
            if (this.settings.dailyNoteTemplate) {
                const templateFile = this.getTemplateFile(this.settings.dailyNoteTemplate);
                if (templateFile) {
                    content = await this.app.vault.read(templateFile);
                    // 替换日期占位符
                    content = content.replace(/\{\{date\}\}/g, dateStr);
                } else {
                    // 模板文件不存在，使用默认内容
                    console.warn(`模板文件不存在: ${this.settings.dailyNoteTemplate}，使用默认模板`);
                    content = `---\n码字数: 0\n---\n# ${dateStr}\n\n`;
                }
            } else {
                // 使用默认模板
                content = `---\n码字数: 0\n---\n# ${dateStr}\n\n`;
            }

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
    async addWordCountToDailyNote(dateStr: string, increment: number): Promise<void> {
        const dailyNote = await this.getOrCreateDailyNote(dateStr);
        if (!dailyNote) {
            console.log(`无法创建日记: ${dateStr}`);
            return;
        }

        await this.app.fileManager.processFrontMatter(dailyNote, (frontmatter) => {
            const current = frontmatter['码字数'] || 0;
            frontmatter['码字数'] = current + increment;
        });
    }

    /**
     * 更新状态栏显示
     */
    updateStatusBar() {
        if (!this.statusBarItem) return;

        const wpm = this.wpmCalculator.getWPM();
        let text = `今日码字: ${this.todayWordCount}`;

        if (wpm > 0) {
            text += ` | 🚀 ${wpm} 字/分`;
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
            this.todayWordCount = cache?.frontmatter?.['码字数'] || 0;
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
            workspace.revealLeaf(leaf);
        }
    }

    /**
     * 文件修改时的处理 - 增量统计
     */
    private async onFileModified(file: TFile) {
        if (!this.wordCounter.shouldCountFile(file)) {
            return;
        }

        const today = this.getDateString(new Date());
        const currentCount = await this.wordCounter.countWords(file);
        const cache = this.wordCounter.getCachedWordCount(file, this.settings);

        // 🔑 核心逻辑：首次检测到文件时，只记录基线
        if (cache.lastCount === 0) {
            this.wordCounter.updateCache(file, currentCount, today, this.settings);
            await this.saveSettings();
            return;
        }

        // 计算增量
        let increment = currentCount - cache.lastCount;

        // WPM 统计（只统计正增长）
        if (increment > 0) {
            this.wpmCalculator.add(increment);
            // 立即更新状态栏，让他跳动起来
            this.updateStatusBar();
        }

        // 删除阈值逻辑
        if (increment < -100) {
            increment = 0;
        }

        // 更新缓存
        this.wordCounter.updateCache(file, currentCount, today, this.settings);
        await this.saveSettings();

        // 写入日记
        if (increment !== 0) {
            await this.addWordCountToDailyNote(today, increment);
            await this.updateTodayWordCount();
        }

        this.refreshCalendarView();
    }

    /**
     * 文件创建时的处理
     */
    private async onFileCreated(file: TFile) {
        if (!this.wordCounter.shouldCountFile(file)) {
            return;
        }

        const today = this.getDateString(new Date());
        this.wordCounter.updateCache(file, 0, today, this.settings);
        await this.saveSettings();
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
        const loadedSettings = await this.loadData();
        
        // 合并设置，确保新字段有默认值
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
        
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
        if (typeof (this.settings as any).emptyCellColor === 'string') {
            const oldColor = (this.settings as any).emptyCellColor;
            this.settings.emptyCellColor = { color: oldColor, opacity: 100 };
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
            console.log(`清理了 ${cleanedCount} 个过期缓存条目`);
            this.saveSettings();
        }
    }

    /**
     * 保存设置（延迟保存，避免频繁写入）
     */
    async saveSettings() {
        // 清除之前的定时器
        if (this.settingsSaveTimer !== null) {
            window.clearTimeout(this.settingsSaveTimer);
        }
        
        // 延迟 1 秒保存
        this.settingsSaveTimer = window.setTimeout(async () => {
            await this.saveData(this.settings);
            this.settingsSaveTimer = null;
        }, 1000);
    }
}

/**
 * WPM 计算辅助类
 * 使用滑动窗口算法计算最近60秒的输入速度
 */
class WPMCalculator {
    private history: { time: number; count: number }[] = [];
    private readonly WINDOW_MS = 60 * 1000; // 60秒窗口

    /**
     * 添加输入记录
     */
    add(count: number) {
        if (count <= 0) return;
        this.history.push({ time: Date.now(), count });
    }

    /**
     * 获取当前 WPM
     */
    getWPM(): number {
        const now = Date.now();
        // 移除过期数据（滑出窗口）
        this.history = this.history.filter(item => now - item.time < this.WINDOW_MS);

        // 计算窗口内总字数
        return this.history.reduce((sum, item) => sum + item.count, 0);
    }
}
