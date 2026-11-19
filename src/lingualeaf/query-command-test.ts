import { describe, expect, it, vi } from "vitest";
import { MarkdownView, Menu } from "obsidian";
import { LinguaLeafRuntime } from "./runtime";
import { parseCards, renderCard } from "./article";
import { formToCard } from "./panel-model";
import type { LeafCard } from "./domain";
import { readSettings } from "./config";

// 面板组件不参与命令注册与可见性测试。
vi.mock("../views/DataPanelView", () => ({ DATA_PANEL_VIEW: "data" }));
vi.mock("../views/SearchPanelView", () => ({ SEARCH_PANEL_VIEW: "search" }));
vi.mock("../views/LearnPanelView", () => ({ LEARN_PANEL_VIEW: "learn" }));
vi.mock("obsidian", () => ({ MarkdownView: class {}, Menu: { forEvent: vi.fn() }, Notice: class {}, normalizePath: (path: string) => path }));

describe("查询命令可发现性", () => {
    it("没有学习会话或选区也注册普通可见命令，不要求预先绑定快捷键", async () => {
        const commands: any[] = [];
        const plugin = { settings: readSettings(null), addCommand: (command: any) => commands.push(command), registerEvent: vi.fn(), registerDomEvent: vi.fn(), app: { vault: { on: vi.fn() }, workspace: { on: vi.fn(), onLayoutReady: vi.fn() } } };
        const runtime = new LinguaLeafRuntime(plugin as any);
        const query = vi.spyOn(runtime, "queryActive").mockResolvedValue(undefined);
        runtime.load();
        const command = commands.find(command => command.id === "leaf-query-selection");
        expect(command.name).toBe("查询选中的词句");
        expect(command.checkCallback).toBeUndefined(); expect(command.callback).toBeTypeOf("function");
        command.callback(); await Promise.resolve(); await Promise.resolve(); expect(query).toHaveBeenCalledTimes(1);
    });
});

describe("关闭学习模式时的右键查词", () => {
    function fixture(mode: "source" | "preview") {
        const file = { path: "Article.md", basename: "Article" };
        const contentEl = document.createElement("div");
        contentEl.innerHTML = '<div class="markdown-preview-view"><p>A leaf fell.</p></div>';
        const view = Object.assign(new (MarkdownView as any)(), { file, contentEl, getMode: () => mode });
        const items: { label: string; click: () => void }[] = [];
        const menu = { addItem: (build: (item: any) => void) => {
            const entry = { label: "", click: () => {} };
            const item = { setTitle(label: string) { entry.label = label; return this; }, setIcon() { return this; },
                setSection() { return this; }, onClick(click: () => void) { entry.click = click; return this; } };
            build(item);
            items.push(entry);
        } };
        const docEvents = vi.fn();
        const workspaceEvents = vi.fn();
        const plugin = { settings: readSettings({ auto_pron: false, learning: { shortSentenceThreshold: 0 } }), addCommand: vi.fn(), registerEvent: vi.fn(),
            registerDomEvent: docEvents, activateView: vi.fn().mockResolvedValue(undefined),
            app: { vault: { on: vi.fn(), read: async () => "A leaf fell." },
                workspace: { on: workspaceEvents, onLayoutReady: vi.fn(), getLeavesOfType: () => [{ view }], getActiveViewOfType: () => view } } };
        const runtime = new LinguaLeafRuntime(plugin as any);
        vi.spyOn(runtime.host, "language").mockReturnValue("en");
        vi.spyOn(runtime.host, "scan").mockResolvedValue([]);
        runtime.load();
        const runLookupCommand = () => plugin.addCommand.mock.calls
            .find(([command]) => command.id === "leaf-query-selection")![0].callback();
        return { runtime, contentEl, view, menu, items, docEvents, workspaceEvents, runLookupCommand };
    }

    it("编辑视图通过 Obsidian 菜单查询菜单打开时的选区", async () => {
        const setup = fixture("source");
        const handle = setup.workspaceEvents.mock.calls.find(([event]) => event === "editor-menu")![1];
        const editor = {
            getSelection: vi.fn().mockReturnValue(""),
            getValue: () => "A leaf fell.",
            getCursor: (side: string) => side,
            posToOffset: (side: string) => side === "from" ? 2 : 6,
        };
        handle(setup.menu, editor, setup.view);
        expect(setup.items).toHaveLength(0);
        editor.getSelection.mockReturnValue("leaf");
        handle(setup.menu, editor, setup.view);
        editor.getSelection.mockReturnValue("");
        expect(setup.items[0]?.label).toBe("Language Leaf 查词");
        setup.items[0].click();
        await vi.waitFor(() => expect(setup.runtime.capture?.model.expression).toBe("leaf"));
        expect(setup.runtime.host.sessions.has(setup.view)).toBe(false);
    });

    it.each(["A different leaf fell.", "A leaf fell."])("从编辑器位置读取重复词所在段落及译文：%s", async sentence => {
        const setup = fixture("source");
        const handle = setup.workspaceEvents.mock.calls.find(([event]) => event === "editor-menu")![1];
        const source = ["A leaf fell.", "> [!translation]\n> 第一段。", sentence, "> [!translation]\n> 第二段。"].join("\n\n");
        const offset = source.lastIndexOf("leaf");
        const editor = {
            getSelection: () => "leaf",
            getValue: vi.fn().mockReturnValue(source),
            getCursor: (side: string) => side,
            posToOffset: (side: string) => side === "from" ? offset : offset + 4,
        };
        handle(setup.menu, editor, setup.view);
        editor.getValue.mockReturnValue("The buffer changed.");
        setup.items[0].click();
        await vi.waitFor(() => expect(setup.runtime.capture?.context).toMatchObject({
            location: "confirmed", anchor: sentence, translation: "第二段。",
        }));
    });

    it("编辑器选区跨越两个段落时仍查词，并保留选区快照", async () => {
        const setup = fixture("source");
        const handle = setup.workspaceEvents.mock.calls.find(([event]) => event === "editor-menu")![1];
        const source = "A leaf fell.\n\nAnother leaf.";
        const selected = "fell.\n\nAnother";
        const offset = source.indexOf(selected);
        handle(setup.menu, {
            getSelection: () => selected,
            getValue: () => source,
            getCursor: (side: string) => side,
            posToOffset: (side: string) => side === "from" ? offset : offset + selected.length,
        }, setup.view);
        setup.items[0].click();
        await vi.waitFor(() => expect(setup.runtime.capture?.context).toMatchObject({
            location: "snapshot", sentence: selected, translation: "",
        }));
    });

    it("普通编辑视图可从命令面板查词并按选区位置取例句", async () => {
        const setup = fixture("source");
        const source = "A leaf fell.\n\nHe saw a leaf.";
        const offset = source.lastIndexOf("leaf");
        setup.view.editor = {
            getSelection: () => "leaf",
            getValue: () => source,
            getCursor: (side: string) => side,
            posToOffset: (side: string) => side === "from" ? offset : offset + 4,
        };
        setup.runLookupCommand();
        await vi.waitFor(() => expect(setup.runtime.capture?.context).toMatchObject({
            location: "confirmed", sentence: "He saw a leaf.",
        }));
        expect(setup.runtime.host.sessions.has(setup.view)).toBe(false);
    });

    it.each(["右键菜单", "命令面板"])("普通阅读视图可通过%s查询正文选区", async entry => {
        const setup = fixture("preview");
        vi.mocked(Menu.forEvent).mockReturnValue(setup.menu as any);
        document.body.append(setup.contentEl);
        const paragraph = setup.contentEl.querySelector("p")!;
        const range = document.createRange();
        range.setStart(paragraph.firstChild!, 2);
        range.setEnd(paragraph.firstChild!, 6);
        document.getSelection()!.addRange(range);
        try {
            if (entry === "右键菜单") {
                const handle = setup.docEvents.mock.calls.find(([, event]) => event === "contextmenu")![2];
                handle({ target: paragraph, defaultPrevented: false });
                expect(setup.items.map(item => item.label)).toContain("Language Leaf 查词");
                document.getSelection()!.removeAllRanges();
                setup.items[0].click();
            } else {
                setup.runLookupCommand();
            }
            await vi.waitFor(() => expect(setup.runtime.capture?.model.expression).toBe("leaf"));
            expect(setup.runtime.capture?.context.sentence).toBe("A leaf fell.");
        } finally {
            document.getSelection()!.removeAllRanges();
            setup.contentEl.remove();
        }
    });
});

/** 使用真实面板请求入口，覆盖重复划词到可保存表单的完整数据流。 */
describe("重复收录例句传入学习面板", () => {
    const previous: LeafCard = { id: "card-1", expressionId: "expression-1", text: "leaf", language: "en", kind: "word", meaning: "叶子", sentence: "An old leaf.", translation: "旧叶子。", outline: "旧大纲", anchor: "An old leaf.", notes: "手写笔记", tags: ["植物"], owner: "builtin" };
    const context = { sentence: "A new leaf.\n\nMore context.", translation: "新叶子。\n\n更多上下文。", outline: "新大纲", anchor: "A new leaf." };
    function setup(card = previous) {
        const plugin = { settings: readSettings({ auto_pron: false }), activateView: vi.fn().mockResolvedValue(undefined), app: {} };
        const runtime = new LinguaLeafRuntime(plugin as any);
        vi.spyOn(runtime.host, "scan").mockResolvedValue([{ path: "Article.md", card, captureCount: 2 }]);
        vi.spyOn(runtime.host, "language").mockReturnValue("en");
        return { runtime, file: { path: "Article.md", basename: "Article" } as any };
    }
    it.each(["leaf", "turn over"])("再次收录 %s 时优先带入新上下文，保留旧例句和管理字段", async text => {
        const old = { ...previous, text, kind: text.includes(" ") ? "phrase" as const : "word" as const };
        const { runtime, file } = setup(old);
        await runtime.openCapture(file, text, context, () => true, old);
        const request = runtime.capture!;
        expect(request.model.sentences).toEqual([{ text: context.sentence, trans: context.translation, origin: "Article" }, { text: old.sentence, trans: old.translation, origin: "Article" }]);
        expect(request.model).toMatchObject({ expression: text, meaning: old.meaning, notes: [old.notes], tags: old.tags });
        expect(request.card).toMatchObject({ id: old.id, expressionId: old.expressionId, owner: old.owner, anchor: context.anchor });
        expect(request.captureCount).toBe(2);
        const saved = parseCards(renderCard(formToCard(request.card, request.model, context.outline), "?"), "?")[0].card;
        expect(saved.sentences).toEqual(request.model.sentences);
        expect(old.sentence).toBe("An old leaf.");
    });
    it("重复选择已有例句不重复添加，保留手填译文且不污染旧卡", async () => {
        const old = { ...previous, sentences: [{ text: context.sentence, trans: "手填译文", origin: "手填出处" }, { text: previous.sentence, trans: previous.translation, origin: "Article" }] };
        const { runtime, file } = setup(old);
        await runtime.openCapture(file, "leaf", { ...context, sentence: context.sentence.replace(/\n\n/g, " "), translation: "" }, () => true, old);
        expect(runtime.capture!.model.sentences).toHaveLength(2);
        expect(runtime.capture!.model.sentences[0]).toMatchObject({ trans: "手填译文", origin: "手填出处" });
        runtime.capture!.model.sentences[1].text = "Edited";
        expect(old.sentences[1].text).toBe(previous.sentence);
    });
    it("跨文章再次收录使用当前文章例句，仅复用共享词条身份与释义", async () => {
        const { runtime, file } = setup();
        await runtime.openCapture(file, "leaf", context, () => true, undefined, previous);
        expect(runtime.capture!.model.sentences).toEqual([{ text: context.sentence, trans: context.translation, origin: "Article" }]);
        expect(runtime.capture!.card.expressionId).toBe(previous.expressionId);
        expect(runtime.capture!.card.id).not.toBe(previous.id);
        expect(runtime.capture!.model.meaning).toBe(previous.meaning);
    });
    it("旧卡无例句时仍带入当前例句，编辑模式不添加查询上下文", async () => {
        const old = { ...previous, sentence: "", translation: "", sentences: [] };
        const { runtime, file } = setup(old);
        await runtime.openCapture(file, "leaf", context, () => true, old);
        expect(runtime.capture!.model.sentences[0].text).toBe(context.sentence);
        await runtime.openCapture(file, "leaf", context, () => true, previous, undefined, false, true);
        expect(runtime.capture!.model.sentences.map(entry => entry.text)).toEqual([previous.sentence]);
        expect(runtime.capture!.isEdit).toBe(true);
    });
    it.each(["leaf", "turn over"])("手工再次收录 %s 时保存到同篇旧卡并保留历史例句", async text => {
        const old = { ...previous, text, kind: text.includes(" ") ? "phrase" as const : "word" as const };
        const { runtime, file } = setup(old);
        const save = vi.spyOn(runtime.host, "save").mockResolvedValue(undefined);
        await runtime.openCapture(file, "", { sentence: "", translation: "", outline: "", anchor: "" }, () => true, undefined, undefined, false);
        const request = runtime.capture!;
        const entered = { ...request.model, expression: text, meaning: old.meaning, t: old.kind === "phrase" ? "PHRASE" : "WORD",
            sentences: [{ text: context.sentence, trans: context.translation, origin: "Article" }] };
        await runtime.saveCapture(request, entered, "");
        expect(save).toHaveBeenCalledWith(file, expect.objectContaining({ id: old.id, notes: old.notes, tags: old.tags, sentences: [
            ...entered.sentences, { text: old.sentence, trans: old.translation, origin: "Article" },
        ] }), request.id, undefined);
    });
    it("独立学习库按来源库和文章查找旧卡，去重时保留已有译文", async () => {
        const { runtime, file } = setup();
        Object.defineProperty(runtime.host, "library", { value: {} });
        const source = { vaultId: "current", path: file.path };
        vi.spyOn(runtime.host, "source").mockReturnValue(source);
        vi.mocked(runtime.host.scan).mockResolvedValue([
            { card: { ...previous, id: "another-vault" }, path: file.path, sources: [{ ...source, vaultId: "another" }] },
            { card: previous, path: "First source.md", sources: [{ ...source, path: "First source.md" }, source], revision: 3 },
        ]);
        const save = vi.spyOn(runtime.host, "save").mockResolvedValue(undefined);
        await runtime.openCapture(file, "", { sentence: "", translation: "", outline: "", anchor: "" }, () => true);
        const request = runtime.capture!;
        const sameSentence = { text: "An  old leaf.", trans: "", origin: "" };
        await runtime.saveCapture(request, { ...request.model, expression: "leaf", meaning: previous.meaning, sentences: [sameSentence] }, "");
        expect(save).toHaveBeenCalledWith(file, expect.objectContaining({ id: previous.id, sentences: [{ ...sameSentence, trans: previous.translation, origin: "Article" }] }), request.id, 3);
    });
    it("编辑旧卡时可以显式移除例句", async () => {
        const { runtime, file } = setup();
        const save = vi.spyOn(runtime.host, "save").mockResolvedValue(undefined);
        await runtime.openCapture(file, previous.text, context, () => true, previous, undefined, false, true);
        const request = runtime.capture!;
        await runtime.saveCapture(request, { ...request.model, sentences: [] }, "");
        expect(save).toHaveBeenCalledWith(file, expect.objectContaining({ id: previous.id, sentences: [] }), undefined, undefined);
    });
});
