/** 学习面板之间的查询与刷新事件 */
export interface EventMap extends GlobalEventHandlersEventMap {
    /** 冻结文章来源后填充词典和新词表单 */
    "obsidian-langr-search": CustomEvent<{ selection: string; leafCapture?: import("./lingualeaf/runtime").PanelCapture }>;
    /** 没有可用文章时清空新词表单来源 */
    "lingualeaf-clear-capture": CustomEvent;
    /** 保存词句后刷新单词列表 */
    "obsidian-langr-refresh": CustomEvent<{ expression: string; type: string; status: number }>;
}
