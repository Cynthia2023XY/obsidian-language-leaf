import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSelectionQuery } from "./selection-query";

/** 验证选区事件协议，物理三指手势仍须由真实触控板验收。 */
describe("正文选区查询入口", () => {
    let dispose: () => void;
    const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 20, right: 120, top: 20, bottom: 40 }) });
    });
    afterEach(() => { dispose?.(); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); if (originalRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRect); else delete (Range.prototype as any).getBoundingClientRect; vi.restoreAllMocks(); vi.useRealTimers(); });
    function setup(markup = "<p>An old bookmark.</p>", auto = false) {
        const content = document.createElement("div"); content.innerHTML = markup; document.body.append(content);
        const query = vi.fn(); let active = true; let automatic = auto;
        const controller = installSelectionQuery(content, { active: () => active, modifier: () => "altKey", autoQuery: () => automatic, query });
        dispose = controller.dispose;
        const paragraph = content.querySelector("p")!;
        const select = () => {
            const range = document.createRange(); range.selectNodeContents(paragraph);
            document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
            document.dispatchEvent(new Event("selectionchange"));
        };
        const up = (altKey = false) => paragraph.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, altKey }));
        return { content, query, paragraph, select, up, controller, setAutomatic: (value: boolean) => { automatic = value; }, deactivate: () => { active = false; }, button: document.querySelector(".ll-selection-query") as HTMLButtonElement };
    }
    it("开启自动查询时普通拖选等松手后查询一次，拖动中不查询", () => {
        const s = setup(undefined, true);
        s.paragraph.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1 }));
        s.select(); vi.advanceTimersByTime(1000); expect(s.query).not.toHaveBeenCalled();
        s.up(); vi.advanceTimersByTime(180); expect(s.query).toHaveBeenCalledTimes(1);
        document.dispatchEvent(new Event("selectionchange")); vi.runAllTimers(); expect(s.query).toHaveBeenCalledTimes(1);
    });
    it("没有指针事件的三指选区稳定后查询，连续变化只查最终选区", () => {
        const s = setup(undefined, true); s.select(); vi.advanceTimersByTime(300);
        const range = document.createRange(); range.setStart(s.paragraph.firstChild!, 3); range.setEnd(s.paragraph.firstChild!, 6);
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange")); vi.advanceTimersByTime(449); expect(s.query).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1); expect(s.query).toHaveBeenCalledTimes(1); expect(s.controller.selection()?.text).toBe("old");
    });
    it("打开命令面板后不在输入搜索词时自动弹出学习面板", () => {
        const s = setup(undefined, true); s.select();
        const prompt = document.createElement("div"); prompt.className = "prompt";
        const input = document.createElement("input"); prompt.append(input); document.body.append(prompt); input.focus();
        vi.runAllTimers(); expect(s.query).not.toHaveBeenCalled();
        expect(s.controller.selection()?.text).toBe("An old bookmark.");
    });
    it("关闭自动开关或退出时取消等待中的查询", () => {
        const s = setup(undefined, true); s.select(); s.setAutomatic(false); vi.runAllTimers(); expect(s.query).not.toHaveBeenCalled();
        s.setAutomatic(true); s.select(); s.deactivate(); vi.runAllTimers(); expect(s.query).not.toHaveBeenCalled();
    });
    it("命令面板打开后恢复选区，点击侧栏后不再使用旧选区", () => {
        const s = setup(); s.select(); vi.runAllTimers();
        const prompt = document.createElement("div"); prompt.className = "prompt";
        const input = document.createElement("input"); prompt.append(input); document.body.append(prompt);
        input.focus(); document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event("selectionchange"));
        input.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        expect(s.controller.selection()?.text).toBe("An old bookmark.");
        const sidebar = document.createElement("input"); document.body.append(sidebar);
        sidebar.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        expect(s.controller.selection()).toBeNull();
    });
    it("无效新选区、正文改动或退出不能恢复旧缓存", () => {
        const s = setup(); s.select(); document.getSelection()!.removeAllRanges();
        s.paragraph.textContent = "Changed article."; expect(s.controller.selection()).toBeNull();
        s.select(); s.deactivate(); expect(s.controller.selection()).toBeNull();
    });
    it("普通选择只显示按钮，点击保留原选区并查询", () => {
        const s = setup(); s.select(); s.up(); vi.runAllTimers();
        expect(s.query).not.toHaveBeenCalled(); expect(s.button.hidden).toBe(false);
        const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true }); s.button.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true); s.button.click();
        expect(s.query).toHaveBeenCalledTimes(1); expect(document.getSelection()!.toString()).toBe("An old bookmark.");
    });
    it("Option 拖选一次查询，释放 Option 不重复查询", () => {
        const s = setup(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
        s.paragraph.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, altKey: true }));
        s.select(); s.up(true); document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" })); vi.runAllTimers();
        expect(s.query).toHaveBeenCalledTimes(1);
    });
    it("没有 pointerup 的选区变化在 Option 释放后查询", () => {
        const s = setup(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" })); s.select();
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" })); vi.runAllTimers();
        expect(s.query).toHaveBeenCalledTimes(1);
    });
    it("selectionchange 延迟到松键之后时也读取最终选区", () => {
        const s = setup(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
        const range = document.createRange(); range.selectNodeContents(s.paragraph);
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" })); vi.runAllTimers();
        document.dispatchEvent(new Event("selectionchange")); vi.runAllTimers();
        expect(s.query).toHaveBeenCalledTimes(1);
    });
    it("先释放 Option 再释放指针也只查询一次", () => {
        const s = setup(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" })); s.select();
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" })); vi.runAllTimers(); s.up(false);
        expect(s.query).toHaveBeenCalledTimes(1);
    });
    it("先选中再轻按 Option 不自动查询，侧栏点击不查询旧选区", () => {
        const s = setup(); s.select(); vi.runAllTimers();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" })); document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
        document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, altKey: true })); vi.runAllTimers();
        expect(s.query).not.toHaveBeenCalled();
    });
    it.each(["<blockquote><p>Translation.</p></blockquote>", "<p>First.</p><p>Second.</p>", "<p>Text <code>code</code></p>"])("无效选区不显示按钮也不查询：%s", markup => {
        const s = setup(markup);
        const range = document.createRange(); range.selectNodeContents(s.content);
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange")); s.up(true); vi.runAllTimers();
        expect(s.button.hidden).toBe(true); expect(s.query).not.toHaveBeenCalled();
    });
    it("退出会话与销毁后无残留按钮和延迟查询", () => {
        const s = setup(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" })); s.select();
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" })); s.deactivate(); vi.runAllTimers();
        expect(s.query).not.toHaveBeenCalled(); expect(s.button.hidden).toBe(true);
        dispose(); document.dispatchEvent(new Event("selectionchange")); s.up(true); vi.runAllTimers();
        expect(document.querySelector(".ll-selection-query")).toBeNull(); expect(s.query).not.toHaveBeenCalled();
    });
});
