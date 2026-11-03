import { describe, expect, it } from "vitest";
import { decodeTextEntities, translationText, translateContext } from "./translation";

/** 有道实体残留回归，不将文本作为 HTML 执行 */
describe("例句译文字符还原", () => {
    it("恢复普通、重复转义和全角分号实体", () => {
        expect(decodeTextEntities("I&amp；#x27；d &quot;code&quot; &amp; rails&#46;")).toBe('I\'d "code" & rails.');
        expect(decodeTextEntities("&#39; &#x2019; &nbsp; &#99999999;")).toBe("' ’   &#99999999;");
    });
    it("仅取译文段落，保留纯文本，不将解码标签插入 DOM", () => {
        expect(translationText('<p>Original.</p><p>我&amp;amp;#x27; &lt;script&gt;文字&lt;/script&gt;</p>')).toBe("我' <script>文字</script>");
        expect(translationText('<p>Only original.</p>')).toBe("");
    });
    it("缺少实体名称的损坏字符保持原样，不猜测原文语义", () => {
        expect(decodeTextEntities("“&；”铁路上的代码")).toBe("“&；”铁路上的代码");
    });
});

 it("分段翻译保持原文空行和顺序，缺译文时不拼接错位结果", async () => {
    const calls: string[] = [];
    expect(await translateContext("First.\n\nSecond.\nThird.", async text => { calls.push(text); return `译：${text}`; })).toBe("译：First.\n\n译：Second.\n译：Third.");
    expect(calls).toEqual(["First.", "Second.", "Third."]);
    expect(await translateContext("First.\nSecond.", async text => text === "First." ? "译文" : "")).toBe("");
 });

it("还原第三方插入空格的数值实体，不删除普通正文字符", () => {
    expect(decodeTextEntities("Haven& # x27;t & # 39; & # x2019；")).toBe("Haven't ' ’");
    expect(translationText("<p>Original.</p><p>Haven&amp; # x27;我决定下午去。</p>")).toBe("Haven'我决定下午去。");
    expect(decodeTextEntities("A & # invalid; B")).toBe("A & # invalid; B");
});
