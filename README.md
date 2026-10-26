# Language Leaf · 语叶

作者：Cynthia Ding。

[代码仓库](https://github.com/Cynthia2023XY/obsidian-language-leaf) · [问题反馈](https://github.com/Cynthia2023XY/obsidian-language-leaf/issues)

在 Obsidian 原生 Markdown 中阅读、查词和收录词句，直接保存为同篇文章中的 Spaced Repetition 闪卡。

提供五条命令：

1. 切换当前文档为学习模式
2. 打开单词列表
3. 打开查词面板
4. 打开新词面板
5. 查询选中的词句（可在快捷键设置中自行绑定）

保留原 Language Learner 的单词表、左侧词典和右侧新词表单样式。普通文章无需 `langr` 标记或正文包绕，默认 Shift 划词，也可选择 Alt / Option。已内置双语 `translation` Callout 样式。学习模式支持先划选再点选区旁的“查词”；在设置开启“划选后自动查词”后，普通拖选和三指划选稳定后会自动打开查词及新词面板。切到编辑视图时退出学习模式并提示。查询命令始终可在命令面板搜索。新词面板统一用 `⌘ Enter`（Mac）/ `Ctrl Enter`（Windows、Linux）保存，释义为单行；闪卡采用精简字段名称和段间留白，兼容旧卡片与 SR 进度。

当前不提供旧数据库、旧阅读器、服务端连接、迁移工具、独立统计、内置复习和引擎转换。现有笔记与旧数据不自动迁移、转换或删除。

查词会发送词句到所启用的第三方词典；启用补充段落翻译且没有现成译文时，会发送原段落到有道。查词及 SR 自动发音访问有道音频服务。学习数据保存在本地 Vault，没有联网同步。

- 桌面 Obsidian 1.14.4 起；插件 ID 为 `language-leaf`，测试库安装目录为 `.obsidian/plugins/language-leaf/`，尚未发布新 Release。
- [使用与开发说明](docs/lingualeaf/使用与开发说明.md)
- [运行验收记录](docs/lingualeaf/runtime-smoke.json)

## 项目来源与致谢

Language Leaf 最初基于 [guopenghui/obsidian-language-learner](https://github.com/guopenghui/obsidian-language-learner) 重构，沿用了原项目的词典与部分 Vue 面板实现，现由 Cynthia Ding 独立开发和维护。感谢原作者 the_tree（guopenghui）的工作。

本仓库保留完整开发主线提交历史、原作者署名、MIT 许可及代码中的第三方来源说明。独立仓库不表示所有代码均为从零编写。

2026-10-25 起，后续开发和问题反馈统一在本仓库进行；[旧 fork](https://github.com/Cynthia2023XY/obsidian-language-learner) 保留迁移说明。插件名称、ID 和当前版本保持为 Language Leaf、`language-leaf`、`0.2.8`。历史标签仅用于追溯原项目，不代表 Language Leaf 的发布版本。

## 构建与发布

使用 Node.js 22，克隆本仓库后运行：

```sh
npm ci
npm run test:run -- --pool=forks --poolOptions.forks.singleFork
npm run build
```

将构建得到的 `main.js`、`manifest.json`、`styles.css` 放入测试笔记库的 `.obsidian/plugins/language-leaf/`，保留已有 `data.json`。重新加载插件后测试。

本次迁移未创建 Release，尚未提交社区市场。发布流程见 [仓库迁移与维护](docs/repository-migration.md)。


### 内置 FSRS 词句复习

- 在设置的“新卡片复习方式”选择“内置 FSRS 复习”。原有安装默认维持 SR；更改设置只影响新卡片。
- 命令“开始词句复习”覆盖词库；“复习当前文章词句”限定当前文章。空格揭晓答案，**← 不记得、↓ 不确定、↑ 记得、→ 简单**。未揭晓、输入编辑、组合输入和长按时不会误评分。
- 设置 → Language Leaf → 词句复习 → **复习样式** 可选择“专注回忆”或“语境对照”，重新打开复习窗口生效。语境对照先展示原句，揭晓后并排显示释义和译文，窄窗口上下排列；切换布局沿用同一份复习进度。
- 支持间隔预览、撤销上次评分、暂停与恢复、当轮跳过、原文定位、发音及原位编辑。每日新词默认 10 张，按本机时区凌晨 4 点换日。
- 内容保存在文章中；进度以只创建、不覆盖的版本事件保存在 `LinguaLeafData/review/`，支持重启恢复。请同步整个数据目录；出现同步冲突时停止评分并处理冲突副本。
- “迁移 SR 卡片到内置复习（预览）”逐张选择，先备份再转换。完整 FSRS 状态按字段导入，但不导入旧日志或自定义算法参数；SM-2 标为近似转换，也可重新开始。尚未评分时可回退；评分后不支持恢复旧 SR 进度。回退后保留审计记录，此版本不支持同一卡片反复迁移。
- 固定使用 [ts-fsrs 5.4.1](https://github.com/open-spaced-repetition/ts-fsrs)，FSRS-6 模型；MIT 许可全文见 [licenses/ts-fsrs-LICENSE](licenses/ts-fsrs-LICENSE)。不包含参数训练器或额外服务。
