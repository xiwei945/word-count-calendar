import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { WordCountSettings } from './settings';
import { ColorGradient } from './color-gradient';
import WordCountCalendarPlugin from './main';

export const VIEW_TYPE_CALENDAR = 'word-count-calendar-view';

/**
 * 日历视图类
 */
export class CalendarView extends ItemView {
    private currentDate: Date;
    private plugin: WordCountCalendarPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: WordCountCalendarPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentDate = new Date();
    }

    getViewType(): string {
        return VIEW_TYPE_CALENDAR;
    }

    getDisplayText(): string {
        return '字数统计日历';
    }

    getIcon(): string {
        return 'calendar';
    }

    async onOpen() {
        await this.renderCalendar();
    }

    async onClose() {
        // 清理工作
    }

    /**
     * 渲染日历
     */
    async renderCalendar() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('word-count-calendar-container');

        // 设置格子大小 CSS 变量
        (container as HTMLElement).style.setProperty('--calendar-cell-size', `${this.plugin.settings.cellSize}px`);

        // 创建头部（月份导航）
        const header = container.createDiv({ cls: 'calendar-header' });

        const prevBtn = header.createEl('button', { text: '<', cls: 'calendar-nav-btn' });
        prevBtn.onclick = () => this.changeMonth(-1);

        const monthDisplay = header.createDiv({ cls: 'calendar-month-display' });
        monthDisplay.setText(this.getMonthYearText());

        const nextBtn = header.createEl('button', { text: '>', cls: 'calendar-nav-btn' });
        nextBtn.onclick = () => this.changeMonth(1);

        // 创建日历网格
        const calendarGrid = container.createDiv({ cls: 'calendar-grid' });
        await this.renderDays(calendarGrid);

        // 创建底部统计信息
        const footer = container.createDiv({ cls: 'calendar-footer' });
        const stats = await this.calculateMonthStats();
        // 使用 innerHTML 来支持 strong 标签
        footer.innerHTML = `本月已写 <strong>${stats.totalDays}</strong> 天，灵感如泉涌！<br>总字数：<strong>${stats.totalWords}</strong>`;
    }

    /**
     * 渲染日历中的每一天
     */
    private async renderDays(container: HTMLElement) {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();

        // 获取当月第一天和最后一天
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);

        // 获取第一天是星期几（0-6）
        const startWeekDay = firstDay.getDay();

        // 添加上个月的空白天数
        for (let i = 0; i < startWeekDay; i++) {
            container.createDiv({ cls: 'calendar-day empty' });
        }

        // 获取当月所有笔记的字数数据
        const wordCountData = await this.getMonthWordCountData(year, month);

        // 添加当月的每一天
        for (let day = 1; day <= lastDay.getDate(); day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const wordCount = wordCountData.get(dateStr) || 0;

            const dayEl = container.createDiv({ cls: 'calendar-day' });

            // 设置背景颜色
            const color = ColorGradient.getColor(
                wordCount,
                this.plugin.settings.dailyGoal,
                {
                    empty: this.plugin.settings.emptyCellColor,
                    level1: this.plugin.settings.level1Color,
                    level2: this.plugin.settings.level2Color,
                    level3: this.plugin.settings.level3Color,
                    level4: this.plugin.settings.level4Color
                }
            );
            dayEl.style.backgroundColor = color;

            // 添加日期数字
            const dayNum = dayEl.createDiv({ cls: 'calendar-day-number', text: String(day) });

            // 添加字数显示
            if (wordCount > 0) {
                const wordCountEl = dayEl.createDiv({ cls: 'calendar-day-count', text: String(wordCount) });
                // 添加Tooltip
                dayEl.setAttribute('title', `${dateStr}\n码字：${wordCount} 字`);
            } else {
                dayEl.setAttribute('title', `${dateStr}\n无码字数据`);
            }

            // 今天的日期高亮
            const today = new Date();
            if (year === today.getFullYear() &&
                month === today.getMonth() &&
                day === today.getDate()) {
                dayEl.addClass('today');
            }
        }
    }

    /**
     * 获取指定月份所有笔记的字数数据 - 从日记读取
     */
    private async getMonthWordCountData(year: number, month: number): Promise<Map<string, number>> {
        const data = new Map<string, number>();
        const lastDay = new Date(year, month + 1, 0).getDate();
        const folder = this.plugin.settings.dailyNotesFolder || '';

        // 查找每一天的日记
        for (let day = 1; day <= lastDay; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            let dailyNote: TFile | null = null;

            // 优先使用 dailyNotesFolder 设置
            if (folder) {
                const expectedPath = `${folder}/${dateStr}.md`;
                const file = this.app.vault.getAbstractFileByPath(expectedPath);
                if (file instanceof TFile) {
                    dailyNote = file;
                }
            }

            // 如果 dailyNotesFolder 为空，在 includeFolders 中查找
            if (!dailyNote && this.plugin.settings.includeFolders.length > 0) {
                for (const includeFolder of this.plugin.settings.includeFolders) {
                    const expectedPath = `${includeFolder}/${dateStr}.md`;
                    const file = this.app.vault.getAbstractFileByPath(expectedPath);
                    if (file instanceof TFile) {
                        dailyNote = file;
                        break;
                    }
                }
            }

            // 如果还是找不到，遍历所有文件（作为后备方案）
            if (!dailyNote) {
                const files = this.app.vault.getMarkdownFiles();
                dailyNote = files.find(f => f.basename === dateStr) || null;
            }

            if (dailyNote) {
                const cache = this.app.metadataCache.getFileCache(dailyNote);
                const wordCount = cache?.frontmatter?.['码字数'] || 0;
                data.set(dateStr, wordCount);
            }
        }

        return data;
    }

    /**
     * 计算当月统计信息
     */
    private async calculateMonthStats(): Promise<{ totalDays: number; totalWords: number }> {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        const data = await this.getMonthWordCountData(year, month);

        let totalWords = 0;
        let totalDays = 0;

        data.forEach((count) => {
            if (count > 0) {
                totalDays++;
                totalWords += count;
            }
        });

        return { totalDays, totalWords };
    }

    /**
     * 切换月份
     */
    private changeMonth(delta: number) {
        this.currentDate.setMonth(this.currentDate.getMonth() + delta);
        this.renderCalendar();
    }

    /**
     * 获取月份年份显示文本
     */
    private getMonthYearText(): string {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth() + 1;
        return `${year}年${month}月`;
    }

    /**
     * 刷新视图
     */
    async refresh() {
        await this.renderCalendar();
    }
}
