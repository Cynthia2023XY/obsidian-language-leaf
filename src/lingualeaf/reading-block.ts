/** 阅读文本块类别，列表中的独立段落也归属当前层级 */
export type ReadingBlockKind = "paragraph" | "heading" | "list";
/** 阅读会话专用选区，DOM 和偏移不进入学习库 */
export interface ReadingBlock {
    /** 当前块的结构类别 */
    kind: ReadingBlockKind;
    /** 实际所属渲染元素 */
    element: HTMLElement;
    /** 去除子列表和界面装饰的展示文字 */
    text: string;
    /** 选中表达在展示文字中的精确偏移 */
    start: number;
    /** 选区结束偏移 */
    end: number;
}
/** 不参与阅读选区的代码、翻译和界面区域 */
const excluded = ".callout, blockquote, pre, code, .markdown-embed, .frontmatter, .lingualeaf-modal, input, button, .list-bullet, .list-number, .heading-collapse-indicator, .collapse-indicator";
/** 为真实文字节点确定唯一的阅读块 */
function owner(node: Node): HTMLElement | null {
    // 紧凑列表没有 p，宽松列表优先取 p，嵌套列表使用最近的 li。
    return node.parentElement?.closest<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6") || null;
}
/** 读取同一块内的文本节点，子列表、其他段落和装饰不混入语境 */
function textNodes(element: HTMLElement): Array<Text | HTMLBRElement> {
    // 使用所属窗口的节点遍历器以兼容多窗口。
    const walker = element.ownerDocument.createTreeWalker(element, 5);
    // 按渲染顺序保留文本节点，偏移计算与展示使用同一组节点。
    const nodes: Array<Text | HTMLBRElement> = [];
    // 浏览器遍历器逐个返回文本节点。
    let node: Node | null;
    while ((node = walker.nextNode())) if ((node.nodeType === 3 || node.nodeName === "BR") && owner(node) === element && !node.parentElement?.closest(excluded)) nodes.push(node as Text | HTMLBRElement);
    return nodes;
}
/** 从实际选中的非空文本识别单块选区，端点触及下一块不算跨块 */
export function selectedReadingBlock(range: Range, content: HTMLElement): ReadingBlock | null {
    // 遍历整个阅读容器，不能仅靠起止元素判断。
    const walker = content.ownerDocument.createTreeWalker(content, 4);
    // 本次选区唯一合法归属。
    let element: HTMLElement | null = null;
    // 实际选中文字在各文本节点内的交集。
    const portions = new Map<Node, { start: number; end: number }>();
    // 当前遍历到的文字。
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (!range.intersectsNode(node)) continue;
        // 与 Range 求交，排除边界接触和纯空白节点。
        const overlap = content.ownerDocument.createRange();
        overlap.selectNodeContents(node);
        if (overlap.compareBoundaryPoints(0, range) < 0) overlap.setStart(range.startContainer, range.startOffset);
        if (overlap.compareBoundaryPoints(2, range) > 0) overlap.setEnd(range.endContainer, range.endOffset);
        if (!overlap.toString().trim()) continue;
        // 排除代码及翻译，不能因定位失败回退绕过此校验。
        const current = owner(node);
        if (!current || node.parentElement?.closest(excluded) || (element && element !== current)) return null;
        element = current;
        portions.set(node, { start: overlap.startContainer === node ? overlap.startOffset : 0, end: overlap.endContainer === node ? overlap.endOffset : node.textContent!.length });
    }
    if (!element) return null;
    // 当前块所有可读文字与选区偏移同源生成。
    let text = "";
    // 记录首末实际选中文字，避免重复单词定位到第一处。
    let start = -1;
    // 最后一个非空选区结束位置。
    let end = -1;
    for (const textNode of textNodes(element)) {
        // 选择记录只存在于本次查询会话。
        const portion = portions.get(textNode);
        if (portion) { if (start < 0) start = text.length + portion.start; end = text.length + portion.end; }
        text += textNode.nodeType === 3 ? (textNode as Text).data : "\n";
    }
    return { element, text, start, end, kind: /^H[1-6]$/.test(element.tagName) ? "heading" : element.closest("li") ? "list" : "paragraph" };
}
