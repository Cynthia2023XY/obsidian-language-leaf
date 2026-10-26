/** 把 Language Leaf 的显示间隔统一成两个换行，兼容旧版叠加的软换行。 */
export function normalizeCardSpacing(root: HTMLElement): void {
    root.querySelectorAll<HTMLBRElement>("br.ll-card-gap").forEach(gap => {
        // Obsidian 会把源码换行再渲染成 br；只移除标记两侧连续的换行和空白。
        for (const direction of ["previousSibling", "nextSibling"] as const) {
            let sibling = gap[direction];
            while (sibling && (sibling.nodeType === 3 && !sibling.textContent?.trim() || sibling.nodeType === 1 && (sibling as Element).tagName === "BR")) {
                const next = sibling[direction];
                sibling.parentNode?.removeChild(sibling); sibling = next;
            }
        }
        gap.after(gap.ownerDocument.createElement("br"));
    });
}
