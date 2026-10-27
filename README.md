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
