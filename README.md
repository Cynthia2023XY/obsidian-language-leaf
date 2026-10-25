# Language Leaf · 语叶

作者：Cynthia Ding。

[代码仓库](https://github.com/Cynthia2023XY/obsidian-language-leaf) · [问题反馈](https://github.com/Cynthia2023XY/obsidian-language-leaf/issues)

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
