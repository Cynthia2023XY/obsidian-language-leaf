import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type LinguaLeaf from "./plugin";
import { dicts } from "./dictionary/list";
import { readSettings } from "./lingualeaf/config";
import { SettingsWriter } from "./lingualeaf/settings-writer";
import { pronounce, onPronunciation, stopPronunciation } from "./utils/helpers";
import { voiceId } from "./lingualeaf/pronunciation/providers";
import type { SettingsChange } from "./lingualeaf/settings-writer";

/** 以原生 Obsidian 控件呈现学习、查词和 SR 的最小设置 */
export class SettingTab extends PluginSettingTab {
    /** 设置变更交给当前插件持久化 */
    plugin: LinguaLeaf;
    /** 合并并顺序保存每次编辑，避免快速修改造成设置丢失 */
    private writer: SettingsWriter;
    private cleanupSpeech?: () => void;
    hide(): void { this.cleanupSpeech?.(); this.cleanupSpeech = undefined; stopPronunciation("settings-preview"); }
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
    /** 新版宿主提供的是单行容器；内部使用独立块级容器承载整页设置。 */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [{ name: "Language Leaf", aliases: ["学习语言", "划词修饰键", "划选后自动查词", "查词自动发音", "发音口音", "查词词典", "词句复习", "卡组标签"], render: setting => {
            setting.settingEl.empty();
            setting.settingEl.addClass("ll-settings-host");
            this.renderSettings(setting.settingEl.createDiv({ cls: "ll-settings-content" }));
        } }];
    }
    /** 兼容旧版设置页入口。 */
    display(): void { this.renderSettings(this.containerEl); }
    /** 每次重新渲染先清理声音监听，保留原生主题样式。 */
    private renderSettings(container: HTMLElement): void {
        this.hide();
        container.empty();
        new Setting(container).setName("阅读与查词").setHeading();
        container.createEl("p", { text: "更改自动保存并生效。", cls: "setting-item-description" });
        // 控件初始值使用副本，每次修改独立校验后自动保存。
        const draft = readSettings(this.plugin.settings);
        new Setting(container).setName("学习语言").addDropdown(control => control.addOptions({ en: "英语", fr: "法语" }).setValue(draft.learning.language).onChange(value => { this.updateSettings(settings => { settings.learning.language = value; }); }));
        new Setting(container).setName("划词修饰键").setDesc("在学习模式下按住该键划选词句；Mac 可选择 Alt / Option。").addDropdown(control => control.addOptions({ shiftKey: "Shift", altKey: "Alt / Option", ctrlKey: "Ctrl", metaKey: "Command" }).setValue(draft.learning.modifier).onChange(value => { this.updateSettings(settings => { settings.learning.modifier = value as typeof draft.learning.modifier; }); }));
        new Setting(container).setName("划选后自动查词").setDesc("仅在学习模式中生效。开启后，普通拖选或三指划选稳定后自动打开查词和新词面板；关闭时保留查词按钮及修饰键划词。").addToggle(control => control.setValue(draft.learning.autoQuerySelection).onChange(value => { this.updateSettings(settings => { settings.learning.autoQuerySelection = value; }); }));
        new Setting(container).setName("查词自动发音").addToggle(control => control.setValue(draft.auto_pron).onChange(value => { this.updateSettings(settings => { settings.auto_pron = value; }); }));
        new Setting(container).setName("复习卡片自动发音").addToggle(control => control.setValue(draft.review_auto_pron).onChange(value => { this.updateSettings(settings => { settings.review_auto_pron = value; }); }));
        new Setting(container).setName("发音口音").addDropdown(control => control.addOptions({ "0": "美式", "1": "英式" }).setValue(draft.review_prons).onChange(value => { this.updateSettings(settings => { settings.review_prons = value as "0" | "1"; }); }));
        new Setting(container).setName("启用系统朗读").setDesc("单词的在线音频失败时使用系统朗读；短语和句子直接使用系统朗读。关闭后短语可能无法发音，词典录音仍可播放。").addToggle(control => control.setValue(draft.speech.enabled).onChange(value => { this.updateSettings(settings => { settings.speech.enabled = value; }); }));
        const speechSetting = new Setting(container).setName("系统朗读声音").setDesc("自动选择优先普通朗读音色；也可选择具体声音试听。仅列出英语声音（含英式、美式等口音），以当前设备在 Obsidian 中可用的声音为准。");
        const speechStatus = speechSetting.descEl.createDiv({ attr: { role: "status" } });
        let selectedVoice = draft.speech.voice;
        let refreshVoices: () => void = () => {};
        speechSetting.addDropdown(control => {
            refreshVoices = () => {
                const voices = typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices().filter(voice => /^en(?:[-_]|$)/i.test(voice.lang));
                control.selectEl.empty(); control.addOption("", "自动选择普通朗读声音");
                for (const voice of [...voices].sort((a,b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))) control.addOption(voiceId(voice), `${voice.name} · ${voice.lang}${voice.default ? " · 系统默认" : ""}`);
                if (selectedVoice && !voices.some(voice => voiceId(voice) === selectedVoice)) control.addOption(selectedVoice, "已保存的声音不可用或非英语，请重新选择");
                control.setValue(selectedVoice);
                if (!voices.length) speechStatus.setText("尚未检测到可用英语声音，可刷新列表或在系统设置中安装英语语音。");
            };
            refreshVoices();
            control.onChange(value => { selectedVoice = value; this.updateSettings(settings => { settings.speech.voice = value; }); });
        });
        speechSetting.addButton(control => control.setButtonText("刷新声音").onClick(refreshVoices));
        speechSetting.addButton(control => control.setButtonText("试听").onClick(() => {
            pronounce({ text: "The traveler paused on the threshold and looked back.", language: "en", accent: this.plugin.settings.review_prons === "1" ? "uk" : "us", voice: selectedVoice, owner: "settings-preview", trigger: "manual", systemOnly: true, allowSystem: true });
        }));
        const unsubscribe = onPronunciation(state => { if (state.owner === "settings-preview") speechStatus.setText(state.message); });
        if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener("voiceschanged", refreshVoices);
        this.cleanupSpeech = () => { unsubscribe(); if (typeof speechSynthesis !== "undefined") speechSynthesis.removeEventListener("voiceschanged", refreshVoices); };
        new Setting(container).setName("补充段落翻译").setDesc("优先使用文章已有译文；没有译文时，允许将原段落发送到有道查询翻译。").addToggle(control => control.setValue(draft.use_machine_trans).onChange(value => { this.updateSettings(settings => { settings.use_machine_trans = value; }); }));
        new Setting(container).setName("查词词典").setHeading();
        for (const id of Object.keys(draft.dictionaries)) {
            // 沿用现有词典组件，仅控制是否启用。
            const dictionary = dicts[id as keyof typeof dicts];
            new Setting(container).setName(dictionary.name).setDesc(dictionary.description).addToggle(control => control.setValue(draft.dictionaries[id].enable).onChange(value => { this.updateSettings(settings => { settings.dictionaries[id].enable = value; }); }));
        }
        new Setting(container).setName("词句复习").setHeading();
        new Setting(container).setName("新卡片复习方式").setDesc("只影响之后新收录的卡片；已有卡片通过迁移预览单独选择。内置复习不需要启用 Spaced Repetition。").addDropdown(control => control.addOptions({ builtin: "内置 FSRS 复习", "spaced-repetition": "Spaced Repetition" }).setValue(draft.review.engine).onChange(value => { this.updateSettings(settings => { settings.review.engine = value as typeof draft.review.engine; }); }));
        new Setting(container).setName("复习样式").setDesc("用于内置 FSRS 复习。专注回忆：揭晓后显示语境；语境对照：先看原句，揭晓后并排显示释义和译文。更改后重新打开复习窗口生效。").addDropdown(control => control.addOptions({ focus: "专注回忆", context: "语境对照" }).setValue(draft.review.layout).onChange(value => { this.updateSettings(settings => { settings.review.layout = value as typeof draft.review.layout; }); }));
        new Setting(container).setName("每日新卡片上限").setDesc("10–200，默认 100；每天凌晨 4 点按本机时区重置。到期复习不受此限制。").addText(control => control.setValue(String(draft.review.newLimit)).onChange(value => { const number = Number(value); if (value.trim() && Number.isInteger(number) && number >= 10 && number <= 200) this.updateSettings(settings => { settings.review.newLimit = number; }); }));
        new Setting(container).setName("目标记忆保持率").setDesc("70%–97%，默认 90%。越高，复习越频繁。").addSlider(control => control.setLimits(70, 97, 1).setValue(Math.round(draft.review.retention * 100)).setDynamicTooltip().onChange(value => { this.updateSettings(settings => { settings.review.retention = value / 100; }); }));
        new Setting(container).setName("Spaced Repetition 闪卡").setHeading();
        // SR 格式输入就地反馈，减少输入过程中的打断。
        const deck = new Setting(container).setName("卡组标签").setDesc("与 Spaced Repetition 的卡组设置一致。");
        // 错误文案继承 Obsidian 原生字体与主题颜色。
        const deckError = deck.descEl.createDiv({ attr: { role: "alert" } });
        deckError.setCssStyles({ color: "var(--text-error)" });
        deck.addText(control => control.setValue(draft.learning.deck).onChange(value => { this.updateSettings(settings => { settings.learning.deck = value.trim(); }, deckError); }));
        // 已有闪卡时保持原分隔符，防止既有卡片失去识别能力。
        const separator = new Setting(container).setName("多行问答分隔符").setDesc("与 Spaced Repetition 一致；已有卡片时不直接更改。");
        // 校验消息跟随对应输入，不影响其他设置的保存。
        const separatorError = separator.descEl.createDiv({ attr: { role: "alert" } });
        separatorError.setCssStyles({ color: "var(--text-error)" });
        separator.addText(control => control.setValue(draft.learning.separator).onChange(value => { this.updateSettings(settings => { settings.learning.separator = value; }, separatorError); }));
    }
}
