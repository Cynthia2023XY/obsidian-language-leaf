import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LinguaLeaf from "./plugin";
import { dicts } from "./dictionary/list";
import { readSettings } from "./lingualeaf/config";

/** 以原生 Obsidian 控件呈现学习、查词和 SR 的最小设置 */
export class SettingTab extends PluginSettingTab {
    /** 设置变更交给当前插件持久化 */
    plugin: LinguaLeaf;
    /** 绑定插件设置页 */
    constructor(app: App, plugin: LinguaLeaf) { super(app, plugin); this.plugin = plugin; }
    /** 每次打开设置时读取当前配置，保留原生主题样式 */
    display(): void {
        this.containerEl.empty();
        this.containerEl.createEl("h2", { text: "Language Leaf" });
        // 使用编辑底稿，避免校验失败时影响当前文章。
        const draft = readSettings(this.plugin.settings);
        new Setting(this.containerEl).setName("学习语言").addDropdown(control => control.addOptions({ en: "英语", fr: "法语" }).setValue(draft.learning.language).onChange(value => { draft.learning.language = value; }));
        new Setting(this.containerEl).setName("划词修饰键").setDesc("在学习模式下按住该键划选词句；Mac 可选择 Alt / Option。").addDropdown(control => control.addOptions({ shiftKey: "Shift", altKey: "Alt / Option", ctrlKey: "Ctrl", metaKey: "Command" }).setValue(draft.learning.modifier).onChange(value => { draft.learning.modifier = value as typeof draft.learning.modifier; }));
        new Setting(this.containerEl).setName("查词自动发音").addToggle(control => control.setValue(draft.auto_pron).onChange(value => { draft.auto_pron = value; }));
        new Setting(this.containerEl).setName("SR 卡片自动发音").addToggle(control => control.setValue(draft.review_auto_pron).onChange(value => { draft.review_auto_pron = value; }));
        new Setting(this.containerEl).setName("发音口音").addDropdown(control => control.addOptions({ "0": "美式", "1": "英式" }).setValue(draft.review_prons).onChange(value => { draft.review_prons = value as "0" | "1"; }));
        new Setting(this.containerEl).setName("补充段落翻译").setDesc("优先使用文章已有译文；没有译文时，允许将原段落发送到有道查询翻译。").addToggle(control => control.setValue(draft.use_machine_trans).onChange(value => { draft.use_machine_trans = value; }));
        this.containerEl.createEl("h3", { text: "查词词典" });
        for (const id of Object.keys(draft.dictionaries)) {
            // 沿用现有词典组件，仅控制是否启用。
            const dictionary = dicts[id as keyof typeof dicts];
            new Setting(this.containerEl).setName(dictionary.name).setDesc(dictionary.description).addToggle(control => control.setValue(draft.dictionaries[id].enable).onChange(value => { draft.dictionaries[id].enable = value; }));
        }
        this.containerEl.createEl("h3", { text: "Spaced Repetition 闪卡" });
        new Setting(this.containerEl).setName("卡组标签").setDesc("与 Spaced Repetition 的卡组设置一致。").addText(control => control.setValue(draft.learning.deck).onChange(value => { draft.learning.deck = value.trim(); }));
        new Setting(this.containerEl).setName("多行问答分隔符").setDesc("与 Spaced Repetition 一致；已有卡片时不直接更改。").addText(control => control.setValue(draft.learning.separator).onChange(value => { draft.learning.separator = value; }));
        new Setting(this.containerEl).addButton(button => button.setButtonText("保存设置").setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                if (!/^#[\p{L}\p{N}_/-]+$/u.test(draft.learning.deck) || !draft.learning.separator.trim() || /[\r\n<>]/.test(draft.learning.separator)) throw new Error("卡组标签或分隔符无效");
                if (draft.learning.separator !== this.plugin.lingualeaf.host.settings.separator && (await this.plugin.lingualeaf.host.scan()).length) throw new Error("已有闪卡，不能直接更改分隔符");
                await this.plugin.saveSettings(draft);
                new Notice("设置已保存");
            } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
            finally { button.setDisabled(false); }
        }));
    }
}
