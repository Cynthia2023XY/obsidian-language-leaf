import { describe, it, expect, vi } from "vitest";
import { createQuickSave } from "./quick-save";

/** 通过真实 DOM 按键验证表单默认行为与快捷保存边界 */
describe("新词面板双回车保存", () => {
    it("单行输入第一次不提交，第二次才保存，长按不算连击", () => {
        // 保存入口仅记录调用，不执行磁盘写入。
        const save = vi.fn();
        // 绑定面板捕获监听，与 Vue 面板事件顺序一致。
        const shortcut = createQuickSave(save);
        // 临时输入框提供真实事件目标。
        const input = document.createElement("input"); input.addEventListener("keydown", shortcut.keydown);
        // 第一次回车取消浏览器隐式提交。
        const first = new KeyboardEvent("keydown", { key: "Enter", cancelable: true }); input.dispatchEvent(first);
        expect(first.defaultPrevented).toBe(true); expect(save).not.toHaveBeenCalled();
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); expect(save).toHaveBeenCalledTimes(1);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true })); expect(save).toHaveBeenCalledTimes(1);
    });
    it("保留文本框单次换行，排除输入法、其他输入、焦点切换和超时", () => {
        // 控制单调时钟验证时间边界。
        const time = vi.spyOn(performance, "now").mockReturnValue(100);
        // 保存副作用由 spy 观察。
        const save = vi.fn();
        // 每个表单独立记录连击状态。
        const shortcut = createQuickSave(save);
        // 原生 textarea 单次回车应保留换行默认行为。
        const input = document.createElement("textarea"); input.addEventListener("keydown", shortcut.keydown);
        // 首次回车仍可换行。
        const first = new KeyboardEvent("keydown", { key: "Enter", cancelable: true }); input.dispatchEvent(first); expect(first.defaultPrevented).toBe(false);
        time.mockReturnValue(600); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); expect(save).not.toHaveBeenCalled();
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); expect(save).not.toHaveBeenCalled();
        shortcut.input(new InputEvent("input", { inputType: "insertText" }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); expect(save).not.toHaveBeenCalled();
        shortcut.reset(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); expect(save).not.toHaveBeenCalled();
        shortcut.input(new InputEvent("input", { inputType: "insertLineBreak" }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); expect(save).toHaveBeenCalledTimes(1);
        time.mockRestore();
    });
    it("标签下拉框的回车不触发保存", () => {
        // 标签回车仍用于确认候选。
        const save = vi.fn();
        // 组件组合框通过角色识别。
        const input = document.createElement("input"); input.setAttribute("role", "combobox");
        // 不依赖组件库私有事件实现。
        const shortcut = createQuickSave(save); input.addEventListener("keydown", shortcut.keydown);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        expect(save).not.toHaveBeenCalled();
    });
});
