<img width="602" height="566" alt="image" src="https://github.com/user-attachments/assets/9095f61a-6bcf-4e48-931b-8079e86088c2" />
<img width="584" height="468" alt="image" src="https://github.com/user-attachments/assets/ad522d72-7ac5-40c5-a262-6462a76f3b01" />
<img width="590" height="606" alt="image" src="https://github.com/user-attachments/assets/66c53a89-ac82-459f-91db-cb369594e7ef" />


# Word Count Calendar

[English](#english) · [中文](#中文)

<a id="english"></a>

Word Count Calendar is a local-first Obsidian plugin for visualizing daily writing progress and tracking focus time for individual notes. It never sends note content or statistics to external services.

## Features

- **Writing calendar**: Shows daily word counts, goals, and color-coded progress by month.
- **Chinese and English word counting**: Counts CJK characters and space-separated English words while ignoring punctuation, frontmatter, and code blocks.
- **Live writing speed**: Displays today's accumulated words and current writing speed in the status bar.
- **Folder filters**: Include or exclude folders from word-count tracking.
- **Daily note sync**: Optionally writes each day's added words to the `码字数` frontmatter property.
- **Focus-time tracking**: Tracks focus time for the current note, today, and all notes, with a ranking view.
- **Reliable event ledger**: Stores focus time as uniquely identified events, with conflict merging, checkpoints, and rolling backups.
- **Rebuildable properties**: Optionally projects focus totals to note and daily-note frontmatter, and can rebuild those values from the event ledger.
- **Legacy migration**: Imports data from the older `focus-time` plugin on first launch when available.

## Installation

### Community plugins

After the plugin is approved and listed in the Obsidian Community plugin directory:

1. Open **Settings → Community plugins** in Obsidian.
2. Turn off Restricted mode if needed.
3. Select **Browse**, search for **Word Count Calendar**, then install and enable it.

### Manual installation or latest-version testing

1. Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub Release.
2. Create `.obsidian/plugins/word-count-calendar/` inside your vault.
3. Put the three downloaded files in that folder.
4. Restart Obsidian, or enable the plugin from **Settings → Community plugins**.

## Usage

### Open views

- Select the calendar icon in the left ribbon to open the writing calendar.
- Select the timer icon in the left ribbon to open focus statistics.
- You can also use these Command Palette entries:
  - `打开字数统计日历`
  - `打开专注时长统计`

### Settings

The settings tab lets you configure:

- Daily word goal.
- Included and excluded folders.
- Daily-note folder and template.
- Calendar colors, opacity, and cell size.
- Focus-time tracking and strict mode, which pauses tracking while Obsidian is unfocused.
- Optional note and daily-note frontmatter projection for focus totals.

### Commands

- `打开字数统计日历`
- `打开专注时长统计`
- `更新当前文件字数`
- `更新所有文件字数`
- `从专注账本重建笔记属性`

The Markdown-file context menu also includes **设置专注时长**, which lets you correct a note's cumulative focus time.

## Data and privacy

This plugin is fully local-first. It does not connect to a network, collect telemetry, or send note content or statistics to external services.

The plugin only reads and writes the following local vault data:

- Settings and word-count cache: `.obsidian/plugins/word-count-calendar/data.json`
- Focus-time event ledger and backups: `.obsidian/plugins/word-count-calendar/focus-time-data*.json` and `focus-time-backups/`
- Optional note properties: `码字数`, `累计专注秒`, and `当日专注秒`

You can disable focus tracking or property projection at any time. Back up the listed focus-time files before removing the plugin if you want to preserve the history.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

For a GitHub Release, upload the generated `main.js`, `manifest.json`, and `styles.css` files as release assets.

## Feedback and contribution

For bug reports, feature requests, or feedback, please email **1743049104@qq.com**. This is the preferred contact channel.

You can also open an [Issue](../../issues) when you want the discussion to be public and searchable. Pull requests are welcome.

## License

[MIT License](LICENSE)

---

<a id="中文"></a>

# 字数统计日历

[English](#english) · [中文](#中文)

> 在 Obsidian 里看见每天的写作痕迹，也看见一篇笔记真正被投入过的时间。

字数统计日历是一个本地优先的 Obsidian 插件：用日历展示每日写作字数，并以事件账本记录单篇笔记、当天与全库的专注时长。插件不会把笔记内容或统计数据发送到外部服务。

## 主要功能

- **写作日历**：按月查看每日码字、目标完成度和颜色渐变。
- **中英文混合字数统计**：统计中文字符与英文单词，忽略标点、Frontmatter 和代码块。
- **实时码字速度**：状态栏显示今日累计字数与最近一分钟的码字速度。
- **文件夹筛选**：可指定纳入或排除字数统计的文件夹。
- **日记字数同步**：可选择将每日新增字数写入日记的 `码字数` 属性。
- **专注时长统计**：统计当前笔记、当天与全部笔记的专注时长，并提供排行视图。
- **可靠事件账本**：专注数据以带唯一 ID 的事件保存，支持冲突合并、定期检查点与滚动备份。
- **可重建属性**：可选择将累计专注时长同步到笔记与日记属性，也可以从事件账本重建。
- **旧版迁移**：首次启用时可导入旧版 `focus-time` 插件的数据。

## 安装

### 社区插件

插件通过审核并进入 Obsidian 社区插件目录后：

1. 打开 Obsidian 的 **设置 → 社区插件**。
2. 如有需要，关闭受限模式。
3. 点击 **浏览**，搜索 **Word Count Calendar**，安装并启用。

### 手动安装或测试最新版本

1. 从对应的 GitHub Release 下载 `main.js`、`manifest.json` 与 `styles.css`。
2. 在你的库中创建 `.obsidian/plugins/word-count-calendar/`。
3. 将这三个文件放入该文件夹。
4. 重启 Obsidian，或在 **设置 → 社区插件** 中启用插件。

## 使用方式

### 打开视图

- 点击左侧边栏的日历图标，打开字数统计日历。
- 点击左侧边栏的计时器图标，打开专注统计。
- 也可以使用命令面板：
  - `打开字数统计日历`
  - `打开专注时长统计`

### 设置项

设置页可以配置：

- 每日字数目标。
- 纳入和排除统计的文件夹。
- 日记文件夹与日记模板。
- 日历颜色、透明度与格子大小。
- 专注时长统计与严格模式。严格模式下窗口失焦会暂停计时。
- 是否将累计专注数据同步到笔记和日记的 Frontmatter 属性。

### 命令

- `打开字数统计日历`
- `打开专注时长统计`
- `更新当前文件字数`
- `更新所有文件字数`
- `从专注账本重建笔记属性`

Markdown 文件的右键菜单也包含 **设置专注时长**，可用于修正某篇笔记的累计专注时间。

## 数据与隐私

插件完全本地优先，不联网、不收集遥测，也不会发送笔记内容或统计数据。

插件只会读取和写入以下本地数据：

- 设置与字数缓存：`.obsidian/plugins/word-count-calendar/data.json`
- 专注事件账本与备份：`.obsidian/plugins/word-count-calendar/focus-time-data*.json` 和 `focus-time-backups/`
- 可选笔记属性：`码字数`、`累计专注秒`、`当日专注秒`

你可以随时关闭专注统计或属性同步。如果想在卸载前保留历史记录，请备份上述专注数据文件。

## 开发

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

发布 GitHub Release 时，需要上传构建生成的 `main.js`、`manifest.json` 与 `styles.css`。

## 反馈与贡献

Bug、功能建议或使用反馈，请优先发送邮件至 **1743049104@qq.com**。

如果你希望讨论公开可追踪，也可以提交 [Issue](../../issues)。欢迎 Pull Request。

## 许可证

[MIT License](LICENSE)
