import { describe, expect, it } from "vitest";
import { decodeTextEntities, translationText } from "./translation";

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
