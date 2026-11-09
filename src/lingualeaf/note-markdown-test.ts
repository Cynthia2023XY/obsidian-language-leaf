import { beforeAll, describe, expect, it, vi } from "vitest";
import { Component, MarkdownRenderer } from "obsidian";
import type { App } from "obsidian";
import { normalizeNoteLineBreaks, renderNoteMarkdown } from "./note-markdown";

vi.mock("obsidian", () => ({
    /** 只隔离宿主生命周期，不在单测中伪造 Markdown 解析器 */
    Component: vi.fn(class {
        /** 记录渲染作用域初始化 */
        load = vi.fn();
        /** 记录离开卡片后的资源释放 */
        unload = vi.fn();
    }),
    /** 宿主渲染是外部边界，验证原文和来源原样交付 */
    MarkdownRenderer: { render: vi.fn().mockResolvedValue(undefined) },
}));

beforeAll(() => {
    // 复用宿主元素的最小创建接口。
    HTMLElement.prototype.createDiv = function(options: { cls: string }) {
        // 每个渲染实例拥有自己的容器。
        const element = document.createElement("div");
        element.className = options.cls; this.append(element); return element;
    } as typeof HTMLElement.prototype.createDiv;
    HTMLElement.prototype.empty = function() { this.replaceChildren(); };
});

describe("学习笔记 Markdown 宿主适配", () => {
    it("普通换行不重复占行，段落与代码的原有结构保留", () => {
        // 模拟宿主的 br 加排版换行输出，不在测试中实现 Markdown 解析。
        const container = document.createElement("div");
        container.innerHTML = "<p><strong>exhaust</strong> 耗尽<br>\n<strong>exhaustive</strong> 详尽的</p><p>本义<br>\n详尽无遗。</p><pre><code>第一行\n\n第二行</code></pre>";
        normalizeNoteLineBreaks(container);
        expect(container.querySelectorAll("p")).toHaveLength(2);
        expect(container.querySelectorAll("br")).toHaveLength(2);
        expect(container.querySelectorAll("strong")).toHaveLength(2);
        expect(container.querySelector("p")?.innerHTML).toBe("<strong>exhaust</strong> 耗尽<br><strong>exhaustive</strong> 详尽的");
        expect(container.querySelector("code")?.textContent).toBe("第一行\n\n第二行");
    });
    it("宿主只输出文本换行时保留原换行和空行", () => {
        // 不同宿主设置下可能不输出显式 br，此时交给 pre-wrap 保留原文。
        const container = document.createElement("div");
        container.innerHTML = "<p>第一行\n第二行\n\n第四行</p>";
        normalizeNoteLineBreaks(container);
        expect(container.textContent).toBe("第一行\n第二行\n\n第四行");
    });
    it("原样传递语法、换行和来源，离开展示后清理资源", async () => {
        // 加粗、双反引号、代码围栏与空行均不预先做 HTML 替换。
        const text = "**重点** 与 ``a ` b``\n\n```js\nconst answer = 42;\n```";
        // 最小宿主对象用于校验调用参数。
        const app = {} as App;
        // 独立笔记容器模拟复习正文。
        const parent = document.createElement("div");
        // 清理入口由弹窗或 Vue 卸载时调用。
        const dispose = renderNoteMarkdown(app, text, parent, "文章/example.md");
        await Promise.resolve();
        expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(app, text, parent.firstElementChild, "文章/example.md", expect.anything());
        expect(parent.firstElementChild?.classList.contains("markdown-rendered")).toBe(true);
        // 渲染作用域由宿主提供，并在离开时卸载。
        const scope = vi.mocked(Component).mock.results.at(-1)!.value;
        expect(scope.load).toHaveBeenCalledOnce();
        dispose();
        expect(scope.unload).toHaveBeenCalled();
        expect(parent.childElementCount).toBe(0);
    });
    it("快速换卡时不启动已取消的渲染", async () => {
        vi.mocked(MarkdownRenderer.render).mockClear();
        // 未完成的旧任务不能在换卡后继续创建宿主组件。
        const dispose = renderNoteMarkdown({} as App, "旧卡笔记", document.createElement("div"), "旧文章.md");
        dispose();
        await Promise.resolve();
        expect(MarkdownRenderer.render).not.toHaveBeenCalled();
    });
});
