import { MarkdownView, Notice, TFile } from "obsidian";
import type LanguageLearner from "../plugin";
import { LeafHost } from "./host";
import { report } from "./ui";
import { newId, expressionKey } from "./domain";
import type { ArticleContext, LeafCard } from "./domain";
import type { ExpressionInfo } from "./panel-model";
import { DATA_PANEL_VIEW } from "../views/DataPanelView";
import { SEARCH_PANEL_VIEW } from "../views/SearchPanelView";
import { LEARN_PANEL_VIEW } from "../views/LearnPanelView";
import { cardToForm, formToCard } from "./panel-model";
import { resetShiftSelection, extendShiftSelection } from "./selection";
import type { TextCaret } from "./selection";
import { watchReadingMode } from "./reading-mode";
import { installSelectionQuery, readingSelection } from "./selection-query";

/** 右侧新词表单冻结的文章来源，防止异步查询写错文件 */
export interface PanelCapture {
    /** 本次表单身份 */
    id: string;
    /** 明确的保存目标 */
    file: TFile;
    /** 原文、已有译文和大纲快照 */
    context: ArticleContext;
    /** 同文已有卡片或新卡底稿 */
    card: LeafCard;
    /** 表单可编辑的原有词条结构 */
    model: ExpressionInfo;
    /** 从词库进入的编辑不增加收录次数 */
    isEdit: boolean;
    /** 打开表单时同词累计的收录次数 */
    captureCount: number;
    /** 会话有效性检查 */
    valid: () => boolean;
}

/** 原生阅读、三个学习面板和随文 SR 闪卡的运行时 */
export class LinguaLeafRuntime {
    /** 新用例的宿主服务 */
    readonly host: LeafHost;
    /** 复用现有词典和面板的插件宿主 */
    private plugin: LanguageLearner;
    /** 所有新命令的错误保护 */
    private alive = true;
    /** 当前右侧表单对应的随文收录请求 */
    capture?: PanelCapture;
    /** 快速连续划词时仅允许最后一次请求打开面板。 */
    private queries = new WeakMap<MarkdownView, number>();
    /** 读取当前原生学习与 SR 格式配置 */
    constructor(plugin: LanguageLearner) {
        this.plugin = plugin;
        this.host = new LeafHost(plugin, plugin.settings.learning);
        this.host.onSessionChange = () => plugin.refreshReadingActions();
    }
    /** 注册命令及严格绑定会话的事件 */
    load(): void {
        this.command("leaf-toggle-reading", "切换当前文档为学习模式", () => this.toggle());
        this.command("leaf-query-selection", "查询选中的词句", () => this.queryActive());
        this.command("leaf-library", "打开单词列表", () => this.plugin.activateView(DATA_PANEL_VIEW, "tab"));
        this.command("leaf-search-panel", "打开查词面板", () => this.plugin.activateView(SEARCH_PANEL_VIEW, "left"));
        this.command("leaf-learn-panel", "打开新词面板", () => this.openNewWordPanel());
        this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.host.prune()));
        this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", () => this.host.prune()));
        this.plugin.registerEvent(this.plugin.app.vault.on("modify", file => this.host.invalidate(file.path)));
        this.plugin.registerEvent(this.plugin.app.vault.on("delete", () => this.host.prune()));
        this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, editor, view) => {
            if (!(view instanceof MarkdownView) || !this.host.sessions.has(view) || !editor.getSelection().trim()) return;
            menu.addItem(item => item.setTitle("查询选区").setIcon("sprout").onClick(() => void this.query(view, editor.getSelection()).catch(report)));
        }));
        this.plugin.app.workspace.onLayoutReady(() => {
            if (this.alive) void this.host.recover().then(failures => { if (failures.length && this.alive) new Notice(`Language Leaf 有 ${failures.length} 个待写回操作，下次加载时会自动重试`, 8000); }).catch(report);
        });
    }
    /** 注册统一错误处理，命令失败不会成为未处理异常 */
    private command(id: string, name: string, callback: () => Promise<void> | void): void {
        this.plugin.addCommand({ id, name, callback: () => { if (this.alive) void Promise.resolve().then(callback).catch(report); } });
    }
    /** 当前活动文档必须是普通 Markdown */
    private active(): MarkdownView {
        // 不把自定义阅读器或其他插件视图当成可写文章。
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) throw new Error("请先打开普通 Markdown 文章");
        return view;
    }
    /** 原生阅读视图上的临时学习会话，不对正文进行额外渲染 */
    async toggle(): Promise<void> {
        this.host.prune();
        // 每次命令只针对用户当前叶子视图。
        const view = this.active();
        if (this.host.sessions.has(view)) { this.host.stop(view); new Notice("已退出 Language Leaf 学习模式"); return; }
        await this.enter(view);
    }
    /** 原打开阅读命令使用幂等入口，重复打开不会反向退出学习模式 */
    async enter(view: MarkdownView): Promise<void> {
        // 同一标签切换文章后先清理旧会话，避免文件打开事件稍后到达时误取消本次进入。
        this.host.prune();
        if (!view.file || this.host.sessions.has(view)) return;
        // 先记录原视图和文件对象，异步切换结束后再次校验。
        const file = view.file;
        // 恢复时回到用户原来的编辑模式。
        const mode = view.getMode();
        if (mode !== "preview") await view.setState({ ...view.getState(), mode: "preview" }, { history: false });
        if (!this.alive || view.file !== file || this.host.sessions.has(view)) return;
        // 每个叶子独立随机会话身份，用于失效旧请求。
        const token = newId();
        // Shift 的默认扩选不进入原生拖选流程，需要按当前拖动坐标更新原生 Selection。
        let drag: { caret: TextCaret; pointer: number } | null = null;
        // 释放当前手势，不让关闭文章后残留鼠标捕获。
        const releaseDrag = (): void => {
            if (drag && view.containerEl.hasPointerCapture?.(drag.pointer)) view.containerEl.releasePointerCapture(drag.pointer);
            drag = null;
        };
        // 监听只绑定当前视图，不再全局拦截所有笔记的选择。
        const pointerup = (event: PointerEvent): void => {
            if (drag?.pointer === event.pointerId) {
                extendShiftSelection(event, view.contentEl, drag.caret); releaseDrag();
            }
        };
        // 在浏览器执行 Shift 扩选前，将锚点定位到本次拖选起点。
        const pointerdown = (event: PointerEvent): void => {
            releaseDrag();
            // 其他修饰键完全沿用浏览器的拖选行为。
            const caret = resetShiftSelection(event, view.contentEl, this.host.settings.modifier);
            if (!caret) return;
            drag = { caret, pointer: event.pointerId };
            event.preventDefault();
            this.plugin.app.workspace.setActiveLeaf(view.leaf, { focus: false });
            if (event.isTrusted) view.containerEl.setPointerCapture(event.pointerId);
        };
        // 浏览器仅提供坐标定位，文本高亮继续使用原生 Selection。
        const pointermove = (event: PointerEvent): void => {
            if (drag?.pointer !== event.pointerId || !(event.buttons & 1)) return;
            extendShiftSelection(event, view.contentEl, drag.caret); event.preventDefault();
        };
        view.containerEl.addEventListener("pointerdown", pointerdown, true);
        view.containerEl.addEventListener("pointermove", pointermove);
        view.containerEl.addEventListener("pointercancel", releaseDrag);
        view.containerEl.addEventListener("pointerup", pointerup);
        const stopWatchingMode = watchReadingMode(view, () => this.host.prune());
        const selectionQuery = installSelectionQuery(view.contentEl, {
            active: () => this.alive && view.getMode() === "preview" && this.host.sessions.get(view)?.token === token && view.file === file && this.plugin.app.workspace.getActiveViewOfType(MarkdownView) === view,
            modifier: () => this.host.settings.modifier,
            autoQuery: () => this.host.settings.autoQuerySelection,
            query: () => { void this.queryActive(view).catch(report); }
        });
        view.containerEl.addClass("lingualeaf-reading");
        this.host.sessions.set(view, { view, file, mode, token, selection: selectionQuery.selection, dispose: () => {
            releaseDrag(); selectionQuery.dispose(); stopWatchingMode();
            view.containerEl.removeEventListener("pointermove", pointermove);
            view.containerEl.removeEventListener("pointercancel", releaseDrag);
            view.containerEl.removeEventListener("pointerdown", pointerdown, true);
            view.containerEl.removeEventListener("pointerup", pointerup);
        } });
        this.plugin.refreshReadingActions();
        new Notice(this.host.settings.autoQuerySelection ? "Language Leaf 学习模式已开启：划选词句后自动查词；切换到编辑视图或关闭文档时退出" : `Language Leaf 学习模式已开启：按住 ${this.host.settings.modifier.replace("Key", "")} 划词，或选中文字后点“查词”；切换到编辑视图或关闭文档时退出`);
    }
    /** 读取所属窗口选区，拒绝跨段、翻译、代码和插件浮层 */
    async queryActive(view = this.active()): Promise<void> {
        this.host.prune();
        const session = this.host.sessions.get(view);
        if (!session) throw new Error("请先开启当前文档学习模式");
        const selected = session.selection ? session.selection() : readingSelection(view.contentEl);
        if (!selected) throw new Error("请在普通正文的同一段落内选择 1—500 个字符，代码、翻译和嵌入内容暂不支持");
        await this.query(view, selected.text, selected.paragraph.textContent || "");
    }
    /** 把来源和上下文冻结到表单，并检查查询结束时会话仍有效 */
    private async query(view: MarkdownView, selected: string, paragraph?: string): Promise<void> {
        this.host.prune();
        // 查询不允许后台叶子接收其他窗口的选区。
        const session = this.host.sessions.get(view);
        if (!session || !selected.trim() || selected.trim().length > 500) throw new Error("请在有效学习会话中选择 1—500 个字符");
        const sequence = (this.queries.get(view) || 0) + 1;
        this.queries.set(view, sequence);
        // 来源定位失败时不能静默关联到同文的另一处句子。
        const context = await this.host.context(session.file, selected.trim(), paragraph);
        // 切换文件或退出后不弹出延迟结果。
        const valid = (): boolean => {
            this.host.prune();
            return this.alive && this.queries.get(view) === sequence && this.host.sessions.get(view)?.token === session.token && view.file === session.file;
        };
        // 同文再次查询已收录词时载入原卡，避免把手写内容重置成空表单。
        const matches = (await this.host.scan()).filter(item => expressionKey(item.card.language, item.card.text) === expressionKey(this.host.language(session.file), selected));
        // 同文编辑复用卡片身份，跨文只复用共享词条的管理字段。
        const existing = matches.find(item => item.path === session.file.path);
        if (valid()) await this.openCapture(session.file, selected.trim(), context, valid, existing?.card, matches[0]?.card);
    }
    /** 使用原查词和新词 Vue 面板呈现查询，不创建独立收录弹窗 */
    async openCapture(file: TFile, selected: string, context: ArticleContext, valid: () => boolean, existing?: LeafCard, seed?: LeafCard, showSearch = true, isEdit = false): Promise<void> {
        // 在激活面板前冻结来源，右侧表单始终保存到该文件。
        const card: LeafCard = existing || { id: newId(), expressionId: seed?.expressionId || newId(),
            text: selected, language: this.host.language(file), meaning: seed?.meaning || "", kind: /\s/.test(selected) ? "phrase" : "word",
            ...context, notes: "", tags: seed?.tags || [], owner: "spaced-repetition" };
        // 按规范化表达统计，单纯查词并不增加历史计数。
        const indexed = (await this.host.scan()).find(item => expressionKey(item.card.language, item.card.text) === expressionKey(card.language, card.text));
        // 唯一请求身份隔离快速连续查询和旧表单提交。
        const request: PanelCapture = { id: newId(), file, context, card, isEdit, captureCount: indexed?.captureCount || 0, model: cardToForm(card, file.basename), valid };
        this.capture = request;
        if (showSearch) await this.plugin.activateView(SEARCH_PANEL_VIEW, "left");
        await this.plugin.activateView(LEARN_PANEL_VIEW, "right");
        if (this.capture !== request || !valid()) return;
        // 等待原组件挂载后沿用相同查询事件、词典配置和历史机制。
        window.dispatchEvent(new CustomEvent("obsidian-langr-search", { detail: { selection: selected, leafCapture: request } }));
        if (selected.trim() && card.language.startsWith("en") && this.plugin.settings.auto_pron) {
            // 沿用原插件的口音设置和播放方法。
            const { playAudio } = await import("../utils/helpers");
            playAudio(`https://dict.youdao.com/dictvoice?type=${this.plugin.settings.review_prons}&audio=${encodeURIComponent(selected)}`);
        }
    }
    /** 从原单词列表定位到右侧编辑表单，卡片身份和 SR 进度保持不变 */
    async editCard(path: string, card: LeafCard): Promise<void> {
        // 来源删除后禁止把编辑内容写到当前活动文章。
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("来源文章已删除");
        await this.openCapture(file, card.text, { sentence: card.sentence, translation: card.translation, outline: card.outline, anchor: card.anchor },
            () => this.alive && this.plugin.app.vault.getAbstractFileByPath(file.path) === file, card, undefined, true, true);
    }
    /** 手工收词仍须绑定一篇文章，所有内容最终保存为随文 SR 闪卡 */
    async openNewWordPanel(): Promise<void> {
        // 侧栏操作时，使用最近的 Markdown 标签确定保存文章。
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView) || this.plugin.app.workspace.getMostRecentLeaf()?.view;
        if (!(view instanceof MarkdownView) || !view.file) {
            this.capture = undefined;
            await this.plugin.activateView(LEARN_PANEL_VIEW, "right");
            window.dispatchEvent(new CustomEvent("lingualeaf-clear-capture"));
            return;
        }
        // 不要求正文中已经有这个词；手工录入的语境由用户填写。
        const file = view.file;
        // 大纲来自指定文章，不能因打开右侧栏改变来源。
        const outline = this.host.outline(await this.plugin.app.vault.read(file));
        await this.openCapture(file, "", { sentence: "", translation: "", anchor: "", outline },
            () => this.alive && this.plugin.app.vault.getAbstractFileByPath(file.path) === file, undefined, undefined, false);
    }
    /** 新词表单提交后只对来源文章的目标 SR 闪卡做增量更新 */
    async saveCapture(request: PanelCapture, model: ExpressionInfo, outline: string): Promise<void> {
        if (this.capture?.id !== request.id || !request.valid() || !this.alive) throw new Error("来源文章已关闭或查询已改变，请重新选择");
        await this.host.save(request.file, formToCard(request.card, model, outline), request.isEdit ? undefined : request.id);
        // 当前面板同步显示最新累计次数，继续编辑不重复增加。
        request.captureCount = (await this.host.scan()).find(item => expressionKey(item.card.language, item.card.text) === expressionKey(request.card.language, model.expression))?.captureCount || 0;
        // 保存完成后刷新原有单词列表。
        window.dispatchEvent(new CustomEvent("obsidian-langr-refresh", { detail: { expression: model.expression, type: model.t } }));
        new Notice("已保存到本文闪卡，现有复习进度已保留");
    }
    /** 卸载插件时关闭当前文章会话 */
    unload(): void { this.alive = false; this.host.onSessionChange = undefined; this.host.dispose(); }
}
