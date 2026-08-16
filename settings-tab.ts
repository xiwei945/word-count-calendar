import { App, PluginSettingTab, Setting } from 'obsidian';
import WordCountCalendarPlugin from './main';
import { ColorWithOpacity } from './settings';

/**
 * 设置页面
 */
export class WordCountSettingTab extends PluginSettingTab {
    plugin: WordCountCalendarPlugin;

    constructor(app: App, plugin: WordCountCalendarPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * 添加颜色和透明度设置控件
     */
    private addColorWithOpacitySetting(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        colorSetting: ColorWithOpacity,
        onChange: (value: ColorWithOpacity) => void
    ): void {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desc);

        // 颜色选择器
        setting.addColorPicker(colorPicker => {
            colorPicker.setValue(colorSetting.color);
            colorPicker.onChange(async (value) => {
                colorSetting.color = value;
                await onChange(colorSetting);
            });
        });

        // 透明度滑动条
        setting.addSlider(slider => {
            slider.setLimits(0, 100, 1);
            slider.setValue(colorSetting.opacity);
            slider.setDynamicTooltip();
            slider.onChange(async (value) => {
                colorSetting.opacity = value;
                await onChange(colorSetting);
            });
        });
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('字数统计日历')
            .setHeading();

        // 每日目标设置
        new Setting(containerEl)
            .setName('每日目标字数')
            .setDesc('设置每天的写作字数目标，用于颜色渐变显示')
            .addText(text => text
                .setPlaceholder('1000')
                .setValue(String(this.plugin.settings.dailyGoal))
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        this.plugin.settings.dailyGoal = numValue;
                        await this.plugin.saveSettings();
                        this.plugin.refreshCalendarView();
                    }
                }));

        new Setting(containerEl)
            .setName('专注时长统计')
            .setHeading();

        new Setting(containerEl)
            .setName('启用专注时长统计')
            .setDesc('统计当前打开笔记的专注时长，并在状态栏和统计视图中显示。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.focusTrackingEnabled)
                .onChange(async (value) => {
                    this.plugin.focusTracker?.captureNow();
                    this.plugin.settings.focusTrackingEnabled = value;
                    this.plugin.focusTracker?.syncTrackingState();
                    await this.plugin.saveSettings();
                    this.plugin.updateStatusBar();
                    this.plugin.refreshCalendarView();
                }));

        new Setting(containerEl)
            .setName('严格模式')
            .setDesc('开启后，Obsidian 窗口失去焦点时暂停计时。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.focusStrictMode)
                .onChange(async (value) => {
                    this.plugin.focusTracker?.captureNow();
                    this.plugin.settings.focusStrictMode = value;
                    this.plugin.focusTracker?.syncTrackingState();
                    await this.plugin.saveSettings();
                    this.plugin.updateStatusBar();
                }));

        new Setting(containerEl)
            .setName('同步专注数据到笔记属性')
            .setDesc('把账本计算结果写入对应笔记的“累计专注秒”和日记的“当日专注秒”。账本仍是唯一原始数据。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.focusWriteProperties)
                .onChange(async (value) => {
                    this.plugin.settings.focusWriteProperties = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('重建专注属性')
            .setDesc('根据事件账本重新计算已有笔记和已有日记的专注属性，不会创建历史日记。')
            .addButton(button => button
                .setButtonText('开始重建')
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('重建中…');
                    await this.plugin.focusTracker.rebuildProperties();
                    button.setButtonText('重建完成');
                    window.setTimeout(() => {
                        button.setDisabled(false);
                        button.setButtonText('开始重建');
                    }, 1500);
                }));

        const focusStorageDesc = containerEl.createDiv({ cls: 'word-count-color-description' });
        focusStorageDesc.createEl('p', {
            text: 'focus-time-data.json 保存带唯一 ID 的专注事件账本；属性只是可重建汇总。账本会维护备份、合并同步冲突，并在首次运行时转换旧 focus-time 数据。'
        });

        // 格子颜色设置组
        new Setting(containerEl)
            .setName('格子颜色')
            .setHeading();

        // 无数据格子颜色
        this.addColorWithOpacitySetting(
            containerEl,
            '无数据格子颜色',
            '设置没有数据的日期格子的背景颜色和透明度',
            this.plugin.settings.emptyCellColor,
            async (value) => {
                this.plugin.settings.emptyCellColor = value;
                await this.plugin.saveSettings();
                this.plugin.refreshCalendarView();
            }
        );

        // Level 1 颜色
        this.addColorWithOpacitySetting(
            containerEl,
            'Level 1 颜色',
            '字数 < 40% 目标时的格子颜色和透明度',
            this.plugin.settings.level1Color,
            async (value) => {
                this.plugin.settings.level1Color = value;
                await this.plugin.saveSettings();
                this.plugin.refreshCalendarView();
            }
        );

        // Level 2 颜色
        this.addColorWithOpacitySetting(
            containerEl,
            'Level 2 颜色',
            '字数 40% - 70% 目标时的格子颜色和透明度',
            this.plugin.settings.level2Color,
            async (value) => {
                this.plugin.settings.level2Color = value;
                await this.plugin.saveSettings();
                this.plugin.refreshCalendarView();
            }
        );

        // Level 3 颜色
        this.addColorWithOpacitySetting(
            containerEl,
            'Level 3 颜色',
            '字数 70% - 100% 目标时的格子颜色和透明度',
            this.plugin.settings.level3Color,
            async (value) => {
                this.plugin.settings.level3Color = value;
                await this.plugin.saveSettings();
                this.plugin.refreshCalendarView();
            }
        );

        // Level 4 颜色
        this.addColorWithOpacitySetting(
            containerEl,
            'Level 4 颜色',
            '字数 ≥ 100% 目标时的格子颜色和透明度',
            this.plugin.settings.level4Color,
            async (value) => {
                this.plugin.settings.level4Color = value;
                await this.plugin.saveSettings();
                this.plugin.refreshCalendarView();
            }
        );

        // 格子大小设置组
        new Setting(containerEl)
            .setName('日记与日历')
            .setHeading();

        // 格子大小
        new Setting(containerEl)
            .setName('格子大小')
            .setDesc('调整日历格子的大小（30px - 80px）')
            .addSlider(slider => {
                slider.setLimits(30, 80, 1);
                slider.setValue(this.plugin.settings.cellSize);
                slider.setDynamicTooltip();
                slider.onChange(async (value) => {
                    this.plugin.settings.cellSize = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshCalendarView();
                });
            });

        // 日记文件夹设置
        new Setting(containerEl)
            .setName('日记文件夹')
            .setDesc('日记文件所在的文件夹路径（留空表示根目录）。例如：日记 或 Daily Notes')
            .addText(text => text
                .setPlaceholder('留空或填写文件夹路径')
                .setValue(this.plugin.settings.dailyNotesFolder)
                .onChange(async (value) => {
                    this.plugin.settings.dailyNotesFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        // 日记模板设置
        new Setting(containerEl)
            .setName('日记模板')
            .setDesc('创建日记时使用的模板文件路径（可省略 .md 扩展名）。模板中可以使用 {{date}} 作为日期占位符。留空则使用默认模板。')
            .addText(text => text
                .setPlaceholder('留空或填写模板文件路径，如：Templates/Daily Note.md')
                .setValue(this.plugin.settings.dailyNoteTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.dailyNoteTemplate = value.trim();
                    await this.plugin.saveSettings();
                }));

        // 包含文件夹设置
        new Setting(containerEl)
            .setName('包含文件夹')
            .setDesc('只统计这些文件夹中的文件（留空表示统计所有文件夹）。多个文件夹请用逗号分隔，例如：日记,笔记')
            .addTextArea(text => {
                text.setPlaceholder('日记,笔记')
                    .setValue(this.plugin.settings.includeFolders.join(','))
                    .onChange(async (value) => {
                        this.plugin.settings.includeFolders = value
                            .split(',')
                            .map(f => f.trim())
                            .filter(f => f.length > 0);
                        await this.plugin.saveSettings();
                        this.plugin.refreshCalendarView();
                    });
                text.inputEl.rows = 3;
                text.inputEl.cols = 30;
            });

        // 排除文件夹设置
        new Setting(containerEl)
            .setName('排除文件夹')
            .setDesc('不统计这些文件夹中的文件。多个文件夹请用逗号分隔')
            .addTextArea(text => {
                text.setPlaceholder('模板,归档')
                    .setValue(this.plugin.settings.excludeFolders.join(','))
                    .onChange(async (value) => {
                        this.plugin.settings.excludeFolders = value
                            .split(',')
                            .map(f => f.trim())
                            .filter(f => f.length > 0);
                        await this.plugin.saveSettings();
                        this.plugin.refreshCalendarView();
                    });
                text.inputEl.rows = 3;
                text.inputEl.cols = 30;
            });

        // 清空缓存按钮
        new Setting(containerEl)
            .setName('清空字数缓存')
            .setDesc('清空所有文件的字数缓存。下次编辑文件时会重新建立基线。如果遇到字数统计重复或不准确的问题，可以尝试清空缓存。')
            .addButton(button => button
                .setButtonText('清空缓存')
                .setWarning()
                .onClick(async () => {
                    const confirmed = confirm(
                        '确定要清空所有字数缓存吗？\n\n' +
                        '清空后，所有文件在下次编辑时会重新建立字数基线。\n' +
                        '这不会影响已记录的日记数据。'
                    );
                    if (confirmed) {
                        this.plugin.settings.wordCountCache = {};
                        await this.plugin.saveSettings();
                        button.setButtonText('已清空');
                        setTimeout(() => {
                            button.setButtonText('清空缓存');
                        }, 2000);
                    }
                }));

        // 颜色说明
        new Setting(containerEl)
            .setName('颜色说明')
            .setHeading();
        const colorDesc = containerEl.createDiv({ cls: 'word-count-color-description' });
        colorDesc.createEl('p', { text: '日历颜色参考 GitHub 贡献图模式 (绿色系)：' });
        const ul = colorDesc.createEl('ul');
        ul.createEl('li', { text: '颜色随字数增加而变深 (共4个等级)' });
        ul.createEl('li', { text: 'Level 1: < 40% 目标' });
        ul.createEl('li', { text: 'Level 2: 40% - 70% 目标' });
        ul.createEl('li', { text: 'Level 3: 70% - 100% 目标' });
        ul.createEl('li', { text: 'Level 4: ≥ 100% 目标' });
        ul.createEl('li', { text: '无数据：可自定义颜色' });

        // 使用说明
        new Setting(containerEl)
            .setName('使用说明')
            .setHeading();
        const usageDesc = containerEl.createDiv({ cls: 'word-count-color-description' });
        usageDesc.createEl('p', { text: '插件使用增量统计方式：' });
        const usageUl = usageDesc.createEl('ul');
        usageUl.createEl('li', { text: '编辑文件时，只统计新增的字数' });
        usageUl.createEl('li', { text: '字数自动记录到当天的日记文件（YYYY-MM-DD.md格式）' });
        usageUl.createEl('li', { text: '如果日记不存在，会自动创建' });
        usageUl.createEl('li', { text: '右下角状态栏实时显示今日码字数' });
    }
}
