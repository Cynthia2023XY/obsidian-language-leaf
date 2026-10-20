/** 面板内连续两次回车保存；单次多行回车继续换行，输入法和下拉框不触发 */
export function createQuickSave(save: () => void) {
    // 仅接受同一焦点目标上两次独立按键，排除长按和焦点切换。
    let previous: { target: EventTarget | null; time: number } | null = null;
    // 任意其他输入或离开当前字段都会结束连击。
    const reset = (): void => { previous = null; };
    // 捕获阶段先于浏览器表单默认提交及组件回车处理。
    const keydown = (event: KeyboardEvent): void => {
        // 组合键、输入法确认和标签选择交还组件处理。
        const target = event.target as HTMLElement | null;
        if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || target?.closest(".n-base-selection, [role=combobox], button, a, summary, select")) { reset(); return; }
        // 使用单调时钟，不受系统时间校准影响。
        const now = performance.now();
        if (previous?.target === event.target && now - previous.time <= 450) {
            reset(); event.preventDefault(); event.stopPropagation(); save(); return;
        }
        previous = { target: event.target, time: now };
        // 单行字段禁止一次回车隐式提交，文本框保留原生换行。
        if (target?.tagName !== "TEXTAREA") event.preventDefault();
    };
    // 两次回车之间若录入其他文字，不应误判为快捷保存。
    const input = (event: InputEvent): void => { if (!["insertLineBreak", "insertParagraph"].includes(event.inputType)) reset(); };
    return { keydown, input, reset };
}
