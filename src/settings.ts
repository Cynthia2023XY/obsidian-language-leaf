import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LinguaLeaf from "./plugin";
import { dicts } from "./dictionary/list";
import { readSettings } from "./lingualeaf/config";
import { SettingsWriter } from "./lingualeaf/settings-writer";
import type { SettingsChange } from "./lingualeaf/settings-writer";

/** 以原生 Obsidian 控件呈现学习、查词和 SR 的最小设置 */
export class SettingTab extends PluginSettingTab {
    /** 设置变更交给当前插件持久化 */
    plugin: LinguaLeaf;
    /** 合并并顺序保存每次编辑，避免快速修改造成设置丢失 */
    private writer: SettingsWriter;
    /** 绑定插件设置页及自动保存边界 */
    constructor(app: App, plugin: LinguaLeaf) {
        super(app, plugin);
        this.plugin = plugin;
        this.writer = new SettingsWriter(() => plugin.settings, settings => plugin.saveSettings(settings), async () => (await plugin.lingualeaf.host.scan()).length > 0);
    }
    /** 自动保存普通设置，使用独立方法名避免覆盖宿主的无参数 update 刷新入口 */
    private updateSettings(change: SettingsChange, errorEl?: HTMLElement): void {
        void this.writer.update(change).then(() => { if (errorEl) errorEl.textContent = ""; }).catch(error => {
            console.error("[Language Leaf settings] 保存设置失败", error, error instanceof Error ? error.stack : undefined);
            // 无效的中间输入保留在控件中，不覆盖已生效的配置。
            const message = error instanceof Error ? error.message : String(error);
            if (errorEl) errorEl.textContent = message;
            else new Notice(message);
        });
    }
    /** 每次打开设置时读取当前配置，保留原生主题样式 */
    display(): void {
        this.containerEl.empty();
        this.containerEl.createEl("h2", { text: "Language Leaf" });
        this.containerEl.createEl("p", { text: "更改自动保存并生效。", cls: "setting-item-description" });
        // 控件初始值使用副本，每次修改独立校验后自动保存。
        const draft = readSettings(this.plugin.settings);
        new Setting(this.containerEl).setName("学习语言").addDropdown(control => control.addOptions({ en: "英语", fr: "法语" }).setValue(draft.learning.language).onChange(value => { this.updateSettings(settings => { settings.learning.language = value; }); }));
        new Setting(this.containerEl).setName("划词修饰键").setDesc("在学习模式下按住该键划选词句；Mac 可选择 Alt / Option。").addDropdown(control => control.addOptions({ shiftKey: "Shift", altKey: "Alt / Option", ctrlKey: "Ctrl", metaKey: "Command" }).setValue(draft.learning.modifier).onChange(value => { this.updateSettings(settings => { settings.learning.modifier = value as typeof draft.learning.modifier; }); }));
        new Setting(this.containerEl).setName("划选后自动查词").setDesc("仅在学习模式中生效。开启后，普通拖选或三指划选稳定后自动打开查词和新词面板；关闭时保留查词按钮及修饰键划词。").addToggle(control => control.setValue(draft.learning.autoQuerySelection).onChange(value => { this.updateSettings(settings => { settings.learning.autoQuerySelection = value; }); }));
        new Setting(this.containerEl).setName("查词自动发音").addToggle(control => control.setValue(draft.auto_pron).onChange(value => { this.updateSettings(settings => { settings.auto_pron = value; }); }));
        new Setting(this.containerEl).setName("复习卡片自动发音").addToggle(control => control.setValue(draft.review_auto_pron).onChange(value => { this.updateSettings(settings => { settings.review_auto_pron = value; }); }));
        new Setting(this.containerEl).setName("发音口音").addDropdown(control => control.addOptions({ "0": "美式", "1": "英式" }).setValue(draft.review_prons).onChange(value => { this.updateSettings(settings => { settings.review_prons = value as "0" | "1"; }); }));
        new Setting(this.containerEl).setName("补充段落翻译").setDesc("优先使用文章已有译文；没有译文时，允许将原段落发送到有道查询翻译。").addToggle(control => control.setValue(draft.use_machine_trans).onChange(value => { this.updateSettings(settings => { settings.use_machine_trans = value; }); }));
        this.containerEl.createEl("h3", { text: "查词词典" });
        for (const id of Object.keys(draft.dictionaries)) {
            // 沿用现有词典组件，仅控制是否启用。
            const dictionary = dicts[id as keyof typeof dicts];
            new Setting(this.containerEl).setName(dictionary.name).setDesc(dictionary.description).addToggle(control => control.setValue(draft.dictionaries[id].enable).onChange(value => { this.updateSettings(settings => { settings.dictionaries[id].enable = value; }); }));
        }
        this.containerEl.createEl("h3", { text: "词句复习" });
        new Setting(this.containerEl).setName("新卡片复习方式").setDesc("只影响之后新收录的卡片；已有卡片通过迁移预览单独选择。内置复习不需要启用 Spaced Repetition。").addDropdown(control => control.addOptions({ builtin: "内置 FSRS 复习", "spaced-repetition": "Spaced Repetition" }).setValue(draft.review.engine).onChange(value => { this.updateSettings(settings => { settings.review.engine = value as typeof draft.review.engine; }); }));
        new Setting(this.containerEl).setName("复习样式").setDesc("用于内置 FSRS 复习。专注回忆：揭晓后显示语境；语境对照：先看原句，揭晓后并排显示释义和译文。更改后重新打开复习窗口生效。").addDropdown(control => control.addOptions({ focus: "专注回忆", context: "语境对照" }).setValue(draft.review.layout).onChange(value => { this.updateSettings(settings => { settings.review.layout = value as typeof draft.review.layout; }); }));
        new Setting(this.containerEl).setName("每日新卡片上限").setDesc("0–100；每天凌晨 4 点按本机时区重置。到期复习不受此限制。").addText(control => control.setValue(String(draft.review.newLimit)).onChange(value => { const number = Number(value); if (value.trim() && Number.isInteger(number) && number >= 0 && number <= 100) this.updateSettings(settings => { settings.review.newLimit = number; }); }));
        new Setting(this.containerEl).setName("目标记忆保持率").setDesc("70%–97%，默认 90%。越高，复习越频繁。").addSlider(control => control.setLimits(70, 97, 1).setValue(Math.round(draft.review.retention * 100)).setDynamicTooltip().onChange(value => { this.updateSettings(settings => { settings.review.retention = value / 100; }); }));
        this.containerEl.createEl("h3", { text: "Spaced Repetition 闪卡" });
        // SR 格式输入就地反馈，减少输入过程中的打断。
        const deck = new Setting(this.containerEl).setName("卡组标签").setDesc("与 Spaced Repetition 的卡组设置一致。");
        // 错误文案继承 Obsidian 原生字体与主题颜色。
        const deckError = deck.descEl.createDiv({ attr: { role: "alert" } });
        deckError.style.color = "var(--text-error)";
        deck.addText(control => control.setValue(draft.learning.deck).onChange(value => { this.updateSettings(settings => { settings.learning.deck = value.trim(); }, deckError); }));
        // 已有闪卡时保持原分隔符，防止既有卡片失去识别能力。
        const separator = new Setting(this.containerEl).setName("多行问答分隔符").setDesc("与 Spaced Repetition 一致；已有卡片时不直接更改。");
        // 校验消息跟随对应输入，不影响其他设置的保存。
        const separatorError = separator.descEl.createDiv({ attr: { role: "alert" } });
        separatorError.style.color = "var(--text-error)";
        separator.addText(control => control.setValue(draft.learning.separator).onChange(value => { this.updateSettings(settings => { settings.learning.separator = value; }, separatorError); }));
    }
}
