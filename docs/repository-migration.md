# Language Leaf 仓库迁移与维护

迁移日期：2026-10-25。

## 开发入口

- 当前仓库：https://github.com/Cynthia2023XY/obsidian-language-leaf
- 旧 fork：https://github.com/Cynthia2023XY/obsidian-language-learner
- 上游来源：https://github.com/guopenghui/obsidian-language-learner
- 默认开发分支：`main`。
- 本地开发目录：`obsidian-language-leaf/`，与旧 fork 目录并列。

以旧 fork 的提交 `7b6a3269a02a19508999d8bc09f6393784a337d2` 为迁移基线，完整保留该主线的祖先提交和现有历史标签。原 fork 的 `dev` 分支保留在旧仓库，未作为新的开发分支迁入。原仓库的 Issues、PR、Release 和仓库设置仍留在原仓库，不随 Git 提交迁移。

插件名称 `Language Leaf`、ID `language-leaf`、版本 `0.2.8` 及数据目录保持不变。笔记、设置和学习数据无需因仓库更换而搬迁。旧 Language Learner 数据仍不自动迁移。

保留 MIT 许可证、原作者与当前作者署名、第三方来源注释。移除了原作者赞助配置、旧支付图片和已不适用于当前功能的截图及教程；这些资料仍可在 Git 历史中查阅。`docs/project-overview.md` 标记为旧架构归档，历史验收 JSON 保留原样。

## 验证和发布

推送 `main` 或提交 PR 后，CI 自动安装锁定依赖、运行现有测试并构建。迁移历史标签不会触发发布。

仅在确认版本可以发布后：

1. 使用 `npm version patch`（或合适的版本增量）同步 package、lockfile、manifest 和 versions.json。
2. 运行测试及构建，部署到测试笔记库并验证，提交并推送 `main`。
3. 在 GitHub Actions 的 `Release Language Leaf` 中选择 `main`，手动运行并输入与 manifest 完全一致的版本号（无 `v` 前缀）。
4. 工作流核对版本映射、测试和构建，然后为当前提交创建对应 Release，上传 `main.js`、`manifest.json`、`styles.css`。
5. 核验远端附件。社区市场提交是独立步骤。

工作流只接受 `main`，版本必须是严格的 `x.y.z`。本次迁移不升级版本、不创建 Release、不提交市场、不归档旧仓库。

发布工作流采用 [GitHub 的手动触发机制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) 和 [GitHub CLI 创建 Release](https://cli.github.com/manual/gh_release_create)。
