import { App, FuzzySuggestModal, ItemView, WorkspaceLeaf, TFile, Notice, Menu, setIcon } from 'obsidian';
import { WordCountSettings } from './settings';
import { ColorGradient } from './color-gradient';
import WordCountCalendarPlugin from './main';
import { FocusLeaderboardPeriod, FocusRecord, formatFocusDuration } from './focus-time';

class TargetFileSuggest extends FuzzySuggestModal<TFile> {
    constructor(app: App, private readonly onPick: (file: TFile) => void) {
        super(app);
        this.setPlaceholder('选择归属目标笔记');
    }

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles()
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.onPick(file);
    }
}

export const VIEW_TYPE_CALENDAR = 'word-count-calendar-view';

/**
 * 标签页类型枚举
 */
enum TabType {
    CALENDAR = 'calendar',
    TODAY = 'today',
    FOCUS = 'focus'
}

/**
 * 标签页标签文本
 */
const TAB_LABELS = {
    [TabType.CALENDAR]: '日历',
    [TabType.TODAY]: '今日详情',
    [TabType.FOCUS]: '专注'
} as const;

const TAB_ICONS: Record<TabType, string> = {
    [TabType.CALENDAR]: 'calendar',
    [TabType.TODAY]: 'activity',
    [TabType.FOCUS]: 'timer'
};

const FOCUS_PERIOD_OPTIONS: Array<{ value: FocusLeaderboardPeriod; label: string; title: string }> = [
    { value: 'week', label: '周', title: '本周' },
    { value: 'month', label: '月', title: '本月' },
    { value: 'quarter', label: '季', title: '本季度' },
    { value: 'year', label: '年', title: '本年' },
    { value: 'all', label: '总', title: '全部' }
];

interface DailyWordCountPoint {
    date: Date;
    dateStr: string;
    count: number;
}

/**
 * 日历视图类
 */
export class CalendarView extends ItemView {
    private currentDate: Date;
    private plugin: WordCountCalendarPlugin;
    private currentTab: TabType = TabType.CALENDAR;
    private previousTab: TabType | null = null;
    private tabTransitionStartOffset: string | null = null;
    private suppressTabClick = false;
    // DOM 元素引用（避免全局查找）
    private wordCountDisplay: HTMLElement | null = null;
    private wphDisplay: HTMLElement | null = null;
    private todayProgressRing: HTMLElement | null = null;
    private todayProgressPercent: HTMLElement | null = null;
    private todayStatusTitle: HTMLElement | null = null;
    private todayStatusDescription: HTMLElement | null = null;
    private todayRemainingDisplay: HTMLElement | null = null;
    private todayFocusDisplay: HTMLElement | null = null;
    private todaySpeedLine: SVGPathElement | null = null;
    private todaySpeedFlow: SVGPathElement | null = null;
    private todaySpeedArea: SVGPathElement | null = null;
    private todaySpeedDot: SVGCircleElement | null = null;
    private todaySpeedCurrentDisplay: HTMLElement | null = null;
    private todaySpeedPeakDisplay: HTMLElement | null = null;
    private wphHistory: number[] = [];
    private focusTodayDisplay: HTMLElement | null = null;
    private focusCurrentDisplay: HTMLElement | null = null;
    private focusTotalDisplay: HTMLElement | null = null;
    private focusLeaderboardPeriod: FocusLeaderboardPeriod = 'week';
    private detailUpdateTimer: number | null = null;
    private selectedCalendarDate: string | null = null;
    private monthTransitionDirection: 'next' | 'previous' = 'next';
    private selectedDateDisplay: HTMLElement | null = null;
    private selectedCountDisplay: HTMLElement | null = null;
    private selectedProgressDisplay: HTMLElement | null = null;
    private selectedProgressTrack: HTMLElement | null = null;
    private monthPickerEl: HTMLElement | null = null;
    private monthPickerTrigger: HTMLButtonElement | null = null;
    private monthPickerOutsideHandler: ((event: PointerEvent) => void) | null = null;
    private previousFocusPeriod: FocusLeaderboardPeriod | null = null;

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
        // 隐藏视图标题栏
        const header = this.containerEl.querySelector('.view-header');
        if (header) {
            (header as HTMLElement).style.display = 'none';
        }

        // 移除视图容器的边框和阴影
        const viewContent = this.containerEl.children[1] as HTMLElement;
        if (viewContent) {
            viewContent.style.boxShadow = 'none';
            viewContent.style.border = 'none';
        }

        this.render();
    }

    async onClose(): Promise<void> {
        this.stopLiveUpdates();
        this.resetViewReferences();
    }

    private resetViewReferences(): void {
        this.closeMonthPicker();
        this.wordCountDisplay = null;
        this.wphDisplay = null;
        this.todayProgressRing = null;
        this.todayProgressPercent = null;
        this.todayStatusTitle = null;
        this.todayStatusDescription = null;
        this.todayRemainingDisplay = null;
        this.todayFocusDisplay = null;
        this.todaySpeedLine = null;
        this.todaySpeedFlow = null;
        this.todaySpeedArea = null;
        this.todaySpeedDot = null;
        this.todaySpeedCurrentDisplay = null;
        this.todaySpeedPeakDisplay = null;
        this.focusTodayDisplay = null;
        this.focusCurrentDisplay = null;
        this.focusTotalDisplay = null;
        this.selectedDateDisplay = null;
        this.selectedCountDisplay = null;
        this.selectedProgressDisplay = null;
        this.selectedProgressTrack = null;
    }

    /**
     * 渲染视图（根据当前标签页）
     */
    render(): void {
        this.stopLiveUpdates();
        this.resetViewReferences();
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('word-count-calendar-container');

        // 设置格子大小 CSS 变量
        container.style.setProperty('--calendar-cell-size',
            `${this.plugin.settings.cellSize}px`);

        // 渲染标签导航
        this.renderTabNavigation(container);

        // 渲染内容区域
        const contentContainer = container.createDiv({ cls: 'tab-content-container' });

        switch (this.currentTab) {
            case TabType.CALENDAR:
                void this.renderCalendarContent(contentContainer);
                break;
            case TabType.TODAY:
                void this.renderTodayDetailContent(contentContainer);
                break;
            case TabType.FOCUS:
                this.renderFocusContent(contentContainer);
                break;
        }
    }

    /**
     * 渲染标签导航
     */
    private renderTabNavigation(container: HTMLElement): void {
        const tabNav = container.createDiv({
            cls: `tab-navigation active-${this.currentTab}`
        });
        const offsets: Record<TabType, string> = {
            [TabType.CALENDAR]: '0px',
            [TabType.TODAY]: 'calc(100% + 4px)',
            [TabType.FOCUS]: 'calc(200% + 8px)'
        };
        const transitionStart = this.tabTransitionStartOffset
            ?? (this.previousTab && this.previousTab !== this.currentTab
                ? offsets[this.previousTab]
                : null);
        if (transitionStart) {
            tabNav.addClass('is-switching');
            tabNav.style.setProperty('--tab-start-offset', transitionStart);
            tabNav.style.setProperty('--tab-end-offset', offsets[this.currentTab]);
        }

        // 使用统一的标签创建方法
        this.renderTabButton(tabNav, TabType.CALENDAR);
        this.renderTabButton(tabNav, TabType.TODAY);
        this.renderTabButton(tabNav, TabType.FOCUS);
        this.enableTabDrag(tabNav);
        this.previousTab = null;
        this.tabTransitionStartOffset = null;
    }

    /**
     * 创建单个标签按钮
     */
    private renderTabButton(container: HTMLElement, tabType: TabType): void {
        const button = container.createEl('button', {
            cls: 'tab-button',
            attr: {
                'aria-label': TAB_LABELS[tabType],
                'aria-pressed': String(this.currentTab === tabType),
                title: TAB_LABELS[tabType]
            }
        });
        setIcon(button, TAB_ICONS[tabType]);

        if (this.currentTab === tabType) {
            button.addClass('active');
        }

        button.onclick = () => {
            if (this.suppressTabClick) return;
            if (this.currentTab === tabType) return;
            this.previousTab = this.currentTab;
            this.currentTab = tabType;
            this.render();
        };
    }

    private enableTabDrag(tabNav: HTMLElement): void {
        const tabs = [TabType.CALENDAR, TabType.TODAY, TabType.FOCUS];
        let pointerId: number | null = null;
        let startX = 0;
        let startY = 0;
        let startIndex = tabs.indexOf(this.currentTab);
        let currentOffset = 0;
        let dragging = false;

        const getMetrics = () => {
            const tabWidth = Math.max((tabNav.clientWidth - 14) / 3, 1);
            const step = tabWidth + 4;
            return { step, maxOffset: step * 2 };
        };

        const finishDrag = (event: PointerEvent, cancelled: boolean) => {
            if (pointerId === null || event.pointerId !== pointerId) return;
            if (tabNav.hasPointerCapture(pointerId)) {
                tabNav.releasePointerCapture(pointerId);
            }
            tabNav.removeClass('is-dragging');

            if (dragging && !cancelled) {
                event.preventDefault();
                const { step } = getMetrics();
                const targetIndex = Math.max(0, Math.min(2, Math.round(currentOffset / step)));
                this.tabTransitionStartOffset = `${currentOffset}px`;
                this.currentTab = tabs[targetIndex];
                this.suppressTabClick = true;
                window.setTimeout(() => {
                    this.suppressTabClick = false;
                }, 0);
                this.render();
            } else {
                tabNav.style.removeProperty('--tab-drag-offset');
                if (cancelled) this.suppressTabClick = false;
            }

            pointerId = null;
            dragging = false;
        };

        tabNav.addEventListener('pointerdown', event => {
            if (!event.isPrimary || event.button !== 0) return;
            pointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            startIndex = tabs.indexOf(this.currentTab);
            currentOffset = startIndex * getMetrics().step;
            dragging = false;
        });

        tabNav.addEventListener('pointermove', event => {
            if (pointerId === null || event.pointerId !== pointerId) return;
            const deltaX = event.clientX - startX;
            const deltaY = event.clientY - startY;

            if (!dragging) {
                if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 6) {
                    pointerId = null;
                    return;
                }
                if (Math.abs(deltaX) < 5 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
                dragging = true;
                this.suppressTabClick = true;
                tabNav.addClass('is-dragging');
                tabNav.setPointerCapture(pointerId);
            }

            event.preventDefault();
            const { step, maxOffset } = getMetrics();
            currentOffset = Math.max(0, Math.min(maxOffset, startIndex * step + deltaX));
            tabNav.style.setProperty('--tab-drag-offset', `${currentOffset}px`);
        });

        tabNav.addEventListener('pointerup', event => finishDrag(event, false));
        tabNav.addEventListener('pointercancel', event => finishDrag(event, true));
    }

    /**
     * 渲染日历内容
     */
    private async renderCalendarContent(container: HTMLElement): Promise<void> {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        const wordCountData = this.getMonthWordCountData(year, month);
        const selectedDate = this.ensureSelectedDate(year, month, wordCountData);

        const header = container.createDiv({ cls: 'calendar-header' });
        const monthControl = header.createDiv({ cls: 'calendar-month-control' });

        const prevBtn = monthControl.createEl('button', {
            cls: 'calendar-nav-btn',
            attr: { 'aria-label': '上个月', title: '上个月' }
        });
        setIcon(prevBtn, 'chevron-left');
        prevBtn.onclick = () => this.changeMonth(-1);

        const monthDisplay = monthControl.createEl('button', {
            cls: 'calendar-month-display',
            text: this.getMonthYearText(),
            attr: {
                'aria-label': '快速切换月份',
                'aria-expanded': 'false',
                title: '点击快速切换月份'
            }
        });
        monthDisplay.onclick = event => {
            event.stopPropagation();
            this.toggleMonthPicker(header, monthDisplay);
        };

        const nextBtn = monthControl.createEl('button', {
            cls: 'calendar-nav-btn',
            attr: { 'aria-label': '下个月', title: '下个月' }
        });
        setIcon(nextBtn, 'chevron-right');
        nextBtn.onclick = () => this.changeMonth(1);

        const weekdays = container.createDiv({ cls: 'calendar-weekdays' });
        ['日', '一', '二', '三', '四', '五', '六'].forEach(label => {
            weekdays.createSpan({ cls: 'calendar-weekday', text: label });
        });

        const calendarStage = container.createDiv({
            cls: `calendar-stage month-${this.monthTransitionDirection}`
        });
        const calendarGrid = calendarStage.createDiv({ cls: 'calendar-grid' });

        calendarGrid.addEventListener('click', async (e) => {
            const dayEl = (e.target as HTMLElement).closest('.calendar-day:not(.empty)');
            if (dayEl instanceof HTMLElement) {
                const dateStr = dayEl.getAttribute('data-date');
                if (dateStr) {
                    const wordCount = Number(dayEl.getAttribute('data-count') || 0);
                    this.selectCalendarDate(calendarGrid, dayEl, dateStr, wordCount);
                    await this.openDailyNote(dateStr);
                }
            }
        });

        this.renderDays(calendarGrid, wordCountData, selectedDate);
        this.renderSelectedDateDetail(container, selectedDate, wordCountData.get(selectedDate) || 0);

        const stats = this.calculateMonthStats(wordCountData);
        const summary = container.createDiv({ cls: 'calendar-summary' });
        this.createCalendarSummaryCard(summary, '写作天数', stats.totalDays, '天');
        this.createCalendarSummaryCard(summary, '本月字数', stats.totalWords, '字');
        this.createCalendarSummaryCard(summary, '达标天数', stats.targetDays, '天');
    }

    private createCalendarSummaryCard(
        container: HTMLElement,
        label: string,
        value: number,
        unit: string
    ): void {
        const card = container.createDiv({ cls: 'calendar-summary-card' });
        card.createDiv({ cls: 'calendar-summary-label', text: label });
        const valueRow = card.createDiv({ cls: 'calendar-summary-value' });
        valueRow.createSpan({ text: value.toLocaleString('zh-CN') });
        valueRow.createSpan({ cls: 'calendar-summary-unit', text: unit });
    }

    /**
     * 渲染日历中的每一天
     */
    private renderDays(
        container: HTMLElement,
        wordCountData: Map<string, number>,
        selectedDate: string
    ): void {
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

        // 添加当月的每一天
        for (let day = 1; day <= lastDay.getDate(); day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const wordCount = wordCountData.get(dateStr) || 0;

            const dayEl = container.createDiv({ cls: 'calendar-day' });
            dayEl.setAttribute('data-date', dateStr);
            dayEl.setAttribute('data-count', String(wordCount));
            dayEl.setAttribute('role', 'button');
            dayEl.tabIndex = 0;
            dayEl.style.setProperty('--calendar-day-index', String(day + startWeekDay));
            dayEl.style.setProperty(
                '--calendar-progress',
                String(Math.min(wordCount / Math.max(this.plugin.settings.dailyGoal, 1), 1))
            );

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
            dayEl.style.setProperty('--calendar-day-color', color);

            const dayHeader = dayEl.createDiv({ cls: 'calendar-day-header' });
            dayHeader.createSpan({ cls: 'calendar-day-number', text: String(day) });

            if (wordCount > 0) {
                dayEl.addClass('has-words');
                dayEl.createDiv({
                    cls: 'calendar-day-count',
                    text: wordCount.toLocaleString('zh-CN')
                });
                if (wordCount >= this.plugin.settings.dailyGoal) {
                    dayEl.addClass('goal-reached');
                    dayHeader.createSpan({ cls: 'calendar-day-goal', text: '✓' });
                }
                dayEl.setAttribute('title', `${dateStr}\n码字：${wordCount.toLocaleString('zh-CN')} 字`);
            } else {
                dayEl.setAttribute('title', `${dateStr}\n无码字数据`);
            }

            const today = new Date();
            if (year === today.getFullYear() &&
                month === today.getMonth() &&
                day === today.getDate()) {
                dayEl.addClass('today');
                dayHeader.createSpan({ cls: 'calendar-today-mark', text: '今' });
            }

            if (dateStr === selectedDate) dayEl.addClass('selected');

            dayEl.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                this.selectCalendarDate(container, dayEl, dateStr, wordCount);
                void this.openDailyNote(dateStr);
            });
        }
    }

    private ensureSelectedDate(
        year: number,
        month: number,
        data: Map<string, number>
    ): string {
        const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
        if (this.selectedCalendarDate?.startsWith(monthPrefix)) {
            return this.selectedCalendarDate;
        }

        const today = new Date();
        if (year === today.getFullYear() && month === today.getMonth()) {
            this.selectedCalendarDate = this.getLocalDateString(today);
        } else {
            this.selectedCalendarDate = Array.from(data.entries())
                .find(([, count]) => count > 0)?.[0] ?? `${monthPrefix}01`;
        }
        return this.selectedCalendarDate;
    }

    private renderSelectedDateDetail(
        container: HTMLElement,
        dateStr: string,
        wordCount: number
    ): void {
        const detail = container.createDiv({ cls: 'calendar-selected-detail' });
        const primary = detail.createDiv({ cls: 'calendar-selected-primary' });
        this.selectedDateDisplay = primary.createSpan({
            cls: 'calendar-selected-date',
            text: this.formatCalendarDate(dateStr)
        });
        this.selectedCountDisplay = primary.createEl('strong', {
            cls: 'calendar-selected-count',
            text: wordCount.toLocaleString('zh-CN')
        });
        primary.createSpan({ cls: 'calendar-selected-unit', text: '字' });
        this.selectedProgressDisplay = detail.createSpan({ cls: 'calendar-selected-meta' });
        this.selectedProgressTrack = detail.createDiv({ cls: 'calendar-selected-progress' });
        this.selectedProgressTrack.createSpan();
        this.updateSelectedDateDetail(dateStr, wordCount);
    }

    private selectCalendarDate(
        grid: HTMLElement,
        dayEl: HTMLElement,
        dateStr: string,
        wordCount: number
    ): void {
        grid.querySelectorAll('.calendar-day.selected').forEach(element => {
            element.classList.remove('selected');
        });
        dayEl.addClass('selected');
        this.selectedCalendarDate = dateStr;
        this.updateSelectedDateDetail(dateStr, wordCount);
    }

    private updateSelectedDateDetail(dateStr: string, wordCount: number): void {
        const goal = Math.max(this.plugin.settings.dailyGoal, 1);
        const percentage = Math.round(wordCount / goal * 100);
        this.selectedDateDisplay?.setText(this.formatCalendarDate(dateStr));
        this.selectedCountDisplay?.setText(wordCount.toLocaleString('zh-CN'));
        this.selectedProgressDisplay?.setText(`目标 ${percentage}%`);
        this.selectedProgressTrack?.style.setProperty(
            '--calendar-selected-progress',
            `${Math.min(percentage, 100)}%`
        );
    }

    private formatCalendarDate(dateStr: string): string {
        const [, month, day] = dateStr.split('-');
        return `${Number(month)}月${Number(day)}日`;
    }

    private getLocalDateString(date: Date): string {
        return [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
        ].join('-');
    }

    /**
     * 获取指定月份所有笔记的字数数据 - 从日记读取
     */
    private getMonthWordCountData(year: number, month: number): Map<string, number> {
        const data = new Map<string, number>();
        const lastDay = new Date(year, month + 1, 0).getDate();

        for (let day = 1; day <= lastDay; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            data.set(dateStr, this.getWordCountForDate(dateStr));
        }

        return data;
    }

    private findDailyNoteFast(dateStr: string): TFile | null {
        const cachedPath = this.plugin.settings.dailyNotePaths[dateStr];
        if (cachedPath) {
            const cached = this.app.vault.getAbstractFileByPath(cachedPath);
            if (cached instanceof TFile) return cached;
        }

        const folders = [
            this.plugin.settings.dailyNotesFolder,
            ...this.plugin.settings.includeFolders
        ].filter((folder): folder is string => Boolean(folder));
        for (const folder of folders) {
            const file = this.app.vault.getAbstractFileByPath(`${folder}/${dateStr}.md`);
            if (file instanceof TFile) return file;
        }

        return this.app.vault.getMarkdownFiles().find(file => file.basename === dateStr) ?? null;
    }

    private getWordCountForDate(dateStr: string): number {
        const dailyNote = this.findDailyNoteFast(dateStr);
        if (!dailyNote) return 0;
        const cache = this.app.metadataCache.getFileCache(dailyNote);
        const value = Number(cache?.frontmatter?.['码字数'] || 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    /**
     * 计算当月统计信息
     */
    private calculateMonthStats(data: Map<string, number>): {
        totalDays: number;
        totalWords: number;
        targetDays: number;
    } {
        let totalWords = 0;
        let totalDays = 0;
        let targetDays = 0;

        data.forEach((count) => {
            if (count > 0) {
                totalDays++;
                totalWords += count;
            }
            if (count >= this.plugin.settings.dailyGoal) targetDays++;
        });

        return { totalDays, totalWords, targetDays };
    }

    /**
     * 切换月份
     */
    private changeMonth(delta: number): void {
        this.monthTransitionDirection = delta > 0 ? 'next' : 'previous';
        this.currentDate.setMonth(this.currentDate.getMonth() + delta);
        this.selectedCalendarDate = null;
        this.render();
    }

    private toggleMonthPicker(header: HTMLElement, trigger: HTMLButtonElement): void {
        if (this.monthPickerEl) {
            this.closeMonthPicker();
            return;
        }

        let pickerYear = this.currentDate.getFullYear();
        const picker = header.createDiv({ cls: 'calendar-month-picker' });
        picker.tabIndex = -1;
        this.monthPickerEl = picker;
        this.monthPickerTrigger = trigger;
        trigger.addClass('active');
        trigger.setAttribute('aria-expanded', 'true');

        const renderPicker = () => {
            picker.empty();
            const yearHeader = picker.createDiv({ cls: 'calendar-picker-year-header' });
            const previousYear = yearHeader.createEl('button', {
                cls: 'calendar-picker-year-button',
                attr: { 'aria-label': '上一年' }
            });
            setIcon(previousYear, 'chevron-left');
            yearHeader.createEl('strong', { text: `${pickerYear}年` });
            const nextYear = yearHeader.createEl('button', {
                cls: 'calendar-picker-year-button',
                attr: { 'aria-label': '下一年' }
            });
            setIcon(nextYear, 'chevron-right');
            previousYear.onclick = () => {
                pickerYear--;
                renderPicker();
            };
            nextYear.onclick = () => {
                pickerYear++;
                renderPicker();
            };

            const grid = picker.createDiv({ cls: 'calendar-picker-months' });
            for (let month = 0; month < 12; month++) {
                const monthButton = grid.createEl('button', {
                    cls: 'calendar-picker-month',
                    text: `${month + 1}月`,
                    attr: { 'aria-label': `切换到${pickerYear}年${month + 1}月` }
                });
                if (pickerYear === this.currentDate.getFullYear()
                    && month === this.currentDate.getMonth()) {
                    monthButton.addClass('active');
                }
                monthButton.onclick = () => {
                    const currentIndex = this.currentDate.getFullYear() * 12 + this.currentDate.getMonth();
                    const targetIndex = pickerYear * 12 + month;
                    this.monthTransitionDirection = targetIndex >= currentIndex ? 'next' : 'previous';
                    this.currentDate = new Date(pickerYear, month, 1);
                    this.selectedCalendarDate = null;
                    this.closeMonthPicker();
                    this.render();
                };
            }
        };

        renderPicker();
        picker.onkeydown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeMonthPicker();
                trigger.focus();
            }
        };
        picker.focus();

        this.monthPickerOutsideHandler = event => {
            const target = event.target as Node | null;
            if (target && (picker.contains(target) || trigger.contains(target))) return;
            this.closeMonthPicker();
        };
        window.setTimeout(() => {
            if (this.monthPickerOutsideHandler && this.monthPickerEl === picker) {
                document.addEventListener('pointerdown', this.monthPickerOutsideHandler, true);
            }
        }, 0);
    }

    private closeMonthPicker(): void {
        if (this.monthPickerOutsideHandler) {
            document.removeEventListener('pointerdown', this.monthPickerOutsideHandler, true);
            this.monthPickerOutsideHandler = null;
        }
        this.monthPickerEl?.remove();
        this.monthPickerEl = null;
        if (this.monthPickerTrigger) {
            this.monthPickerTrigger.removeClass('active');
            this.monthPickerTrigger.setAttribute('aria-expanded', 'false');
            this.monthPickerTrigger = null;
        }
    }

    /**
     * 打开指定日期的日记
     * 如果日记不存在，先创建再打开
     */
    private async openDailyNote(dateStr: string): Promise<void> {
        // 1. 尝试查找日记
        let dailyNote = await this.plugin.findDailyNote(dateStr);

        // 2. 如果不存在，创建日记
        if (!dailyNote) {
            dailyNote = await this.plugin.createDailyNote(dateStr);
            if (!dailyNote) {
                new Notice(`无法创建日记: ${dateStr}`);
                return;
            }
        }

        // 3. 打开文件（复用已有标签页，避免重复打开）
        const noteToOpen = dailyNote;
        const existingLeaf = this.app.workspace.getLeavesOfType('markdown')
            .find(leaf => (leaf.view as any).file?.path === noteToOpen.path);
        if (existingLeaf) {
            this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
        } else {
            const newLeaf = this.app.workspace.getLeaf('tab');
            await newLeaf.openFile(noteToOpen);
        }
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
    refresh(): void {
        this.render();
    }

    showFocusTab(): void {
        this.currentTab = TabType.FOCUS;
        this.render();
    }

    /**
     * 渲染今日详情内容
     */
    private async renderTodayDetailContent(container: HTMLElement): Promise<void> {
        const todayDetailContainer = container.createDiv({ cls: 'today-detail-container' });
        const recentData = this.getRecentWordCountData(7);
        if (recentData.length > 0) {
            recentData[recentData.length - 1].count = this.plugin.todayWordCount;
        }
        const goal = Math.max(this.plugin.settings.dailyGoal, 1);
        const todayCount = this.plugin.todayWordCount;
        const progress = this.getGoalProgress(todayCount);

        const hero = todayDetailContainer.createDiv({ cls: 'today-hero' });
        this.todayProgressRing = hero.createDiv({ cls: 'today-progress-ring' });
        this.todayProgressRing.style.setProperty('--today-progress', `${Math.min(progress, 100)}%`);
        this.todayProgressRing.classList.toggle('completed', todayCount >= goal);
        const ringContent = this.todayProgressRing.createDiv({ cls: 'today-ring-content' });
        this.wordCountDisplay = ringContent.createDiv({
            cls: 'word-count-value',
            text: String(todayCount)
        });
        ringContent.createDiv({ cls: 'word-count-label', text: '今日字数' });
        this.todayProgressPercent = ringContent.createDiv({
            cls: 'today-progress-percent',
            text: `${progress}%`
        });

        const copy = hero.createDiv({ cls: 'today-copy' });
        this.todayStatusTitle = copy.createEl('h2');
        this.todayStatusDescription = copy.createEl('p');
        this.todayRemainingDisplay = copy.createSpan({ cls: 'today-remaining' });
        this.updateTodayCopy(todayCount);

        const metrics = todayDetailContainer.createDiv({ cls: 'today-metrics' });
        const wphCard = metrics.createDiv({ cls: 'today-metric-card' });
        wphCard.createDiv({ cls: 'today-metric-label', text: '实时速度' });
        this.wphDisplay = wphCard.createDiv({ cls: 'today-metric-value wph-value', text: '0 字/时' });

        const focusCard = metrics.createDiv({ cls: 'today-metric-card' });
        focusCard.createDiv({ cls: 'today-metric-label', text: '今日专注' });
        this.todayFocusDisplay = focusCard.createDiv({
            cls: 'today-metric-value',
            text: this.plugin.settings.focusTrackingEnabled
                ? formatFocusDuration(this.plugin.focusTracker.getTodayDuration())
                : '未开启'
        });

        const streakCard = metrics.createDiv({ cls: 'today-metric-card' });
        streakCard.createDiv({ cls: 'today-metric-label', text: '连续写作' });
        streakCard.createDiv({
            cls: 'today-metric-value',
            text: `${this.calculateRecentStreak(recentData)} 天`
        });

        this.renderTodaySpeedChart(todayDetailContainer);

        this.startTodayDetailUpdates();
    }

    private getRecentWordCountData(days: number): DailyWordCountPoint[] {
        const points: DailyWordCountPoint[] = [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (let offset = days - 1; offset >= 0; offset--) {
            const date = new Date(today);
            date.setDate(today.getDate() - offset);
            const dateStr = this.getLocalDateString(date);
            points.push({ date, dateStr, count: this.getWordCountForDate(dateStr) });
        }
        return points;
    }

    private renderTodaySpeedChart(container: HTMLElement): void {
        const card = container.createDiv({ cls: 'today-speed-card' });
        const header = card.createDiv({ cls: 'today-speed-header' });
        const title = header.createDiv({ cls: 'today-speed-title' });
        title.createEl('strong', { text: '今日码字速度' });
        this.todaySpeedPeakDisplay = title.createSpan({ text: '峰值 0 字/时' });
        this.todaySpeedCurrentDisplay = header.createSpan({
            cls: 'today-speed-current',
            text: '0 字/时'
        });

        const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        chart.addClass('today-speed-chart');
        chart.setAttribute('viewBox', '0 0 300 92');
        chart.setAttribute('preserveAspectRatio', 'none');
        chart.setAttribute('role', 'img');
        chart.setAttribute('aria-label', '实时码字速度趋势');
        card.appendChild(chart);

        [22, 48, 74].forEach(y => {
            const gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            gridLine.addClass('today-speed-grid');
            gridLine.setAttribute('d', `M6 ${y} H294`);
            chart.appendChild(gridLine);
        });

        this.todaySpeedArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.todaySpeedArea.addClass('today-speed-area');
        chart.appendChild(this.todaySpeedArea);

        this.todaySpeedLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.todaySpeedLine.addClass('today-speed-line');
        chart.appendChild(this.todaySpeedLine);

        this.todaySpeedFlow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.todaySpeedFlow.addClass('today-speed-flow');
        chart.appendChild(this.todaySpeedFlow);

        this.todaySpeedDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        this.todaySpeedDot.addClass('today-speed-dot');
        this.todaySpeedDot.setAttribute('r', '3.4');
        chart.appendChild(this.todaySpeedDot);

        const footer = card.createDiv({ cls: 'today-speed-footer' });
        footer.createSpan({ text: '刚才' });
        footer.createSpan({ text: '实时 60 秒窗口' });
        footer.createSpan({ text: '现在' });
        this.updateTodaySpeedChart(this.plugin.getCurrentWPH());
    }

    private updateTodaySpeedChart(wph: number): void {
        this.wphHistory.push(Math.max(0, wph));
        if (this.wphHistory.length > 60) this.wphHistory.shift();

        const values = this.wphHistory.length > 1
            ? this.wphHistory
            : [this.wphHistory[0] || 0, this.wphHistory[0] || 0];
        const chartTop = 9;
        const chartBottom = 82;
        const chartLeft = 6;
        const chartRight = 294;
        const maximum = Math.max(1800, ...values) * 1.12;
        const points = values.map((value, index) => ({
            x: chartLeft + (chartRight - chartLeft) * index / Math.max(values.length - 1, 1),
            y: chartBottom - (chartBottom - chartTop) * value / maximum
        }));

        let linePath = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        for (let index = 1; index < points.length; index++) {
            const previous = points[index - 1];
            const point = points[index];
            const middleX = (previous.x + point.x) / 2;
            linePath += ` C ${middleX.toFixed(2)} ${previous.y.toFixed(2)}, ${middleX.toFixed(2)} ${point.y.toFixed(2)}, ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
        }

        const first = points[0];
        const last = points[points.length - 1];
        const areaPath = `${linePath} L ${last.x.toFixed(2)} ${chartBottom} L ${first.x.toFixed(2)} ${chartBottom} Z`;
        this.todaySpeedLine?.setAttribute('d', linePath);
        this.todaySpeedFlow?.setAttribute('d', linePath);
        this.todaySpeedArea?.setAttribute('d', areaPath);
        this.todaySpeedDot?.setAttribute('cx', last.x.toFixed(2));
        this.todaySpeedDot?.setAttribute('cy', last.y.toFixed(2));
        this.todaySpeedCurrentDisplay?.setText(`${wph} 字/时`);
        this.todaySpeedPeakDisplay?.setText(`峰值 ${Math.max(...this.wphHistory)} 字/时`);
    }

    private calculateRecentStreak(points: DailyWordCountPoint[]): number {
        let index = points.length - 1;
        if (index >= 0 && points[index].count === 0) index--;
        let streak = 0;
        while (index >= 0 && points[index].count > 0) {
            streak++;
            index--;
        }
        return streak;
    }

    private getGoalProgress(wordCount: number): number {
        return Math.round(wordCount / Math.max(this.plugin.settings.dailyGoal, 1) * 100);
    }

    private updateTodayCopy(wordCount: number): void {
        const goal = Math.max(this.plugin.settings.dailyGoal, 1);
        const progress = this.getGoalProgress(wordCount);
        if (wordCount >= goal) {
            this.todayStatusTitle?.setText('今日目标已完成');
            this.todayStatusDescription?.setText('状态很好，接下来可以从容推进，或者给今天留一点余裕。');
            this.todayRemainingDisplay?.setText(`已超额 ${(wordCount - goal).toLocaleString('zh-CN')} 字`);
        } else if (wordCount > 0) {
            this.todayStatusTitle?.setText('今天状态不错');
            this.todayStatusDescription?.setText(`已完成目标的 ${progress}%，保持当前节奏即可。`);
            this.todayRemainingDisplay?.setText(`距离目标还差 ${(goal - wordCount).toLocaleString('zh-CN')} 字`);
        } else {
            this.todayStatusTitle?.setText('今天还没有开始');
            this.todayStatusDescription?.setText('写下第一句后，今天的进度就会从这里开始累积。');
            this.todayRemainingDisplay?.setText(`今日目标 ${goal.toLocaleString('zh-CN')} 字`);
        }
    }

    /**
     * 启动今日详情页面的实时更新
     */
    private startTodayDetailUpdates(): void {
        // 立即更新一次
        this.updateTodayDetail();

        this.detailUpdateTimer = window.setInterval(() => {
            this.updateTodayDetail();
        }, 1000);
    }

    /**
     * 停止今日详情页面的实时更新
     */
    private stopTodayDetailUpdates(): void {
        this.stopLiveUpdates();
    }

    /**
     * 更新今日详情页面的数据
     */
    private updateTodayDetail(): void {
        if (this.currentTab !== TabType.TODAY) return;

        const newCount = this.plugin.todayWordCount;
        if (this.wordCountDisplay) {
            const currentCount = parseInt(this.wordCountDisplay.textContent || '0');

            if (newCount !== currentCount) {
                this.animateNumberChange(this.wordCountDisplay, currentCount, newCount);
            }
        }

        const progress = this.getGoalProgress(newCount);
        this.todayProgressRing?.style.setProperty('--today-progress', `${Math.min(progress, 100)}%`);
        this.todayProgressRing?.classList.toggle(
            'completed',
            newCount >= Math.max(this.plugin.settings.dailyGoal, 1)
        );
        this.todayProgressPercent?.setText(`${progress}%`);
        this.updateTodayCopy(newCount);
        if (this.todayFocusDisplay && this.plugin.settings.focusTrackingEnabled) {
            this.todayFocusDisplay.setText(
                formatFocusDuration(this.plugin.focusTracker.getTodayDuration())
            );
        }

        if (this.wphDisplay) {
            const wph = this.plugin.getCurrentWPH();
            this.wphDisplay.textContent = wph > 0 ? `${wph} 字/时` : '0 字/时';
            this.updateTodaySpeedChart(wph);

            if (wph > 0) {
                this.wphDisplay.addClass('active');
            } else {
                this.wphDisplay.removeClass('active');
            }
        }
    }

    /**
     * 渲染专注时长汇总和笔记排行榜
     */
    private renderFocusContent(container: HTMLElement): void {
        const focusContainer = container.createDiv({ cls: 'focus-detail-container' });

        if (!this.plugin.settings.focusTrackingEnabled) {
            focusContainer.createDiv({
                cls: 'focus-empty-state',
                text: '专注时长统计已关闭，可在插件设置中重新启用。'
            });
            return;
        }

        const currentPath = this.plugin.focusTracker.getCurrentFilePath();
        const overview = focusContainer.createDiv({ cls: 'focus-overview-header' });
        overview.createEl('h2', { text: '专注概览', cls: 'focus-title' });
        const currentNote = overview.createDiv({
            cls: 'focus-current-note',
            text: currentPath
                ? `正在专注 · ${this.getFocusRecordDisplayName(currentPath)}`
                : '当前没有打开的笔记'
        });
        if (currentPath) currentNote.setAttribute('title', currentPath);

        const metrics = focusContainer.createDiv({ cls: 'focus-metrics' });
        this.focusTodayDisplay = this.createFocusMetric(
            metrics,
            '今日专注',
            this.plugin.focusTracker.getTodayDuration()
        );
        this.focusCurrentDisplay = this.createFocusMetric(
            metrics,
            '当前笔记',
            this.plugin.focusTracker.getCurrentFileDuration()
        );
        this.focusTotalDisplay = this.createFocusMetric(
            metrics,
            '累计专注',
            this.plugin.focusTracker.getTotalDuration()
        );

        const periodOption = FOCUS_PERIOD_OPTIONS.find(
            option => option.value === this.focusLeaderboardPeriod
        ) ?? FOCUS_PERIOD_OPTIONS[0];
        const records = this.plugin.focusTracker.getLeaderboard(this.focusLeaderboardPeriod);
        const maxDuration = Math.max(records[0]?.durationMs ?? 0, 1);
        const missingCount = records.filter(record => !record.fileExists).length;
        const listHeader = focusContainer.createDiv({ cls: 'focus-list-header' });
        listHeader.createEl('h3', {
            text: `${periodOption.title}专注排行`,
            cls: 'focus-list-title'
        });
        listHeader.createSpan({
            cls: missingCount > 0 ? 'focus-list-meta has-missing' : 'focus-list-meta',
            text: missingCount > 0
                ? `${records.length} 篇 · ${missingCount} 条失效`
                : `${records.length} 篇`
        });
        const periodSwitcher = focusContainer.createDiv({ cls: 'focus-period-switcher' });
        const activePeriodIndex = FOCUS_PERIOD_OPTIONS.findIndex(
            option => option.value === this.focusLeaderboardPeriod
        );
        const periodIndicator = periodSwitcher.createDiv({ cls: 'focus-period-indicator' });
        periodIndicator.style.setProperty(
            '--focus-period-offset',
            `calc(${activePeriodIndex * 100}% + ${activePeriodIndex * 3}px)`
        );
        if (this.previousFocusPeriod) {
            const previousIndex = FOCUS_PERIOD_OPTIONS.findIndex(
                option => option.value === this.previousFocusPeriod
            );
            periodIndicator.addClass('is-switching');
            periodIndicator.style.setProperty(
                '--focus-period-start-offset',
                `calc(${previousIndex * 100}% + ${previousIndex * 3}px)`
            );
        }
        FOCUS_PERIOD_OPTIONS.forEach(option => {
            const button = periodSwitcher.createEl('button', {
                cls: 'focus-period-button',
                text: option.label,
                attr: { 'aria-label': `查看${option.title}排行` }
            });
            const active = option.value === this.focusLeaderboardPeriod;
            if (active) button.addClass('active');
            button.setAttribute('aria-pressed', String(active));
            button.onclick = () => {
                if (option.value === this.focusLeaderboardPeriod) return;
                this.previousFocusPeriod = this.focusLeaderboardPeriod;
                this.focusLeaderboardPeriod = option.value;
                this.render();
            };
        });
        this.previousFocusPeriod = null;
        if (records.length === 0) {
            focusContainer.createDiv({
                cls: 'focus-empty-state',
                text: `${periodOption.title}暂无超过 1 分钟的专注记录。`
            });
        } else {
            const list = focusContainer.createDiv({ cls: 'focus-record-list' });
            records.forEach((record, index) => {
                const entry = list.createDiv({ cls: 'focus-record-entry' });
                if (!record.fileExists) entry.addClass('is-missing');
                entry.setAttribute('role', 'button');
                entry.tabIndex = 0;
                entry.setAttribute(
                    'aria-label',
                    `${index + 1}. ${this.getFocusRecordDisplayName(record.filePath)}，${formatFocusDuration(record.durationMs)}`
                );
                entry.setAttribute(
                    'title',
                    record.fileExists ? '点击打开笔记，右键管理记录' : '文件不存在，右键可删除记录'
                );
                entry.createSpan({
                    cls: 'focus-record-rank',
                    text: String(index + 1)
                });
                const body = entry.createDiv({ cls: 'focus-record-body' });
                const head = body.createDiv({ cls: 'focus-record-head' });
                const details = head.createDiv({ cls: 'focus-record-details' });
                const name = details.createSpan({
                    cls: 'focus-record-name',
                    text: this.getFocusRecordDisplayName(record.filePath)
                });
                name.setAttribute('title', record.filePath);
                if (!record.fileExists) {
                    details.createSpan({
                        cls: 'focus-record-missing',
                        text: '文件不存在'
                    });
                }
                head.createSpan({
                    cls: 'focus-record-duration-badge',
                    text: this.formatCompactFocusDuration(record.durationMs)
                });
                const progress = body.createDiv({ cls: 'focus-record-progress' });
                const progressBar = progress.createSpan();
                progressBar.style.setProperty(
                    '--focus-progress',
                    `${Math.max(record.durationMs / maxDuration * 100, 2)}%`
                );
                const open = () => void this.plugin.focusTracker.openRecord(record);
                entry.onclick = open;
                entry.onkeydown = event => {
                    if (event.key === 'Enter' || event.key === ' ') open();
                };
                entry.oncontextmenu = event => this.showFocusRecordMenu(event, record);
            });
        }

        this.detailUpdateTimer = window.setInterval(() => this.updateFocusDetail(), 1000);
    }

    private formatCompactFocusDuration(durationMs: number): string {
        if (durationMs > 0 && durationMs < 60_000) return '<1m';
        const totalMinutes = Math.floor(Math.max(0, durationMs) / 60_000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (hours === 0) return `${minutes}m`;
        return minutes > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${hours}h`;
    }

    private getFocusRecordDisplayName(filePath: string): string {
        const file = this.app.vault.getFileByPath(filePath);
        if (file) return file.basename;

        const pathParts = filePath.split('/');
        const fileName = pathParts[pathParts.length - 1] || filePath;
        return fileName.replace(/\.md$/i, '');
    }

    private showFocusRecordMenu(event: MouseEvent, record: FocusRecord): void {
        event.preventDefault();
        const menu = new Menu();

        if (record.fileExists) {
            menu.addItem(item => item
                .setTitle('打开笔记')
                .setIcon('file-text')
                .onClick(() => void this.plugin.focusTracker.openRecord(record))
            );
            menu.addSeparator();
        }

        menu.addItem(item => item
            .setTitle('归属到其他笔记')
            .setIcon('git-merge')
            .onClick(() => {
                new TargetFileSuggest(this.app, async target => {
                    const count = await this.plugin.focusTracker.reassignRecord(record, target.path);
                    if (count > 0) {
                        new Notice(`已归属 ${count} 条事件到「${target.basename}」`);
                    }
                    this.render();
                }).open();
            })
        );
        menu.addSeparator();

        menu.addItem(item => item
            .setTitle('删除此专注记录')
            .setIcon('trash-2')
            .setWarning(true)
            .onClick(async () => {
                const displayName = this.getFocusRecordDisplayName(record.filePath);
                const confirmed = window.confirm(
                    `确定删除“${displayName}”的全部专注记录吗？\n\n该删除会同步到其他设备。`
                );
                if (!confirmed) return;

                const deletedCount = await this.plugin.focusTracker.deleteRecord(record);
                new Notice(`已删除“${displayName}”的 ${deletedCount} 条专注事件`);
                this.render();
            })
        );

        menu.showAtMouseEvent(event);
    }

    private createFocusMetric(container: HTMLElement, label: string, duration: number): HTMLElement {
        const card = container.createDiv({ cls: 'focus-metric-card' });
        card.createDiv({ cls: 'focus-metric-label', text: label });
        return card.createDiv({
            cls: 'focus-metric-value',
            text: formatFocusDuration(duration)
        });
    }

    private updateFocusDetail(): void {
        if (this.currentTab !== TabType.FOCUS) return;
        if (this.focusTodayDisplay) {
            this.focusTodayDisplay.setText(formatFocusDuration(this.plugin.focusTracker.getTodayDuration()));
        }
        if (this.focusCurrentDisplay) {
            this.focusCurrentDisplay.setText(formatFocusDuration(this.plugin.focusTracker.getCurrentFileDuration()));
        }
        if (this.focusTotalDisplay) {
            this.focusTotalDisplay.setText(formatFocusDuration(this.plugin.focusTracker.getTotalDuration()));
        }
    }

    private stopLiveUpdates(): void {
        if (this.detailUpdateTimer !== null) {
            window.clearInterval(this.detailUpdateTimer);
            this.detailUpdateTimer = null;
        }
    }

    /**
     * 数字滚动动画
     */
    private animateNumberChange(
        element: HTMLElement,
        from: number,
        to: number,
        duration: number = 500
    ): void {
        const startTime = Date.now();
        const difference = to - from;

        // 添加缩放动画类
        element.addClass('number-pulse');

        const animate = () => {
            const now = Date.now();
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // 使用 easeOutQuart 缓动函数
            const easeProgress = 1 - Math.pow(1 - progress, 4);
            const currentValue = Math.round(from + difference * easeProgress);

            element.textContent = String(currentValue);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // 动画结束后移除缩放类
                setTimeout(() => {
                    element.removeClass('number-pulse');
                }, 200);
            }
        };

        requestAnimationFrame(animate);
    }
}
