import { ItemView, Scope, WorkspaceLeaf, } from 'obsidian';
import LanguageLearner from '@/plugin';
import { t } from "@/lang/helper";
import { createApp, App } from 'vue';
import LearnPanel from './LearnPanel.vue';
import { installQuickSaveScope } from '../lingualeaf/quick-save';

export const LEARN_ICON: string = "reading-glasses";
export const LEARN_PANEL_VIEW: string = 'langr-learn-panel';

export class LearnPanelView extends ItemView {
    plugin: LanguageLearner;
    vueapp: App;
    private stopQuickSave?: () => void;

    constructor(leaf: WorkspaceLeaf, plugin: LanguageLearner) {
        super(leaf);
        this.plugin = plugin;
        this.scope = new Scope(this.app.scope);
    }
    getViewType(): string {
        return LEARN_PANEL_VIEW;
    }
    getDisplayText(): string {
        return t("Learning New Words");
    }
    getIcon(): string {
        return LEARN_ICON;
    }
    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        // const contentEl = container.createEl("div", {
        //     cls: "langr-learn"
        // })
        this.vueapp = createApp(LearnPanel);
        this.vueapp.config.globalProperties.view = this;
        this.vueapp.config.globalProperties.plugin = this.plugin;
        this.vueapp.mount(container);
        this.stopQuickSave?.();
        this.stopQuickSave = installQuickSaveScope(this.scope!, container as HTMLElement, () => {
            // 与按钮点击使用同一表单校验、保存和防重复提交路径。
            container.querySelector<HTMLButtonElement>("button.ll-save-card")?.click();
        });
    }
    async onClose() {
        this.stopQuickSave?.(); this.stopQuickSave = undefined;
        // 重载插件可能重复关闭叶子，卸载同一个 Vue 实例应保持幂等。
        this.vueapp?.unmount();
    }

}
