import { describe, expect, it, vi } from "vitest";
import { LinguaLeafRuntime } from "./runtime";
import { parseCards, renderCard } from "./article";
import { formToCard } from "./panel-model";
import type { LeafCard } from "./domain";
import { readSettings } from "./config";

// 面板组件不参与命令注册与可见性测试。
vi.mock("../views/DataPanelView", () => ({ DATA_PANEL_VIEW: "data" }));
vi.mock("../views/SearchPanelView", () => ({ SEARCH_PANEL_VIEW: "search" }));
vi.mock("../views/LearnPanelView", () => ({ LEARN_PANEL_VIEW: "learn" }));
vi.mock("obsidian", () => ({ MarkdownView: class {}, Notice: class {}, normalizePath: (path: string) => path }));

describe("查询命令可发现性", () => {
    it("没有学习会话或选区也注册普通可见命令，不要求预先绑定快捷键", async () => {
        const commands: any[] = [];
        const plugin = { settings: readSettings(null), addCommand: (command: any) => commands.push(command), registerEvent: vi.fn(), app: { vault: { on: vi.fn() }, workspace: { on: vi.fn(), onLayoutReady: vi.fn() } } };
        const runtime = new LinguaLeafRuntime(plugin as any);
        const query = vi.spyOn(runtime, "queryActive").mockResolvedValue(undefined);
        runtime.load();
        const command = commands.find(command => command.id === "leaf-query-selection");
        expect(command.name).toBe("查询选中的词句");
        expect(command.checkCallback).toBeUndefined(); expect(command.callback).toBeTypeOf("function");
        command.callback(); await Promise.resolve(); await Promise.resolve(); expect(query).toHaveBeenCalledTimes(1);
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
});
