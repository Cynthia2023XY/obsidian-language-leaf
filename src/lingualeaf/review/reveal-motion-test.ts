import { afterEach, describe, expect, it, vi } from "vitest";
import { animateReveal } from "./reveal-motion";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
    const body = document.createElement("div"); const answer = document.createElement("section");
    body.style.overflowY = "auto";
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; finished: Promise<void>; finish: () => void }> = [];
    const animate = vi.fn(() => {
        let finish!: () => void;
        const animation = { cancel: vi.fn(), finished: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
        animations.push(animation); return animation as unknown as Animation;
    });
    body.animate = animate; answer.animate = animate;
    body.getBoundingClientRect = () => ({ height: 420 } as DOMRect);
    return { body, answer, animations, animate };
}
describe("语境对照揭晓过渡", () => {
    it("使用实测前后高度，结束后恢复滚动与自然尺寸", async () => {
        const setup = fixture(); const cleanup = animateReveal(setup.body, 280, [setup.answer]);
        expect(setup.animate.mock.calls[0]).toEqual([[{ height: "280px" }, { height: "420px" }], { duration: 200, easing: "cubic-bezier(.2,0,.2,1)" }]);
        expect(setup.body.style.overflowY).toBe("hidden");
        setup.animations.forEach(animation => animation.finish()); await Promise.all(setup.animations.map(animation => animation.finished)); await Promise.resolve();
        expect(setup.body.style.overflowY).toBe("auto"); expect(setup.body.style.height).toBe("");
        cleanup(); expect(setup.animations[0].cancel).toHaveBeenCalledTimes(1);
    });
    it("关闭窗口或切卡可以取消全部过渡", () => {
        const setup = fixture(); const cleanup = animateReveal(setup.body, 280, [setup.answer]); cleanup();
        expect(setup.body.style.overflowY).toBe("auto");
        for (const animation of setup.animations) expect(animation.cancel).toHaveBeenCalledOnce();
    });
    it("减少动态效果时直接显示，不启动动画", () => {
        vi.stubGlobal("matchMedia", () => ({ matches: true }));
        const setup = fixture(); animateReveal(setup.body, 280, [setup.answer]);
        expect(setup.animate).not.toHaveBeenCalled(); expect(setup.body.style.overflowY).toBe("auto");
    });
});
