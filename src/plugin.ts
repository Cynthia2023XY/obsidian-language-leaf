import { MarkdownView, Notice, Platform, Plugin } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { SearchPanelView, SEARCH_ICON, SEARCH_PANEL_VIEW } from "./views/SearchPanelView";
import { LearnPanelView, LEARN_ICON, LEARN_PANEL_VIEW } from "./views/LearnPanelView";
import { DataPanelView, DATA_ICON, DATA_PANEL_VIEW } from "./views/DataPanelView";
import { SettingTab } from "./settings";
import { readSettings } from "./lingualeaf/config";
import type { LeafPluginSettings } from "./lingualeaf/config";
import { LinguaLeafRuntime } from "./lingualeaf/runtime";
import { report } from "./lingualeaf/ui";
import { playAudio } from "./utils/helpers";
import store from "./store";

/** 原生文章学习、词典面板和 SR 随文闪卡的插件入口 */
export default class LinguaLeaf extends Plugin {
    /** 当前学习与收词服务 */
    lingualeaf: LinguaLeafRuntime;
    /** 经白名单校验的简化配置 */
    settings: LeafPluginSettings;
    /** 面板共用的主题与词典展示状态 */
    store = store;
    /** 保留原表格的桌面字号适配 */
    constants = { platform: Platform.isMobile ? "mobile" : "desktop" };

    /** 初始化三个原有 Vue 面板及四个核心命令 */
    async onload(): Promise<void> {
        this.settings = readSettings(await this.loadData());
        store.dark = document.body.hasClass("theme-dark");
        this.lingualeaf = new LinguaLeafRuntime(this);
        this.registerView(SEARCH_PANEL_VIEW, leaf => new SearchPanelView(leaf, this));
        this.registerView(LEARN_PANEL_VIEW, leaf => new LearnPanelView(leaf, this));
        this.registerView(DATA_PANEL_VIEW, leaf => new DataPanelView(leaf, this));
        this.addSettingTab(new SettingTab(this.app, this));
        this.lingualeaf.load();
        this.addRibbonIcon("languages", "切换当前文档为学习模式", () => { void this.lingualeaf.toggle().catch(report); });
        this.addRibbonIcon(SEARCH_ICON, "打开查词面板", () => { void this.activateView(SEARCH_PANEL_VIEW, "left").catch(report); });
        this.addRibbonIcon(LEARN_ICON, "打开新词面板", () => { void this.lingualeaf.openNewWordPanel().catch(report); });
        this.addRibbonIcon(DATA_ICON, "打开单词列表", () => { void this.activateView(DATA_PANEL_VIEW, "tab").catch(report); });
        this.registerReadingActions();
        this.registerReviewCardAutoPronounce();
        this.registerDomEvent(document.body, "click", event => {
            // 保留 SR 卡片标题点击发音，不引入另一套复习界面。
            const title = (event.target as HTMLElement).closest<HTMLElement>(".sr-modal-content h4, .sr-card-container .sr-content h4");
            if (title?.textContent?.trim()) this.playReviewCardWord(title.textContent.trim());
        });
        this.registerEvent(this.app.workspace.on("css-change", () => {
            store.dark = document.body.hasClass("theme-dark"); store.themeChange = !store.themeChange;
        }));
    }
    /** 停止当前学习会话并卸载面板 */
    onunload(): void {
        this.lingualeaf?.unload();
        for (const type of [SEARCH_PANEL_VIEW, LEARN_PANEL_VIEW, DATA_PANEL_VIEW]) this.app.workspace.detachLeavesOfType(type);
    }
    /** 当前 Markdown 标题栏提供与命令相同的学习模式切换 */
    private registerReadingActions(): void {
        // 各个标签独立维护按钮，不再使用旧阅读器或 frontmatter 标记。
        const update = (): void => {
            for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
                // 只对已有文件的原生 Markdown 视图添加一次。
                const view = leaf.view;
                if (!(view instanceof MarkdownView) || !view.file || view.containerEl.querySelector(".lingualeaf-study-action")) continue;
                view.addAction("languages", "切换当前文档为学习模式", () => {
                    if (this.lingualeaf.host.sessions.has(view)) this.lingualeaf.host.stop(view);
                    else void this.lingualeaf.enter(view).catch(report);
                }).addClass("lingualeaf-study-action");
            }
        };
        this.registerEvent(this.app.workspace.on("layout-change", update));
        this.registerEvent(this.app.workspace.on("file-open", update));
        this.app.workspace.onLayoutReady(update);
        this.register(() => {
            for (const leaf of this.app.workspace.getLeavesOfType("markdown")) leaf.view.containerEl.querySelectorAll(".lingualeaf-study-action, .change-to-reading").forEach(button => button.remove());
        });
    }
    /** 更新白名单配置并立即应用到学习服务及词典面板 */
    async saveSettings(settings: LeafPluginSettings): Promise<void> {
        // 先持久化，写入失败时不让运行配置与磁盘分叉。
        const next = readSettings(settings);
        await this.saveData(next);
        this.settings = next;
        this.lingualeaf.host.settings = next.learning;
        store.dictsChange = !store.dictsChange;
    }
    /** 复用已有叶子；查词在左、新词在右、单词列表在主标签区 */
    async activateView(type: string, side: "left" | "right" | "tab"): Promise<void> {
        // 面板已经打开时直接激活，不重复创建。
        let leaf = this.app.workspace.getLeavesOfType(type)[0];
        if (!leaf) {
            // 明确按面板职责定位宿主区域。
            const target: WorkspaceLeaf = side === "left" ? this.app.workspace.getLeftLeaf(false) : side === "right" ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf("tab");
            if (!target) throw new Error("无法创建面板");
            leaf = target; await leaf.setViewState({ type, active: true });
        }
        await this.app.workspace.revealLeaf(leaf);
    }
    /** 监听 SR 卡片展示并保留同一标题元素的发音去重 */
    registerReviewCardAutoPronounce() {
        // 间隔复习弹窗和卡片内单词标题的选择器
        const reviewCardTitleSelector = ".sr-modal-content h4, .sr-card-container .sr-content h4";
        // 最近一次自动播放的复习标题元素，用于避免卡片内按钮变化时重复发音
        let lastAutoPronouncedTitle: HTMLElement = null;
        // 最近一次自动播放的单词，用于判断同一标题元素上的单词变化
        let lastAutoPronouncedWord = "";
        // 当前等待执行的自动发音检查任务，用于合并连续 DOM 变化
        let reviewCardPronounceFrame: number = null;
        // 自动播放当前可见复习卡片单词发音
        const pronounceVisibleReviewCard = () => {
            if (!this.settings.review_auto_pron) return;
            // 当前页面中存在的复习卡片单词标题列表
            const titles = Array.from(document.body.querySelectorAll<HTMLElement>(reviewCardTitleSelector));
            // 当前可见的复习卡片单词标题
            const title = titles.find((item) => item.offsetParent !== null);
            if (!title) {
                lastAutoPronouncedTitle = null;
                lastAutoPronouncedWord = "";
                return;
            }

            // 当前复习卡片中的单词文本
            const word = title.textContent?.trim();
            if (!word) return;

            if (title === lastAutoPronouncedTitle && word === lastAutoPronouncedWord) return;

            lastAutoPronouncedTitle = title;
            lastAutoPronouncedWord = word;
            this.playReviewCardWord(word);
        };
        // 安排一次自动发音检查，避免同一次页面渲染触发多次播放
        const scheduleReviewCardPronounce = () => {
            if (reviewCardPronounceFrame !== null) return;

            reviewCardPronounceFrame = window.requestAnimationFrame(() => {
                reviewCardPronounceFrame = null;
                pronounceVisibleReviewCard();
            });
        };
        // 监听闪卡插件弹窗或卡片内容变化的观察器
        const reviewCardObserver = new MutationObserver(() => {
            scheduleReviewCardPronounce();
        });

        reviewCardObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        this.register(() => {
            if (reviewCardPronounceFrame !== null) {
                window.cancelAnimationFrame(reviewCardPronounceFrame);
            }

            reviewCardObserver.disconnect();
        });
        pronounceVisibleReviewCard();
    }

    /** 播放间隔复习卡片中单词的有道发音 */
    playReviewCardWord(word: string) {
        // 复习卡片发音使用的口音配置
        let accent = this.settings.review_prons;
        // 有道单词发音音频地址
        let wordUrl =
            `https://dict.youdao.com/dictvoice?type=${accent}&audio=` +
            encodeURIComponent(word);
        playAudio(wordUrl);
    }

}
