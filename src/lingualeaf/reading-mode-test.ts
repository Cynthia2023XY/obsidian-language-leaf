import { describe, expect, it, vi } from "vitest";
import { watchReadingMode } from "./reading-mode";

describe("原生阅读和编辑模式切换", () => {
    it("无 layout-change 时仍能检测编辑模式，退出后停止观察", async () => {
        const containerEl = document.createElement("div"); let mode = "preview";
        const exit = vi.fn(); const stop = watchReadingMode({ containerEl, getMode: () => mode }, exit);
        containerEl.className = "preview"; await Promise.resolve(); expect(exit).not.toHaveBeenCalled();
        mode = "source"; containerEl.className = "source"; await Promise.resolve(); expect(exit).toHaveBeenCalledTimes(1);
        stop(); containerEl.className = "another"; await Promise.resolve(); expect(exit).toHaveBeenCalledTimes(1);
    });
});
