import { describe, expect, it } from "vitest";
import { normalizeCardSpacing } from "./card-spacing";

/** 模拟 Obsidian 对源码软换行的不同渲染结果。 */
describe("卡片正常空行", () => {
    it.each([
        '释义<br>\n<br class="ll-card-gap"><br>\n<br><strong>原句</strong>：Text.',
        '释义<br>\n<br class="ll-card-gap">\n<br><strong>原句</strong>：Text.',
        '释义\n<br class="ll-card-gap">\n<strong>原句</strong>：Text.'
    ])("新旧标记统一成两个换行且重复处理不增加空行", html => {
        const root = document.createElement("div"); root.innerHTML = html;
        normalizeCardSpacing(root);
        expect(root.querySelectorAll("br")).toHaveLength(2);
        expect(root.textContent?.replace(/\n/g, "")).toBe("释义原句：Text.");
        const once = root.innerHTML; normalizeCardSpacing(root); expect(root.innerHTML).toBe(once);
    });
    it("仅改变带插件标记的间隔，不改其他段落的换行", () => {
        const root = document.createElement("div"); root.innerHTML = '<p>Other<br><br><br>note.</p><p>Meaning<br class="ll-card-gap"><br><br><strong>译文</strong>：译文</p>';
        normalizeCardSpacing(root);
        expect(root.querySelector("p")!.querySelectorAll("br")).toHaveLength(3);
        expect(root.querySelectorAll("p")[1].querySelectorAll("br")).toHaveLength(2);
    });
});
