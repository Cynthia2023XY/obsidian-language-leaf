# Language Leaf · 语叶

## Overview

Language Leaf helps you read native Markdown, look up words and sentences, and save vocabulary as Spaced Repetition flashcards in the same note.

### Installation and usage

Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release. Copy them to `<vault configuration folder>/plugins/language-leaf/`, restart Obsidian, and enable Language Leaf in Community plugins. Preserve an existing `data.json` when updating.

Run the learning-mode command on a Markdown note, then hold Shift while selecting text to look it up. Use the new-word panel to edit and save a flashcard. Alt/Option selection is configurable. Flashcard review uses the separate Spaced Repetition plugin.

### Privacy and attribution

Enabled dictionaries receive the selected word or sentence. Optional paragraph translation sends the original paragraph to Youdao when no translation is present. Pronunciation requests use Youdao audio services. Notes and learning data stay in your vault; the plugin provides no remote data sync.

This project is derived from [Language Learner by the_tree](https://github.com/guopenghui/obsidian-language-learner), retains dictionary and Vue panel code, and preserves the original MIT license and attribution. It is independently maintained by Cynthia Ding.


[中文使用与开发说明](README.zh-CN.md)

## License and development

Licensed under the [MIT License](LICENSE). Third-party attribution is retained in the repository.

Language Leaf retains code from Language Learner by the_tree, including dictionary engines and Vue panels. Independent maintenance does not imply that inherited code was written from scratch. The original license and attribution are preserved.

Development requires Node.js 22.12 or later. Run `npm ci`, `npm run test:run -- --pool=forks --maxWorkers=1 --no-file-parallelism`, and `npm run build`. Release assets are built and attested in GitHub Actions. Existing notes, vocabulary, and plugin settings are not automatically migrated from the old Language Learner plugin.
