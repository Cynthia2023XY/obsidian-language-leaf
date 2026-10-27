import { describe, it, expect, vi } from "vitest";
import { Platform } from "obsidian";
import { createQuickSave, installQuickSaveScope } from "./quick-save";

/** 通过 DOM 事件检查平台快捷键与表单边界。 */
describe("新词面板 Mod+Enter 保存", () => {
    it("默认平台使用 Obsidian 标识，Mac 提示和行为均为 Command Enter", () => {
        const previous = Platform.isMacOS;
        try {
            (Platform as any).isMacOS = true;
            const save = vi.fn(); const shortcut = createQuickSave(save);
            expect(shortcut.label).toBe("⌘ Enter");
            shortcut.keydown(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true })); expect(save).not.toHaveBeenCalled();
            shortcut.keydown(new KeyboardEvent("keydown", { key: "Enter", metaKey: true })); expect(save).toHaveBeenCalledTimes(1);
            (Platform as any).isMacOS = false; expect(createQuickSave(save).label).toBe("Ctrl Enter");
        } finally { (Platform as any).isMacOS = previous; }
    });
    it.each([true, false])("各平台在所有字段、按钮和下拉框均可保存：mac=%s", mac => {
        for (const tag of ["input", "textarea", "button", "select"]) {
            const save = vi.fn(); const shortcut = createQuickSave(save, mac);
            const field = document.createElement(tag);
            if (tag === "input") field.setAttribute("role", "combobox");
            field.addEventListener("keydown", shortcut.keydown);
            const event = new KeyboardEvent("keydown", { key: "Enter", metaKey: mac, ctrlKey: !mac, cancelable: true });
            field.dispatchEvent(event);
            expect(save).toHaveBeenCalledTimes(1); expect(event.defaultPrevented).toBe(true);
        }
    });
    it("普通 Enter 连按也不保存，多行字段仍可换行，标签仍可确认", () => {
        const save = vi.fn(); const shortcut = createQuickSave(save, true);
        for (const tag of ["input", "textarea"]) {
            const field = document.createElement(tag); field.addEventListener("keydown", shortcut.keydown);
            for (let i = 0; i < 2; i++) {
                const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true }); field.dispatchEvent(event);
                expect(event.defaultPrevented).toBe(tag === "input");
            }
        }
        const combo = document.createElement("input"); combo.setAttribute("role", "combobox"); combo.addEventListener("keydown", shortcut.keydown);
        const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true }); combo.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(false); expect(save).not.toHaveBeenCalled();
    });
    it("排除输入法、长按、不属于当前平台及额外修饰键", () => {
        const save = vi.fn(); const shortcut = createQuickSave(save, true);
        for (const init of [{ metaKey: true, isComposing: true }, { metaKey: true, repeat: true }, { ctrlKey: true }, { metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }]) {
            shortcut.keydown(new KeyboardEvent("keydown", { key: "Enter", ...init }));
        }
        expect(save).not.toHaveBeenCalled();
    });
    it("Mac 上 Control Enter 不保存且阻止隐式表单提交", () => {
        const save = vi.fn(); const shortcut = createQuickSave(save, true);
        const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true });
        shortcut.keydown(event);
        expect(save).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(true);
    });
    it("宿主快捷键优先保存面板内表单，面板外不拦截，关闭后注销", () => {
        const previous = Platform.isMacOS;
        const content = document.createElement("div"); const input = document.createElement("input"); content.append(input);
        const save = vi.fn();
        let receive: (event: KeyboardEvent) => unknown = () => {};
        const handler = {};
        const scope = {
            register: vi.fn((_modifiers, _key, listener) => { receive = listener; return handler; }),
            unregister: vi.fn(),
        };
        try {
            (Platform as any).isMacOS = true;
            const stop = installQuickSaveScope(scope as any, content, save);
            expect(scope.register).toHaveBeenCalledWith(["Mod"], "Enter", expect.any(Function));
            const event = new KeyboardEvent("keydown", { key: "Enter", metaKey: true, cancelable: true });
            input.addEventListener("keydown", event => { expect(receive(event)).toBe(false); });
            input.dispatchEvent(event);
            expect(save).toHaveBeenCalledTimes(1); expect(event.defaultPrevented).toBe(true);
            const outside = new KeyboardEvent("keydown", { key: "Enter", metaKey: true, cancelable: true });
            const other = document.createElement("input"); other.addEventListener("keydown", receive); other.dispatchEvent(outside);
            expect(save).toHaveBeenCalledTimes(1); expect(outside.defaultPrevented).toBe(false);
            stop(); expect(scope.unregister).toHaveBeenCalledWith(handler);
        } finally { (Platform as any).isMacOS = previous; }
    });
});
