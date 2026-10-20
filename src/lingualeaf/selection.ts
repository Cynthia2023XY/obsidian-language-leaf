/** 浏览器在鼠标坐标处提供的文本光标位置 */
export interface TextCaret {
    /** 光标所属的文本或元素节点 */
    offsetNode: Node;
    /** 光标在节点内的字符或子节点偏移 */
    offset: number;
}

/** 兼容 Chromium 与支持标准光标定位 API 的宿主文档 */
type CaretDocument = Document & {
    /** 标准光标坐标查询入口 */
    caretPositionFromPoint?: (x: number, y: number) => TextCaret | null;
    /** Chromium 兼容光标坐标查询入口 */
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** Shift 划词每次从本次按下位置开始，避免浏览器沿用上次选区锚点扩选 */
export function resetShiftSelection(event: PointerEvent, content: HTMLElement, modifier: string): TextCaret | null {
    if (modifier !== "shiftKey" || !event.shiftKey || event.button !== 0) return null;
    // 仅处理原生文章正文段落，不改变翻译、链接、代码、表单和侧栏的点击行为。
    const target = event.target as Element | null;
    // 文本节点由浏览器事件目标的父元素归属段落。
    const paragraph = target?.closest?.(".markdown-preview-view p");
    if (!paragraph || !content.contains(paragraph) || target?.closest("a, code, input, textarea, button") || paragraph.closest(".callout, pre, .markdown-embed, .frontmatter")) return null;
    // 使用文章所属窗口，避免独立窗口误改主窗口的选区。
    const doc = content.ownerDocument as CaretDocument;
    // 标准 API 与 Chromium 兼容 API 取到同一类文本位置。
    const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
    // 老版 Electron 只暴露 Range 形式的光标定位能力。
    const range = caret ? null : doc.caretRangeFromPoint?.(event.clientX, event.clientY);
    // 空白区域或无法定位的坐标保持浏览器原行为。
    const node = caret?.offsetNode || range?.startContainer;
    // 光标不允许越过本次按下的段落。
    const offset = caret?.offset ?? range?.startOffset;
    if (!node || offset === undefined || !paragraph.contains(node)) return null;
    doc.getSelection()?.collapse(node, offset);
    return { offsetNode: node, offset };
}

/** 按本次起点更新原生文本选区，避免 Shift 默认扩选抢先锁定旧范围 */
export function extendShiftSelection(event: PointerEvent, content: HTMLElement, anchor: TextCaret): void {
    // 光标始终从当前文章所属窗口读取。
    const doc = content.ownerDocument as CaretDocument;
    // 支持标准和 Chromium 两种坐标定位入口。
    const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
    // 标准接口不存在时读取折叠 Range。
    const range = caret ? null : doc.caretRangeFromPoint?.(event.clientX, event.clientY);
    // 允许反向拖选，但终点仍需处于当前文章内容中。
    const node = caret?.offsetNode || range?.startContainer;
    // 节点内的字符偏移不由文本长度猜测。
    const offset = caret?.offset ?? range?.startOffset;
    if (!node || offset === undefined || !content.contains(node) || !content.contains(anchor.offsetNode)) return;
    doc.getSelection()?.setBaseAndExtent(anchor.offsetNode, anchor.offset, node, offset);
}
