# Word Count Calendar

Word Count Calendar is a local-first Obsidian plugin for visualizing daily writing progress and tracking focus time for individual notes. It never sends note content or statistics to external services.

> 在 Obsidian 里看见每天的写作痕迹，也看见一篇笔记真正被投入过的时间。

**Word Count Calendar** is a local-first Obsidian plugin that visualizes daily writing progress in a calendar and tracks focus time for individual notes.

一个本地优先的 Obsidian 插件：用日历展示每日写作字数，并以事件账本记录专注时长、笔记排行与累计投入。

## 功能

- **写作日历**：按月显示每日字数与目标完成度，颜色随完成度渐变。
- **中英文混合统计**：中文按字计数，英文按空格分词；忽略标点、Frontmatter 与代码块。
- **实时写作速度**：状态栏展示今日累计字数与当前写作速度。
- **文件夹范围**：可设置参与统计或排除统计的文件夹。
- **日记属性同步**：自动把当天新增字数写入日记的 `码字数` 属性。
- **专注时长追踪**：统计今天、当前笔记与全部笔记的专注时长，并提供排行视图。
- **可靠的数据账本**：专注时长按带唯一 ID 的事件保存，支持多设备合并、检查点恢复与滚动备份。
- **属性投影与重建**：可把专注时长写入笔记的 `累计专注秒` 属性、日记的 `当日专注秒` 属性，也可由账本重新生成。
- **旧数据迁移**：首次启动会尝试导入旧版 `focus-time` 插件的数据。

## 安装

### 从社区插件市场安装

插件通过审核并上架后，在 Obsidian 中打开：

1. **设置 → 第三方插件**。
2. 关闭安全模式（如尚未关闭）。
3. 点击 **浏览**，搜索“字数与专注统计日历”。
4. 安装并启用插件。

### 手动安装或测试最新版

1. 下载对应版本 Release 中的 `main.js`、`manifest.json` 和 `styles.css`。
2. 在你的库中创建文件夹：`.obsidian/plugins/word-count-calendar/`。
3. 将这三个文件放入该文件夹。
4. 重启 Obsidian，或在 **设置 → 第三方插件** 中启用本插件。

## 使用

### 打开视图

- 点击左侧栏的日历图标，打开字数日历。
- 点击左侧栏的计时器图标，打开专注统计。
- 也可以从命令面板运行：
  - `打开字数统计日历`
  - `打开专注时长统计`

### 可配置项

在 **设置 → 字数与专注统计日历** 中可以配置：

- 每日目标字数
- 参与统计与排除统计的文件夹
- 日记文件夹与日记模板
- 日历格子的颜色、透明度和大小
- 是否追踪专注时长
- 严格模式：Obsidian 失焦时暂停专注计时
- 是否将专注时长同步到笔记和日记属性

### 命令

- `打开字数统计日历`
- `打开专注时长统计`
- `更新当前文件字数`
- `更新所有文件字数`
- `从专注账本重建笔记属性`

在 Markdown 文件的右键菜单中，还可以使用 **设置专注时长** 修正单篇笔记的统计值。

## 数据与隐私

本插件不连接网络，不收集遥测数据，也不会把笔记内容或统计数据发送到任何外部服务。

插件仅在当前 Obsidian 库内读写以下本地数据：

- 插件设置与字数缓存：`.obsidian/plugins/word-count-calendar/data.json`
- 专注时长事件账本与备份：`.obsidian/plugins/word-count-calendar/focus-time-data*.json`、`focus-time-backups/`
- 可选的笔记属性：`码字数`、`累计专注秒`、`当日专注秒`

你可以随时在插件设置中关闭专注追踪或属性同步。删除插件前，如需保留历史专注数据，请备份上述文件。

## 开发

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

提交 Release 时，请上传构建后的 `main.js`、`manifest.json` 与 `styles.css`。

## 反馈与贡献

问题反馈和功能建议请提交到本仓库的 [Issues](../../issues)。欢迎 Pull Request。

## 许可证

[MIT License](LICENSE)
