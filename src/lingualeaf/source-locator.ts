import { fencedBlocks, articleBody, extractContext, plainText } from "./article";
import type { ContextOptions } from "./article";
import type { ArticleContext } from "./domain";
import type { ReadingBlock, ReadingBlockKind } from "./reading-block";

/** Markdown 文本块及其所属结构范围 */
export interface SourceBlock {
    /** 用于与渲染类型交叉校验 */
    kind: ReadingBlockKind;
    /** 块展示内容，不带 Markdown 结构标记 */
    text: string;
    /** 原文起始行，仅作为线索，最终仍需文本校验 */
    from: number;
    /** 原文结束行 */
    to: number;
    /** 此块明确邻接的完整译文 */
    translation: string;
    /** 列表所属层级；普通块为零 */
    indent: number;
}
/** 有限规范化只用于比较，不将其下标直接用于原文切片 */
export function matchText(value: string): string { return value.normalize("NFC").replace(/\s+/g, " ").trim(); }
/** 将当前结构内部 Markdown 转为可读文本，转义字符不误删 */
export function visibleMarkdown(value: string): string {
    // 暂存转义标点，避免强调清理删掉正文中的星号和下划线。
    const escaped: string[] = [];
    // 占位符只作用于转换过程，不保存到资料。
    const protectedText = value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, (_all, char: string) => { escaped.push(char); return `\uE000${escaped.length - 1}\uE001`; });
    return plainText(protectedText).replace(/\uE000(\d+)\uE001/g, (_all, index: string) => escaped[Number(index)]);
}
/** 保守识别段落、标题、列表和完整 translation callout；未知结构形成配对屏障 */
export function sourceBlocks(source: string): SourceBlock[] {
    // 屏蔽代码和学习卡片，同时保留原始行号。
    const lines = articleBody(source).split(/\r?\n/);
    // 被屏蔽代码仍构成结构屏障，不能跨代码关联到后面的译文。
    for (const fence of fencedBlocks(source)) lines[source.slice(0, fence.from).split(/\r?\n/).length - 1] = "> ll-context-boundary";
    // 已识别且可定位的来源块。
    const blocks: SourceBlock[] = [];
    // 当前列表层级栈，存储正文列而非猜测固定四空格。
    const lists: Array<{ indent: number; body: number }> = [];
    // 当前可继续补充的文本块。
    let current: SourceBlock | undefined;
    // 邻接译文只能接到上一个合法块。
    let adjacent: SourceBlock | undefined;
    for (let index = 0; index < lines.length; index++) {
        // 每行保留缩进，列表归属和译文配对都依赖它。
        const line = lines[index];
        if (!line.trim()) { current = undefined; continue; }
        // 当前物理缩进用于判断译文是否仍位于列表项内。
        const indent = line.match(/^ */)![0].length;
        // 完整 callout 包括空引用行和多个中文段落。
        if (/^\s*>\s*\[!translation\][+-]?[^\n]*$/i.test(line)) {
            // 连续引用行组成同一份译文。
            const translated: string[] = [];
            // 只有同层级邻接，或者缩进在列表项内才允许配对。
            const target = adjacent && (adjacent.kind === "list" ? indent > adjacent.indent : indent === adjacent.indent) ? adjacent : undefined;
            while (index + 1 < lines.length && (new RegExp(`^ {${indent}}>`, "u")).test(lines[index + 1])) translated.push(lines[++index].replace(/^\s*>\s?/, ""));
            if (target) target.translation = translated.join("\n").trim();
            current = undefined; adjacent = undefined; continue;
        }
        // 标题、列表标记由结构识别去除，正文里的数字和反斜杠保留。
        const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
        // 捕获任务列表并去掉复选框装饰。
        const list = line.match(/^( *)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/);
        if (list) {
            while (lists.length && lists[lists.length - 1].indent >= indent) lists.pop();
            lists.push({ indent, body: line.length - list[2].length });
        } else if (lists.length && indent < lists[lists.length - 1].body) {
            while (lists.length && indent < lists[lists.length - 1].body) lists.pop();
        }
        // 代码、图片、引用、HTML、表格和分隔线均阻断自动译文配对。
        if (/^\s*(?:>|!\[|<|\||[-*_]{3,}\s*$)/.test(line)) { current = undefined; adjacent = undefined; continue; }
        // 列表内空行后的新段落仍只属于最近的当前层级。
        const kind: ReadingBlockKind = heading ? "heading" : list || lists.length ? "list" : "paragraph";
        // 每行展示文字只清理已识别的结构标记。
        const text = visibleMarkdown(heading?.[1] ?? list?.[2] ?? line.trim());
        if (current && !heading && !list && current.kind === kind) { current.text += "\n" + text; current.to = index; }
        else { current = { kind, text, from: index, to: index, indent: list ? indent : kind === "list" ? lists[lists.length - 1].indent : indent, translation: "" }; blocks.push(current); }
        adjacent = current;
        if (heading) current = undefined;
    }
    return blocks;
}
/** 渲染区域的章节信息按查询时读取，缓存落后时必须由文字校验拒绝 */
const sections = new WeakMap<HTMLElement, () => { lineStart: number; lineEnd: number } | null>();
/** 宿主后处理器只建立临时关联，不给笔记添加标记 */
export function bindSourceSection(root: HTMLElement, section: () => { lineStart: number; lineEnd: number } | null): void { sections.set(root, section); }
/** 在来源范围内匹配当前块，不对同名词做全局猜测 */
export function locateReadingContext(source: string, selected: string, block: ReadingBlock, outline: string, options: Partial<ContextOptions>): ArticleContext {
    // 从当前元素向上找到宿主渲染区。
    let element: HTMLElement | null = block.element;
    // 没有章节信息时只允许全篇唯一的结构化文本匹配。
    let section: { lineStart: number; lineEnd: number } | null = null;
    while (element) { if (sections.has(element)) { section = sections.get(element)!(); break; } element = element.parentElement; }
    // 类型、范围、完整块文字必须全部相符。
    const candidates = sourceBlocks(source).filter(item => item.kind === block.kind && matchText(item.text) === matchText(block.text) && (!section || item.from >= section.lineStart && item.to <= section.lineEnd));
    if (candidates.length !== 1 || !matchText(block.text.slice(block.start, block.end)).includes(matchText(selected))) throw new Error("来源位置未确认，当前使用可见文本快照，可手工编辑语境");
    // 标题和列表绝不自动扩展到相邻正文。
    const current = candidates[0];
    if (block.kind !== "paragraph") return { sentence: current.text, translation: current.translation, outline, anchor: current.text };
    try {
        // 普通段落继续复用既有短句扩展规则，失败时保留已确认块。
        return extractContext(source, selected, outline, block.text, options);
    } catch { return { sentence: current.text, translation: current.translation, outline, anchor: current.text }; }
}
