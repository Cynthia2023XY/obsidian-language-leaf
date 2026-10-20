import { Notice } from "obsidian";

/** 统一呈现错误，避免异步按钮出现未处理的拒绝 */
export function report(error: unknown): void {
    console.error("[Language Leaf error]", error, error instanceof Error ? error.stack : undefined);
    new Notice(`Language Leaf：${error instanceof Error ? error.message : String(error)}`, 8000);
}
/** 运行期间禁用按钮，防止双击触发重复操作 */
export function action(parent: HTMLElement, text: string, run: () => Promise<void> | void): HTMLButtonElement {
    // 每个按钮的禁用状态只作用于自己的操作。
    const button = parent.createEl("button", { text });
    button.addEventListener("click", async () => {
        button.disabled = true;
        try { await run(); } catch (error) { report(error); } finally { button.disabled = false; }
    });
    return button;
}
