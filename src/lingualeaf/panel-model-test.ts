import { describe, expect, it } from "vitest";
import { cardToForm, formToCard } from "./panel-model";
import { parseCards, renderCard } from "./article";
import type { LeafCard } from "./domain";

/** 与原表单相同的卡片身份和 SR 归属样本 */
const card: LeafCard = { id: "panel-card", expressionId: "panel-expression", text: "Été", language: "fr", meaning: "夏天",
    sentence: "Un bel été.", translation: "美好的夏天。", outline: "回忆夏日", notes: "原笔记", anchor: "Un bel été.", kind: "word", tags: ["季节"], owner: "spaced-repetition" };

describe("复用原插件表单的 Markdown 桥接", () => {
    it("不再需要手动状态，保留大小写和法语重音", () => {
        // 表单只编辑词句本身，收录次数由保存意图自动统计。
        const form = cardToForm(card, "夏日");
        const saved = formToCard(card, form, card.outline);
        expect(form).not.toHaveProperty("status");
        expect(saved.text).toBe("Été");
        expect(saved.language).toBe("fr");
    });
    it("多条笔记、例句和出处经过保存及重开仍逐条可编辑，SR 进度保持原文", () => {
        // 保留原表单动态添加的多条记录，而非只保存第一条。
        const form = cardToForm(card, "夏日");
        form.notes = ["第一条\n保留换行", "第二条"];
        form.sentences[0].text += "\nA second line.";
        form.sentences.push({ text: "L'été arrive.", trans: "夏天到了。", origin: "另一篇文章" });
        const saved = formToCard(card, form, "更新大纲");
        const schedule = "<!--SR:!2026-10-22,3,250-->";
        const parsed = parseCards(renderCard(saved, "?", schedule), "?")[0];
        expect(cardToForm(parsed.card, "夏日")).toEqual(form);
        expect(parsed.card.outline).toBe("更新大纲");
        expect(parsed.schedule).toBe(schedule);
        expect(parsed.card.id).toBe(card.id);
        expect(parsed.card.expressionId).toBe(card.expressionId);
    });
    it("手改可见笔记与原句后，表单遵从当前 Markdown 内容", () => {
        // 隐藏的表单快照不能覆盖用户在文章中手写的内容。
        const saved = formToCard(card, cardToForm(card, "夏日"), card.outline);
        const source = renderCard(saved, "?").replace("**原句**：Un bel été.", "**原句**：Un autre été.").replace("**笔记**：原笔记", "**笔记**：手改笔记");
        const form = cardToForm(parseCards(source, "?")[0].card, "夏日");
        expect(form.sentences[0].text).toBe("Un autre été.");
        expect(form.notes).toEqual(["手改笔记"]);
    });
    it("表单底稿与保存结果不共享可变数组，防止旧请求被后续输入改写", () => {
        // 独立快照使后台文件写入保持用户点击提交时的内容。
        const form = cardToForm(card, "夏日");
        const saved = formToCard(card, form, card.outline);
        form.tags.push("之后添加");
        form.sentences[0].text = "之后修改";
        expect(saved.tags).toEqual(["季节"]);
        expect(saved.sentences[0].text).toBe("Un bel été.");
    });
});
