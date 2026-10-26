/** 阅读视图切换时即刻清理学习状态，不依赖宿主是否发出 layout-change。 */
export function watchReadingMode(view: { containerEl: HTMLElement; getMode: () => string }, exit: () => void): () => void {
    const observer = new view.containerEl.ownerDocument.defaultView!.MutationObserver(() => {
        if (view.getMode() !== "preview") exit();
    });
    observer.observe(view.containerEl, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-mode", "class", "style"] });
    return () => observer.disconnect();
}
