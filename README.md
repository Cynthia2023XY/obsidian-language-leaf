# Language Leaf

[中文使用与开发说明](README.zh-CN.md)

Read native Markdown, look up words and sentences, and save vocabulary as flashcards in the same note. Review with the built-in FSRS engine or the separate Spaced Repetition plugin.

## Installation and usage

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Cynthia2023XY/obsidian-language-leaf/releases/latest). Copy them to `<vault configuration folder>/plugins/language-leaf/`, reload Obsidian, and enable Language Leaf in Community plugins. Preserve your existing `data.json`. Requires desktop Obsidian 1.14.4 or later.

- Enable learning mode on a Markdown note. Hold Shift while selecting text, or configure Alt/Option. Three-finger selection can query when the modifier is released. Alternatively, enable automatic selection lookup or click the selection's lookup button.
- Edit the new-word form and save with Command+Enter on macOS or Ctrl+Enter on Windows/Linux. The shortcut applies inside the new-word panel.
- Choose the review engine for new cards in settings. Existing cards retain their engine unless explicitly migrated through the migration preview.
- Built-in FSRS review supports recall and context layouts, audio, daily new-card limits, undo, pause/resume, and source-note navigation. Space reveals the answer; arrow keys rate it after reveal.
- Switching a note to editing exits learning mode.

## Review data and migration

Card content stays in Markdown. Built-in review state is stored as append-only events under `LinguaLeafData/review/` by default. Synchronize the entire data folder and resolve sync conflicts before continuing review.

SR migration is optional and creates backups. SM-2 schedules are approximations; rollback is supported before the first built-in rating. Migrating the same card repeatedly is not supported. Existing notes, vocabulary, and settings are not automatically migrated from the old Language Learner plugin.

## Privacy and attribution

Enabled dictionaries receive the selected word or sentence. Optional paragraph translation sends the original paragraph to Youdao when no translation is present. Online pronunciation uses dictionary recordings or Youdao audio. System speech uses voices available on the device through Obsidian; voice availability and quality depend on the system. Notes and review data stay in your vault; the plugin provides no remote data sync.

This project is derived from [Language Learner by the_tree](https://github.com/guopenghui/obsidian-language-learner), retains dictionary and Vue panel code, and preserves the original MIT license and attribution. It is independently maintained by Cynthia Ding. Independent maintenance does not imply that inherited code was written from scratch.

The built-in review engine uses [ts-fsrs 5.4.1](https://github.com/open-spaced-repetition/ts-fsrs), licensed under MIT. See [third-party license](licenses/ts-fsrs-LICENSE).

## Development

Use Node.js 22.12 or later:

```sh
npm ci
npm run test:run -- --pool=forks --maxWorkers=1 --no-file-parallelism
npm run build
```

Release assets are built and attested in GitHub Actions. See [release notes](docs/releases/) and [repository maintenance](docs/repository-migration.md). Licensed under [MIT](LICENSE).

### 短句上下文

查词时，若所选词所在句少于配置的单词数阈值（默认 15），会按“前后扩展句数”（默认 1）纳入上下文。原有自然段仍完整保留；同段上下文不重复添加，跨段时按配置补足句数，不跨标题、代码块或普通引用。定位锚点仍使用原段落。若同段存在多个相同选词，保留原段落，避免猜测目标句。跨段扩展包含完整段落且各段均有已有译文时，按原顺序拼接对应译文；缺失译文或只截取部分段落时，交由已有自动翻译功能或手动填写。

例句扩展会保留原文分段，跨段补充以空行分隔；自动翻译按相同分段生成译文。闪卡通过显式换行保存，重新编辑和复习时仍保留分段。

在“阅读与查词”设置中调整“短句单词数阈值”和“前后扩展句数”，两项均接受非负整数，任一项设为 0 即关闭扩展。更改自动保存，仅影响之后收录的例句，不修改已有卡片。

扩展边界落在对话引号内部时，会补齐整段引号内的对话，避免出现孤立闭引号或只剩半段对话；因此实际纳入的句数可能超过配置值。
