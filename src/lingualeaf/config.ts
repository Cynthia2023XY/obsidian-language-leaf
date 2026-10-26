import type { LeafSettings } from "./host";

/** 仅保留当前原生学习流程所需的配置 */
export interface LeafPluginSettings {
    /** 原文语言、划词和 SR 格式配置 */
    learning: LeafSettings;
    /** 查词后自动播放发音 */
    auto_pron: boolean;
    /** SR 卡片展示时自动发音 */
    review_auto_pron: boolean;
    /** 有道发音口音，0 美式、1 英式 */
    review_prons: "0" | "1";
    /** 没有已有译文时允许查询段落翻译 */
    use_machine_trans: boolean;
    /** 词典开关与固定的展示顺序 */
    dictionaries: Record<string, { enable: boolean; priority: number }>;
}

/** 从已保存设置中只读取受支持字段，不启动旧数据库或服务器 */
export function readSettings(value: unknown): LeafPluginSettings {
    // 当前格式独立于旧插件配置，未知字段不会进入运行设置。
    const data = value && typeof value === "object" ? value as Partial<LeafPluginSettings> : {};
    // 仅接受当前支持的两种学习语言。
    const learning = data.learning || {} as Partial<LeafSettings>;
    // 保留词典原来的组件与展示顺序，不引入服务端配置。
    const dictionaries: LeafPluginSettings["dictionaries"] = {};
    for (const [index, id] of ["youdao", "cambridge", "jukuu", "hjdict", "deepl"].entries()) {
        dictionaries[id] = { enable: typeof data.dictionaries?.[id]?.enable === "boolean" ? data.dictionaries[id].enable : true, priority: index + 1 };
    }
    return { learning: { language: ["en", "fr"].includes(learning.language) ? learning.language : "en",
        autoQuerySelection: learning.autoQuerySelection === true,
        modifier: ["shiftKey", "ctrlKey", "altKey", "metaKey"].includes(learning.modifier) ? learning.modifier : "shiftKey",
        deck: typeof learning.deck === "string" && /^#[\p{L}\p{N}_/-]+$/u.test(learning.deck) ? learning.deck : "#flashcards",
        separator: typeof learning.separator === "string" && learning.separator.trim() && !/[\r\n<>]/.test(learning.separator) ? learning.separator : "?",
        dataFolder: "LinguaLeafData" },
        auto_pron: data.auto_pron !== false, review_auto_pron: data.review_auto_pron !== false,
        review_prons: data.review_prons === "1" ? "1" : "0", use_machine_trans: data.use_machine_trans !== false, dictionaries };
}
