# Word Count Calendar

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

Report bugs or feature requests through this repository's [Issues](../../issues). Pull requests are welcome.

## License

[MIT License](LICENSE)

---

## 中文说明

> 在 Obsidian 里看见每天的写作痕迹，也看见一篇笔记真正被投入过的时间。

这是一个本地优先的 Obsidian 插件：用日历展示每日写作字数，并以事件账本记录专注时长、笔记排行与累计投入。插件不会把笔记内容或统计数据发送到外部服务。

### 主要功能

- 按月查看每日码字、目标完成度和颜色渐变。
- 中英文混合字数统计，忽略 Frontmatter 与代码块。
- 状态栏显示当日字数与实时码字速度。
- 支持包含或排除指定文件夹。
- 可将每日新增字数同步到日记的 `码字数` 属性。
- 统计当前笔记、当天与全部笔记的专注时长，并提供排行视图。
- 专注数据使用带唯一 ID 的事件账本保存，支持备份、合并与恢复。
- 可将专注统计同步到 `累计专注秒`、`当日专注秒` 属性，也可从账本重建。

安装方式、使用方式和隐私说明以上方英文正文为准；插件界面与命令保持中文。