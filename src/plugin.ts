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
    /** 跟随当前活动文章变化的侧栏学习按钮 */
    private readingRibbon?: HTMLElement;
    /** 面板共用的主题与词典展示状态 */
    store = store;
    /** 保留原表格的桌面字号适配 */
    constants = { platform: Platform.isMobile ? "mobile" : "desktop" };

    /** 本次插件实例的生命周期诊断记录，仅保留最近一百条且不包含笔记或设置内容 */
    lifecycleDiagnostics: Array<{ time: string; stage: string; status: string; error?: string; stack?: string }> = [];

    /** 记录启动和卸载阶段，异常同时保留原始对象与堆栈供控制台定位 */
    private logLifecycle(stage: string, status: "开始" | "完成" | "失败", error?: unknown): void {
        // 仅记录阶段与错误，不输出用户配置和文章内容。
        const entry = {
            time: new Date().toISOString(), stage, status,
            ...(error === undefined ? {} : { error: String(error), stack: error instanceof Error ? error.stack : undefined }),
        };
        this.lifecycleDiagnostics.push(entry);
        if (this.lifecycleDiagnostics.length > 100) this.lifecycleDiagnostics.shift();
        if (status === "失败") console.error("[Language Leaf lifecycle]", this.manifest.id, this.manifest.dir, entry, error);
        else console.info("[Language Leaf lifecycle]", this.manifest.id, this.manifest.dir, entry);
    }

    /** 初始化三个原有 Vue 面板及四个核心命令 */
    async onload(): Promise<void> {
        // 失败时保留最后进入的阶段，错误继续交给 Obsidian 处理。
        let stage = "启动入口";
        this.logLifecycle(stage, "开始");
        try {
            stage = "读取并校验设置";
            this.logLifecycle(stage, "开始");
            this.settings = readSettings(await this.loadData());
            stage = "同步主题";
            this.logLifecycle(stage, "开始");
            store.dark = document.body.hasClass("theme-dark");
            stage = "创建学习运行时";
            this.logLifecycle(stage, "开始");
            this.lingualeaf = new LinguaLeafRuntime(this);
            stage = "注册查词面板";
            this.logLifecycle(stage, "开始");
            this.registerView(SEARCH_PANEL_VIEW, leaf => new SearchPanelView(leaf, this));
            stage = "注册新词面板";
            this.logLifecycle(stage, "开始");
            this.registerView(LEARN_PANEL_VIEW, leaf => new LearnPanelView(leaf, this));
            stage = "注册单词列表面板";
            this.logLifecycle(stage, "开始");
            this.registerView(DATA_PANEL_VIEW, leaf => new DataPanelView(leaf, this));
            stage = "注册设置页";
            this.logLifecycle(stage, "开始");
            this.addSettingTab(new SettingTab(this.app, this));
            stage = "注册学习命令与运行时事件";
            this.logLifecycle(stage, "开始");
            this.lingualeaf.load();
            stage = "注册侧栏按钮";
            this.logLifecycle(stage, "开始");
            this.readingRibbon = this.addRibbonIcon("languages", "进入学习模式", () => { void this.lingualeaf.toggle().catch(report); });
            this.addRibbonIcon(SEARCH_ICON, "打开查词面板", () => { void this.activateView(SEARCH_PANEL_VIEW, "left").catch(report); });
            this.addRibbonIcon(LEARN_ICON, "打开新词面板", () => { void this.lingualeaf.openNewWordPanel().catch(report); });
            this.addRibbonIcon(DATA_ICON, "打开单词列表", () => { void this.activateView(DATA_PANEL_VIEW, "tab").catch(report); });
            stage = "注册文章标题栏按钮";
            this.logLifecycle(stage, "开始");
            this.registerReadingActions();
            stage = "注册复习卡片观察器";
            this.logLifecycle(stage, "开始");
            this.registerReviewCardAutoPronounce();
            stage = "注册点击发音事件";
            this.logLifecycle(stage, "开始");
            this.registerDomEvent(document.body, "click", event => {
                // 保留 SR 卡片标题点击发音，不引入另一套复习界面。
                const title = (event.target as HTMLElement).closest<HTMLElement>(".sr-modal-content h4, .sr-card-container .sr-content h4");
                if (title?.textContent?.trim()) this.playReviewCardWord(title.textContent.trim());
            });
            stage = "注册主题事件";
            this.logLifecycle(stage, "开始");
            this.registerEvent(this.app.workspace.on("css-change", () => {
                store.dark = document.body.hasClass("theme-dark"); store.themeChange = !store.themeChange;
            }));
            this.logLifecycle("启动流程", "完成");
        } catch (error) {
            this.logLifecycle(stage, "失败", error);
            throw error;
        }
    }
    /** 停止当前学习会话并卸载面板 */
    onunload(): void {
        // 不吞掉清理错误，使日志与宿主看到同一份原始异常。
        let stage = "卸载学习运行时";
        this.logLifecycle(stage, "开始");
        try {
            this.lingualeaf?.unload();
            for (const type of [SEARCH_PANEL_VIEW, LEARN_PANEL_VIEW, DATA_PANEL_VIEW]) {
                stage = `卸载面板 ${type}`;
                this.logLifecycle(stage, "开始");
                this.app.workspace.detachLeavesOfType(type);
            }
            this.logLifecycle("onunload 清理", "完成");
        } catch (error) {
            this.logLifecycle(stage, "失败", error);
            throw error;
        }
    }
    /** 当前 Markdown 标题栏提供与命令相同的学习模式切换 */
    private registerReadingActions(): void {
        // 各个标签独立维护按钮，不再使用旧阅读器或 frontmatter 标记。
        const update = (): void => this.refreshReadingActions();
        this.registerEvent(this.app.workspace.on("active-leaf-change", update));
        this.registerEvent(this.app.workspace.on("layout-change", update));
        this.registerEvent(this.app.workspace.on("file-open", update));
        this.app.workspace.onLayoutReady(update);
        this.register(() => {
            for (const leaf of this.app.workspace.getLeavesOfType("markdown")) leaf.view.containerEl.querySelectorAll(".lingualeaf-study-action, .change-to-reading").forEach(button => button.remove());
        });
    }
    /** 同步所有文章标题栏与当前侧栏按钮的进入、退出状态 */
    refreshReadingActions(): void {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            // 每个 Markdown 视图都具有独立的学习状态。
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) continue;
            // 视图仍存在时复用标题栏按钮。
            const button = view.containerEl.querySelector<HTMLElement>(".lingualeaf-study-action") || view.addAction("languages", "进入学习模式", () => {
                if (this.lingualeaf.host.sessions.has(view)) this.lingualeaf.host.stop(view);
                else void this.lingualeaf.enter(view).catch(report);
            });
            button.addClass("lingualeaf-study-action");
            this.setReadingAction(button, this.lingualeaf.host.sessions.has(view));
        }
        // 侧栏按钮以当前或最近的 Markdown 视图为操作目标提示。
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (this.readingRibbon) this.setReadingAction(this.readingRibbon, !!active && this.lingualeaf.host.sessions.has(active));
    }
    /** 用可访问状态和中文提示明确显示学习模式是否开启 */
    private setReadingAction(button: HTMLElement, active: boolean): void {
        // aria-label 同时用于 Obsidian 原生悬停提示。
        const label = active ? "退出学习模式" : "进入学习模式";
        button.classList.toggle("lingualeaf-study-active", active);
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-pressed", String(active));
        button.setAttribute("title", label);
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
            this.logLifecycle("移除复习卡片观察器", "开始");
            if (reviewCardPronounceFrame !== null) {
                window.cancelAnimationFrame(reviewCardPronounceFrame);
            }

            reviewCardObserver.disconnect();
            this.logLifecycle("移除复习卡片观察器", "完成");
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
