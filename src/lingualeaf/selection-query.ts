import { selectedParagraph } from "./selection";

export interface ReadingSelection {
    range: Range;
    text: string;
    paragraph: HTMLParagraphElement;
}
export interface SelectionQueryController {
    dispose: () => void;
    selection: () => ReadingSelection | null;
}

/** 三种查询入口共用的正文范围校验。 */
export function readingSelection(content: HTMLElement): ReadingSelection | null {
    const selection = content.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().trim();
    const range = selection.getRangeAt(0);
    if (!text || text.length > 500 || !content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
    const paragraph = selectedParagraph(range, content);
    return paragraph ? { range, text, paragraph } : null;
}

/** 原生选区旁的查询按钮，并在修饰键释放时补齐触控板拖选查询。 */
export function installSelectionQuery(content: HTMLElement, options: {
    active: () => boolean;
    modifier: () => string;
    autoQuery?: () => boolean;
    query: () => void;
}): SelectionQueryController {
    const doc = content.ownerDocument;
    const win = doc.defaultView!;
    const button = doc.createElement("button");
    button.className = "ll-selection-query";
    button.type = "button"; button.textContent = "查词";
    button.setAttribute("aria-label", "查询选中的词句"); button.hidden = true;
    doc.body.append(button);
    let timer = 0;
    let finishTimer = 0;
    let autoTimer = 0;
    let pointerHeld = false;
    let remembered: ReadingSelection | null = null;
    let armed = false;
    let held = false;
    let baseline: Range | null = null;
    let last: Range | null = null;
    let lastText = "";
    let saved: Range | null = null;
    const same = (a: Range | null, b: Range): boolean => !!a && a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
    const valid = () => options.active() ? readingSelection(content) : null;
    const remember = (): ReadingSelection | null => {
        const current = valid();
        if (current) remembered = { ...current, range: current.range.cloneRange() };
        return current;
    };
    const selection = (): ReadingSelection | null => {
        if (!options.active()) return null;
        const current = remember();
        if (current) return current;
        // 无效的非空正文选区不能回退到旧的有效选区。
        if (!doc.getSelection()?.isCollapsed) { remembered = null; return null; }
        if (!remembered || !content.contains(remembered.paragraph) || remembered.range.toString().trim() !== remembered.text || selectedParagraph(remembered.range, content) !== remembered.paragraph) return null;
        return remembered;
    };
    const hide = (): void => { button.hidden = true; saved = null; };
    const update = (): void => {
        const selected = valid();
        if (!selected || (same(last, selected.range) && lastText === selected.text)) { hide(); return; }
        const rect = selected.range.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > win.innerHeight || rect.right < 0 || rect.left > win.innerWidth) { hide(); return; }
        saved = selected.range.cloneRange(); button.hidden = false;
        button.style.left = `${Math.max(8, Math.min(rect.right, win.innerWidth - button.offsetWidth - 8))}px`;
        button.style.top = `${Math.max(8, Math.min(rect.bottom + 6, win.innerHeight - button.offsetHeight - 8))}px`;
    };
    const run = (selected: ReadingSelection): void => {
        if (same(last, selected.range) && lastText === selected.text) return;
        last = selected.range.cloneRange(); lastText = selected.text;
        remembered = { ...selected, range: selected.range.cloneRange() };
        hide(); options.query();
    };
    const scheduleAuto = (delay = 450): void => {
        win.clearTimeout(autoTimer);
        if (!options.autoQuery?.()) return;
        autoTimer = win.setTimeout(() => {
            const selected = remember();
            if (options.autoQuery?.() && !pointerHeld && selected && !editable(doc.activeElement) && !doc.activeElement?.closest(".prompt")) run(selected);
        }, delay);
    };
    const finish = (): void => {
        const selected = valid();
        if (!armed || !selected || same(baseline, selected.range)) return;
        armed = false;
        run(selected);
    };
    const editable = (target: EventTarget | null): boolean => !!(target as Element | null)?.closest?.("input, textarea, select, [contenteditable=true]");
    const keyForModifier = (): string => ({ altKey: "Alt", shiftKey: "Shift", ctrlKey: "Control", metaKey: "Meta" }[options.modifier()] || "");
    const keydown = (event: KeyboardEvent): void => {
        if (!(event.target as Element | null)?.closest?.(".prompt")) {
            remember();
            if (["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) remembered = null;
        }
        if (event.key !== keyForModifier() || event.repeat || editable(event.target) || !options.active()) return;
        held = true; armed = false;
        baseline = valid()?.range.cloneRange() || null;
        last = null;
    };
    const keyup = (event: KeyboardEvent): void => {
        if (event.key !== keyForModifier()) return;
        const wasHeld = held;
        held = false;
        // 释放后重读最终选区，不依赖 selectionchange 与键盘事件的先后顺序。
        win.clearTimeout(finishTimer); finishTimer = win.setTimeout(() => {
            const selected = valid();
            if (wasHeld && selected && !same(baseline, selected.range)) armed = true;
            finish(); update();
        }, 0);
    };
    const pointerdown = (event: PointerEvent): void => {
        if (button.contains(event.target as Node)) return;
        hide(); last = null; remembered = null;
        win.clearTimeout(autoTimer); pointerHeld = event.button === 0;
        armed = event.button === 0 && !!(event as any)[options.modifier()] && !editable(event.target);
        baseline = null;
    };
    const pointerup = (event: PointerEvent): void => {
        if (event.button !== 0 || button.contains(event.target as Node) || editable(event.target) || (!content.contains(event.target as Node) && !armed)) return;
        pointerHeld = false;
        remember();
        if ((event as any)[options.modifier()]) armed = true;
        finish(); update(); scheduleAuto(180);
    };
    const change = (): void => {
        const selected = remember();
        if (held && selected && !same(baseline, selected.range)) armed = true;
        if (!selected) {
            if (!doc.getSelection()?.isCollapsed) remembered = null;
            win.clearTimeout(autoTimer); hide(); return;
        }
        win.clearTimeout(timer); timer = win.setTimeout(update, 120);
        scheduleAuto();
    };
    const preserve = (event: PointerEvent): void => { event.preventDefault(); };
    const click = (): void => {
        if (!saved || !options.active()) return;
        const range = saved.cloneRange();
        const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        const current = remember();
        if (current) run(current);
    };
    const blur = (): void => { armed = false; held = false; pointerHeld = false; baseline = null; remembered = null; win.clearTimeout(timer); win.clearTimeout(finishTimer); win.clearTimeout(autoTimer); hide(); };
    const outside = (event: PointerEvent): void => {
        if (!content.contains(event.target as Node) && !button.contains(event.target as Node)) {
            // 命令面板中的点击保留打开面板前的选区；其他区域点击使其失效。
            if ((event.target as Element | null)?.closest?.(".prompt")) { win.clearTimeout(autoTimer); hide(); }
            else blur();
        }
    };
    const move = (event: PointerEvent): void => {
        if (!content.contains(event.target as Node)) return;
        if (event.buttons & 1) { pointerHeld = true; win.clearTimeout(autoTimer); }
        else if (pointerHeld) { pointerHeld = false; scheduleAuto(); }
    };
    const refresh = (): void => { update(); };
    button.addEventListener("pointerdown", preserve);
    button.addEventListener("click", click);
    content.addEventListener("pointerdown", pointerdown, true);
    doc.addEventListener("pointerdown", outside);
    doc.addEventListener("pointercancel", blur);
    doc.addEventListener("pointerup", pointerup);
    doc.addEventListener("pointermove", move);
    doc.addEventListener("selectionchange", change);
    doc.addEventListener("keydown", keydown);
    doc.addEventListener("keyup", keyup);
    doc.addEventListener("scroll", refresh, true);
    win.addEventListener("resize", refresh);
    win.addEventListener("blur", blur);
    const dispose = (): void => {
        blur(); button.remove();
        content.removeEventListener("pointerdown", pointerdown, true);
        doc.removeEventListener("pointerdown", outside);
        doc.removeEventListener("pointercancel", blur);
        doc.removeEventListener("pointerup", pointerup);
        doc.removeEventListener("pointermove", move);
        doc.removeEventListener("selectionchange", change);
        doc.removeEventListener("keydown", keydown); doc.removeEventListener("keyup", keyup);
        doc.removeEventListener("scroll", refresh, true);
        win.removeEventListener("resize", refresh); win.removeEventListener("blur", blur);
    };
    return { dispose, selection };
}
