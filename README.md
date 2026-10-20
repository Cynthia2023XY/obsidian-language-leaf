# Language Leaf · 语叶

作者：Cynthia Ding。

在 Obsidian 原生 Markdown 中阅读、查词和收录词句，直接保存为同篇文章中的 Spaced Repetition 闪卡。

只提供四条命令：

1. 切换当前文档为学习模式
2. 打开单词列表
3. 打开查词面板
4. 打开新词面板

保留原 Language Learner 的单词表、左侧词典和右侧新词表单样式。普通文章无需 `langr` 标记或正文包绕，默认 Shift 划词，也可选择 Alt / Option。已内置双语 `translation` Callout 样式。

当前不提供旧数据库、旧阅读器、服务端连接、迁移工具、独立统计、内置复习和引擎转换。现有笔记与旧数据不自动迁移、转换或删除。

查词会发送词句到所启用的第三方词典；启用补充段落翻译且没有现成译文时，会发送原段落到有道。查词及 SR 自动发音访问有道音频服务。学习数据保存在本地 Vault，没有联网同步。

- 桌面 Obsidian 1.14.4 起；插件 ID 为 `language-leaf`，测试库安装目录为 `.obsidian/plugins/language-leaf/`，尚未发布新 Release。
- [使用与开发说明](docs/lingualeaf/使用与开发说明.md)
- [运行验收记录](docs/lingualeaf/runtime-smoke.json)

基于 Language Learner 原有词典与 Vue 面板实现重构，保留原作者与 MIT 许可信息。
