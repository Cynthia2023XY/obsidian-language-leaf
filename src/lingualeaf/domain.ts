/** 文章内的词句记录及回忆上下文 */
export interface LeafCard {
    /** 跨重启保持不变的卡片身份 */
    id: string;
    /** 同语言同形词共享的词条身份 */
    expressionId: string;
    /** 学习语言标识 */
    language: string;
    /** 用户收录的词句原文 */
    text: string;
    /** 当前语境中的释义 */
    meaning: string;
    /** 所在正文段落 */
    sentence: string;
    /** 文章已有中文或用户补充译文 */
    translation: string;
    /** 收录时文章概览快照 */
    outline: string;
    /** 用户补充的学习笔记 */
    notes: string;
    /** 选区前后文用于定位与诊断 */
    anchor: string;
    /** 单词与短语的用户选择 */
    kind: "word" | "phrase";
    /** 用户管理词条的标签 */
    tags?: string[];
    /** 原新词表单的多条笔记，保留逐条编辑结构 */
    noteEntries?: string[];
    /** 原新词表单的多条例句与出处 */
    sentences?: Array<{ text: string; trans: string; origin: string }>;
    /** 卡片调度归属 */
    owner: "spaced-repetition";
}
/** Markdown 卡片与文件中精确位置的对应 */
export interface LocatedCard {
    /** 解析后的词句内容 */
    card: LeafCard;
    /** 受管理区域开始偏移 */
    from: number;
    /** 受管理区域结束偏移 */
    to: number;
    /** SR 插件原始调度注释 */
    schedule: string;
}
/** 原文选区对应的可追溯上下文 */
export interface ArticleContext {
    /** 英文原段落，避免伪造句界 */
    sentence: string;
    /** 紧随原段落的已有译文 */
    translation: string;
    /** 可选的文章大纲 */
    outline: string;
    /** 选区附近保留的文本 */
    anchor: string;
}
/** 宿主无关的稳定身份生成器 */
export function newId(): string {
    // 使用标准随机字节，兼容未在类型库中声明 randomUUID 的宿主。
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    // UUID 版本与变体位按标准固定。
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** 保留重音与原文字形，只处理检索所需的空白和大小写 */
export function expressionKey(language: string, text: string): string {
    return `${language.toLowerCase()}:${text.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase(language)}`;
}
