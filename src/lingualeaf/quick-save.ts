import { Platform } from "obsidian";

/** 面板内统一使用宿主平台的 Mod+Enter，普通回车交还字段。 */
export function createQuickSave(save: () => void, mac = Platform.isMacOS) {
    const keydown = (event: KeyboardEvent): void => {
        if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
        const target = event.target as HTMLElement | null;
        const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (mod && !event.altKey && !event.shiftKey) {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) save();
        } else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && target?.tagName === "INPUT" && !target.closest(".n-base-selection, [role=combobox]")) {
            // 单行字段不允许隐式提交，标签候选仍可用 Enter 确认。
            event.preventDefault();
        }
    };
    return { keydown, label: mac ? "⌘ Enter" : "Ctrl Enter" };
}
