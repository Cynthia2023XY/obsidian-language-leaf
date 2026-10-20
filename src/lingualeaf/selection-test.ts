import { afterEach, describe, expect, it } from "vitest";
import { resetShiftSelection, extendShiftSelection } from "./selection";

/** 测试只安装临时光标定位能力，结束后恢复宿主文档 */
const originalPosition = Object.getOwnPropertyDescriptor(document, "caretPositionFromPoint");
/** Chromium 光标定位能力同样需要恢复 */
const originalRange = Object.getOwnPropertyDescriptor(document, "caretRangeFromPoint");

/** 创建含旧锚点的原生阅读段落，模拟用户之前在正文开头点过一次 */
function fixture(markup = '<p>An old bookmark beside a narrow slip.</p>') {
    // 当前文章与段落沿用 Obsidian 原生阅读容器。
    const content = document.createElement("div");
    content.innerHTML = `<div class="markdown-preview-view">${markup}</div>`;
    document.body.append(content);
    // 文本光标起初停留在前面的旧位置。
    const paragraph = content.querySelector("p")!;
    // 模拟浏览器根据鼠标坐标找到本次拖选起点。
    const text = paragraph.firstChild!;
    document.getSelection()!.collapse(text, 0);
    Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => ({ offsetNode: text, offset: 7 }) });
    // 通过真实 DOM 分发让事件具有目标和捕获阶段。
    const press = (modifier = "shiftKey", shiftKey = true, target: Element = paragraph): void => {
        // 只测试监听器到浏览器光标接口的边界，不模拟浏览器的选区扩展算法。
        const listener = (event: Event): void => resetShiftSelection(event as PointerEvent, content, modifier);
        content.addEventListener("pointerdown", listener, true);
        target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, shiftKey, clientX: 20, clientY: 20 }));
        content.removeEventListener("pointerdown", listener, true);
    };
    return { content, paragraph, text, press };
}

afterEach(() => {
    document.body.replaceChildren();
    document.getSelection()!.removeAllRanges();
    for (const [name, descriptor] of [["caretPositionFromPoint", originalPosition], ["caretRangeFromPoint", originalRange]] as const) {
        if (descriptor) Object.defineProperty(document, name, descriptor);
        else delete (document as any)[name];
    }
});

describe("Shift 原生拖选起点", () => {
    it("首次划词在鼠标按下时重置旧锚点，继续交由浏览器原生拖选", () => {
        // 旧位置在段落开头，新拖选从目标字符开始。
        const setup = fixture();
        setup.press();
        expect(document.getSelection()!.anchorNode).toBe(setup.text);
        expect(document.getSelection()!.anchorOffset).toBe(7);
        expect(document.getSelection()!.isCollapsed).toBe(true);
    });
    it("普通点击及其他快捷键设置不改变原生 Shift 扩选", () => {
        // 只有用户将 Shift 配为查词修饰键时接管其旧锚点。
        const setup = fixture();
        setup.press("ctrlKey", true);
        expect(document.getSelection()!.anchorOffset).toBe(0);
        setup.press("shiftKey", false);
        expect(document.getSelection()!.anchorOffset).toBe(0);
    });
    it("译文、链接和代码内的点击保留浏览器默认选区行为", () => {
        for (const markup of ['<div class="callout"><p>Translation.</p></div>', '<p>Text <a href="#">link</a></p>', '<p>Text <code>code</code></p>']) {
            // 这些区域不属于可查询的普通文章段落。
            const setup = fixture(markup);
            setup.press("shiftKey", true, setup.paragraph.querySelector("a,code") || setup.paragraph);
            expect(document.getSelection()!.anchorOffset).toBe(0);
        }
    });
    it("按当前拖动终点更新选区，支持正向和反向划选", () => {
        // 起点固定在本次按下处，不再沿用段落开头的旧光标。
        const setup = fixture();
        setup.press();
        // 正向拖到目标词尾，继续使用原生 Selection 高亮。
        const anchor = { offsetNode: setup.text, offset: 7 };
        Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => ({ offsetNode: setup.text, offset: 15 }) });
        extendShiftSelection(new MouseEvent("pointermove") as PointerEvent, setup.content, anchor);
        expect(document.getSelection()!.toString()).toBe("bookmark");
        Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => ({ offsetNode: setup.text, offset: 3 }) });
        extendShiftSelection(new MouseEvent("pointermove") as PointerEvent, setup.content, anchor);
        expect(document.getSelection()!.toString()).toBe("old ");
        expect(document.getSelection()!.anchorOffset).toBe(7);
    });
    it("无法定位坐标或拖出文章时不扩选到侧栏", () => {
        // 来源保护禁止把侧栏文字混入文章查询。
        const setup = fixture();
        // 当前按下位置保持在文章内。
        const anchor = { offsetNode: setup.text, offset: 7 };
        setup.press();
        // 侧栏节点不属于这篇文章。
        const outside = document.createTextNode("sidebar"); document.body.append(outside);
        Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => ({ offsetNode: outside, offset: 3 }) });
        extendShiftSelection(new MouseEvent("pointermove") as PointerEvent, setup.content, anchor);
        expect(document.getSelection()!.anchorOffset).toBe(7);
        expect(document.getSelection()!.isCollapsed).toBe(true);
    });
    it("只提供 Chromium Range 光标接口的宿主也能重置锚点", () => {
        // 兼容旧 Electron 的坐标定位 API。
        const setup = fixture();
        delete (document as any).caretPositionFromPoint;
        Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: () => {
            // Chromium 返回折叠 Range，起点与标准光标 API 等价。
            const range = document.createRange(); range.setStart(setup.text, 9); range.collapse(true); return range;
        } });
        setup.press();
        expect(document.getSelection()!.anchorOffset).toBe(9);
    });
});

/** 按真实选中文字校验段落，避免 DOM 端点格式造成误报 */
describe("双语正文选区边界", () => {
    it("段落外层元素作为终点时仍能找到唯一英文段落", async () => {
        // 阅读器的全段选择可以结束在英文段落后的容器边界。
        const { selectedParagraph } = await import("./selection");
        // 译文与英文紧邻，端点不能被误判为选中了译文。
        const setup = fixture('<p>Hello <strong>wealth</strong>.</p><div class="callout"><p>财富。</p></div>');
        // 终点指向 callout 之前，而非英文文本节点。
        const range = document.createRange();
        range.setStart(setup.paragraph.firstChild!, 0);
        range.setEnd(setup.paragraph.parentElement!, 1);
        expect(selectedParagraph(range, setup.content)).toBe(setup.paragraph);
    });
    it("同段强调可查询，跨译文、跨段和混入代码继续拒绝", async () => {
        // 覆盖边界保护，防止修复时把译文当成原文保存。
        const { selectedParagraph } = await import("./selection");
        for (const markup of ['<p>Hello <strong>wealth</strong>.</p>', '<p>Hello.</p><p>World.</p>', '<p>Hello <code>wealth</code>.</p>', '<div class="callout"><p>财富。</p></div>']) {
            // 全选测试容器以模拟元素边界形式的选区。
            const setup = fixture(markup);
            // 只包含当前案例，不读取之前的 DOM。
            const range = document.createRange(); range.selectNodeContents(setup.paragraph.parentElement!);
            expect(selectedParagraph(range, setup.content)).toBe(markup.includes("strong") ? setup.paragraph : null);
        }
    });
});
