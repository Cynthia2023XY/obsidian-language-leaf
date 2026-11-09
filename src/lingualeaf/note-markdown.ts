import { Component, MarkdownRenderer } from "obsidian";
import type { App } from "obsidian";

/** 宿主换行节点后的排版换行不重复计为一行，代码中的空白保持原样 */
export function normalizeNoteLineBreaks(container: HTMLElement): void {
    for (const paragraph of Array.from(container.querySelectorAll("p"))) {
        // 只检查段落文本，不处理代码块或行内代码里的换行。
        const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        // 宿主通常输出 br 加换行文本，pre-wrap 会把两者算成两次换行。
        let node: Node | null;
        while ((node = walker.nextNode())) {
            if (node.parentElement?.closest("pre, code")) continue;
            // 仅移除紧贴显式换行节点的一次排版换行，不吞掉用户空行。
            let text = node.textContent || "";
            if (node.previousSibling?.nodeName === "BR") text = text.replace(/^\r?\n/, "");
            if (node.nextSibling?.nodeName === "BR") text = text.replace(/\r?\n$/, "");
            node.textContent = text;
        }
    }
}

/** 使用宿主 Markdown 渲染笔记，返回清理函数供换卡或关闭时释放资源 */
export function renderNoteMarkdown(app: App, text: string, parent: HTMLElement, sourcePath: string): () => void {
    // 每次展示独立容器，异步旧结果不会覆盖下一张卡片或新笔记。
    const container = parent.createDiv({ cls: "ll-note-markdown markdown-rendered" });
    // 渲染期间先显示原文，失败时也不会丢失学习笔记。
    container.textContent = text;
    // Markdown 子组件的事件与后处理器随展示生命周期释放。
    const component = new Component();
    // 被关闭的笔记不再向可见区域写入异步结果。
    let disposed = false;
    component.load();
    container.empty();
    void Promise.resolve().then(() => {
        if (!disposed) return MarkdownRenderer.render(app, text, container, sourcePath, component);
    }).then(() => {
        if (!disposed) normalizeNoteLineBreaks(container);
    }).catch(error => {
        if (!disposed) {
            container.textContent = text;
            console.error("[语叶笔记] Markdown 渲染失败，保留原文", error);
        }
    }).finally(() => { if (disposed) component.unload(); });
    return () => { disposed = true; component.unload(); container.remove(); };
}
