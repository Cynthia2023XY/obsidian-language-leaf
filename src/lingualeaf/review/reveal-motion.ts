/** Animate measured layout height, then return sizing to CSS for resize/details. */
export function animateReveal(body: HTMLElement, previousHeight: number, targets: HTMLElement[]): () => void {
    if (typeof body.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => {};
    const nextHeight = body.getBoundingClientRect().height;
    const animations: Animation[] = [];
    let cleaned = false;
    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        body.classList.remove("ll-review-animating");
        animations.forEach(animation => animation.cancel());
    };
    try {
        if (previousHeight > 0 && nextHeight > 0 && Math.abs(nextHeight - previousHeight) > 1) {
            body.classList.add("ll-review-animating");
            animations.push(body.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], { duration: 200, easing: "cubic-bezier(.2,0,.2,1)" }));
        }
        for (const target of targets) animations.push(target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" }));
        void Promise.all(animations.map(animation => animation.finished)).then(cleanup, cleanup);
    } catch { cleanup(); }
    return cleanup;
}
