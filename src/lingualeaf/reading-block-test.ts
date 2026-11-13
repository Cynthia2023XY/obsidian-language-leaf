import { describe, expect, it } from "vitest";
import { readingSelection } from "./selection-query";
import { sourceBlocks, locateReadingContext } from "./source-locator";
import { studyDay } from "./review/engine";

/** 在真实 DOM 结构中划选指定节点，不依赖浏览器私有方法 */
function select(markup: string, selector: string, from = 0, to?: number) {
    // 使用测试文档模拟 Obsidian 阅读容器。
    document.body.innerHTML = `<div id="reading">${markup}</div>`;
    // 本次阅读容器和词所在节点。
    const content = document.querySelector<HTMLElement>("#reading")!;
    // 测试始终选择明确文本节点，避免重复词全局搜索。
    const node = content.querySelector(selector)!.firstChild!;
    // 浏览器原生选区。
    const range = document.createRange();
    range.setStart(node, from); range.setEnd(node, to ?? node.textContent!.length);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    return { content, range, selected: readingSelection(content) };
}

describe("阅读结构适配", () => {
    it.each([
        ['<h2>Should you accept contributions?</h2>', 'h2', 'heading', 'Should you accept contributions?'],
        ['<ol><li>Finding a compromise.<ul><li>Child leaf.</li></ul></li><li>Other.</li></ol>', 'li', 'list', 'Finding a compromise.'],
        ['<ul><li><input type="checkbox"><p>Finding a compromise.</p><p>Second paragraph.</p></li></ul>', 'p', 'list', 'Finding a compromise.'],
        ['<ul><li>Parent<ul><li>Child leaf.</li></ul></li></ul>', 'li li', 'list', 'Child leaf.'],
    ])("选择 %s 时只使用当前层级文本", (markup, selector, kind, text) => {
        // 文本块不能把子列表或另一段文字并进例句。
        const { selected } = select(markup, selector);
        expect(selected?.block).toMatchObject({ kind, text, start: 0, end: text.length });
    });
    it("跨列表项被拒绝，代码和译文继续排除", () => {
        // 实际选择两项文字而非只把终点放到边界。
        const { content, range } = select('<ul><li>leaf</li><li>tree</li></ul>', 'li');
        range.setEnd(content.querySelectorAll('li')[1].firstChild!, 4);
        expect(readingSelection(content)).toBeNull();
        expect(select('<h2><code>leaf</code></h2>', 'code').selected).toBeNull();
        expect(select('<div class="callout"><p>leaf</p></div>', 'p').selected).toBeNull();
    });
    it("列表块内显式换行保留在语境和字符偏移中", () => {
        // br 不拥有文本节点，但在可见语境中必须保留换行。
        const { selected } = select('<ul><li>First line.<br><span>leaf</span></li></ul>', 'span');
        expect(selected?.block).toMatchObject({ text: 'First line.\nleaf', start: 12, end: 16 });
    });
    it("重复单词保留第二次出现的精确块内偏移", () => {
        // 不使用 indexOf 代替浏览器真实选区。
        const { selected } = select('<h2>leaf and leaf</h2>', 'h2', 9, 13);
        expect(selected?.block).toMatchObject({ start: 9, end: 13 });
    });
    it("标题和逐项译文按结构邻接配对，多段翻译完整保留", () => {
        // 此样例覆盖原方案的编号列表、实体、行内强调和缩进译文。
        const source = '## Should you accept **contributions**?\n\n> [!translation]-\n> 是否接受贡献？\n>\n> 第二段译文。\n\n1. Mostly accepting LLMs as neutral tools.\n\n   > [!translation]-\n   > 基本接受。\n\n2. Finding a [compromise](https://example.test)&#x20;or choosing not to act.\n\n   > [!translation]-\n   > 寻求折中。';
        const blocks = sourceBlocks(source);
        expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'Should you accept contributions?', translation: '是否接受贡献？\n\n第二段译文。' });
        expect(blocks[1].translation).toBe('基本接受。');
        expect(blocks[2]).toMatchObject({ kind: 'list', text: 'Finding a compromise or choosing not to act.', translation: '寻求折中。' });
        const { selected } = select('<ol><li>Finding a compromise or choosing not to act.</li></ol>', 'li', 10, 20);
        expect(locateReadingContext(source, 'compromise', selected!.block, '', {})).toMatchObject({ sentence: blocks[2].text, translation: '寻求折中。' });
    });
    it("整份列表之后的译文不擅自配给最后一项，图片会阻断段落译文配对", () => {
        // 原文结构无法明确逐项对应时保留人工补充。
        const blocks = sourceBlocks('1. First leaf.\n2. Second leaf.\n\n> [!translation]-\n> 整份列表译文。\n\nA leaf.\n\n![image](image.png)\n\n> [!translation]-\n> 不应配对。');
        expect(blocks.every(block => !block.translation)).toBe(true);
    });
    it("重复标题或不一致的渲染快照拒绝精确定位", () => {
        // 没有范围线索时不能静默选第一个同名标题。
        const { selected } = select('<h2>leaf</h2>', 'h2');
        expect(() => locateReadingContext('## leaf\n\n## leaf', 'leaf', selected!.block, '', {})).toThrow('未确认');
        expect(() => locateReadingContext('## tree', 'leaf', selected!.block, '', {})).toThrow('未确认');
    });
    it("转义的编号和星号作为正文保留", () => {
        expect(sourceBlocks('## 1\\. A \\*leaf\\*')[0].text).toBe('1. A *leaf*');
    });
    it("固定学习日时区在四点前后正确切换", () => {
        // UTC 三日之前/之后映射到上海学习日，不依赖测试机器时区。
        const calendar = { timeZone: 'Asia/Shanghai', rolloverHour: 4 };
        expect(studyDay(new Date('2026-11-12T19:59:59Z'), calendar)).toBe('2026-11-12');
        expect(studyDay(new Date('2026-11-12T20:00:00Z'), calendar)).toBe('2026-11-13');
    });
});
