import { describe, expect, it, vi } from "vitest";
import { LinguaLeafRuntime } from "./runtime";
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
