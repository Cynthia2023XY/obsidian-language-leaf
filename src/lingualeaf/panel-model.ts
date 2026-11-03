import type { ArticleContext, LeafCard } from "./domain";

/** 一条可编辑例句及文章出处 */
export interface Sentence {
    /** 原文例句 */
    text: string;
    /** 中文对照 */
    trans: string;
    /** 例句来源 */
    origin: string;
}
/** 右侧新词面板使用的词句表单 */
export interface ExpressionInfo {
    /** 词句原文 */
    expression: string;
    /** 当前语境释义 */
    meaning: string;
    /** WORD 单词、PHRASE 短语 */
    t: string;
    /** 自由分类标签 */
    tags: string[];
    /** 多条学习笔记 */
    notes: string[];
    /** 多条例句与对照译文 */
    sentences: Sentence[];
}

/** 随文卡片转换为原插件可直接编辑的词条表单 */
export function cardToForm(card: LeafCard, origin: string): ExpressionInfo {
    return { expression: card.text, meaning: card.meaning.replace(/[\r\n]+/g, " "), t: card.kind === "phrase" ? "PHRASE" : "WORD",
        tags: [...(card.tags || [])],
        notes: [...(card.noteEntries || (card.notes ? [card.notes] : []))],
        sentences: (card.sentences || (card.sentence ? [{ text: card.sentence, trans: card.translation, origin }] : [])).map(entry => ({ ...entry })) };
}

/** 再次划词收录时优先展示当前语境，同时保留已有例句和手工管理字段。 */
export function withCaptureContext(card: LeafCard, context: ArticleContext, origin: string): LeafCard {
    // 历史例句转换为独立副本，面板编辑不能提前修改索引中的旧卡。
    const previous = cardToForm(card, origin).sentences;
    const key = (text: string): string => text.replace(/\s+/g, " ").trim();
    const matched = previous.find(entry => key(entry.text) === key(context.sentence));
    const primary = { text: context.sentence, trans: context.translation || matched?.trans || "", origin: matched?.origin || origin };
    const sentences = context.sentence.trim()
        ? [primary, ...previous.filter(entry => key(entry.text) !== key(context.sentence))]
        : previous;
    return { ...card, ...context, sentence: sentences[0]?.text || "", translation: sentences[0]?.trans || "", sentences };
}

/** 原表单提交为随文卡片，保留语言、来源身份及复习归属 */
export function formToCard(card: LeafCard, model: ExpressionInfo, outline: string): LeafCard {
    if (!model.expression?.trim() || !model.meaning?.trim()) throw new Error("请填写词句和释义");
    // 使用独立对象冻结表单内容，后续编辑不会改变已入队写回的数据。
    const sentences = model.sentences.map(entry => ({ text: entry.text || "", trans: entry.trans || "", origin: entry.origin || "" }));
    // 多条笔记仍逐条保留，卡片答案使用连续文本防止 SR 提前截断。
    const notes = model.notes.map(entry => entry || "");
    return { ...card, text: model.expression.trim(), meaning: model.meaning.replace(/[\r\n]+/g, " ").trim(), kind: model.t === "PHRASE" ? "phrase" : "word",
        tags: [...model.tags], notes: notes.join("；"), noteEntries: notes, sentences,
        sentence: sentences[0]?.text || "", translation: sentences[0]?.trans || "", outline };
}
