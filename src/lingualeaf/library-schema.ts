import type { LeafCard } from "./domain";
import { expressionKey } from "./domain";
import type { LibraryCatalog, LibraryRecord } from "./learning-core";

/** 独立词条，只负责表达和规范化身份 */
export interface LibraryExpression {
    /** 稳定词条身份 */
    id: string;
    /** 表达语言 */
    language: string;
    /** 原始表达 */
    text: string;
    /** 用于合并和检索的规范键 */
    key: string;
}
/** 学习资料只拥有语境和编辑版本，不拥有复习调度 */
export interface LibraryMaterial extends Omit<LibraryRecord, "card"> {
    /** 资料自身身份，当前沿用原语境身份 */
    id: string;
    /** 资料当时收录的表达字形，规范词条仍可共用 */
    displayText?: string;
    /** 对应独立词条 */
    expressionId: string;
    /** 可生成多种复习题型的完整学习内容 */
    content: Omit<LeafCard, "id" | "expressionId" | "language" | "text" | "kind" | "owner">;
}
/** 复习卡片关联资料和题型，FSRS 状态仍由事件仓库管理 */
export interface LibraryReviewCard {
    /** 原复习身份不变，历史无需重写 */
    id: string;
    /** 复习考查的学习资料 */
    materialId: string;
    /** 当前支持的表达题型 */
    kind: LeafCard["kind"];
    /** 当前调度归属 */
    owner: LeafCard["owner"];
}
/** 磁盘格式与界面兼容投影明确分离 */
interface NormalizedCatalog extends Omit<LibraryCatalog, "schema" | "records"> {
    /** 旧客户端必须拒绝新格式，不允许降级覆盖 */
    schema: 3;
    /** 独立表达实体 */
    expressions: LibraryExpression[];
    /** 资料实体 */
    materials: LibraryMaterial[];
    /** 复习题型实体 */
    cards: LibraryReviewCard[];
}
/** 序列化为独立实体，历史 schema 2 只作为兼容输入 */
export function encodeCatalog(catalog: LibraryCatalog): string {
    // 去掉兼容投影，磁盘只保存一份资料和表达。
    const { records, schema: _schema, ...metadata } = catalog;
    // 同表达统一一个词条，修复旧版遗留的词条身份串联。
    const expressions = new Map<string, LibraryExpression>();
    // 资料和题型各自拥有身份与职责。
    const materials: LibraryMaterial[] = [];
    // 现有每个资料保留一张原有复习卡，不改变进度归属。
    const cards: LibraryReviewCard[] = [];
    // 旧库可能把同一个身份分给不同表达，需要在编码时隔离。
    const occupied = new Set<string>();
    for (const record of records) {
        // 卡片字段分离为表达、资料和题型。
        const { id, expressionId, language, text, kind, owner, ...content } = record.card;
        // 语言与规范化文本决定共享表达，不使用文章来源作为身份。
        const key = expressionKey(language, text);
        if (!expressions.has(key)) {
            // 碰撞时使用稳定派生身份，重试编码不会随机分叉。
            const identity = occupied.has(expressionId) ? `${expressionId}-${id}` : expressionId;
            expressions.set(key, { id: identity, language, text, key }); occupied.add(identity);
        }
        // 收录记录与出处属于资料，调度历史属于卡片。
        const { card: _card, ...attributes } = record;
        materials.push({ ...attributes, id, displayText: text, expressionId: expressions.get(key)!.id, content });
        cards.push({ id, materialId: id, kind, owner });
    }
    // 兼容界面仍通过 catalog() 获取 LeafCard 投影。
    const snapshot: NormalizedCatalog = { ...metadata, schema: 3, expressions: [...expressions.values()], materials, cards };
    return JSON.stringify(snapshot, null, 2);
}
/** 校验实体引用后重建旧界面投影，未来客户端可直接使用独立实体 */
export function decodeCatalog(raw: string): LibraryCatalog {
    // schema 2 从不隐式覆盖磁盘，成功写入时才升级。
    const value = JSON.parse(raw);
    if (value?.schema !== 3) return value;
    if (!Array.isArray(value.expressions) || !Array.isArray(value.materials) || !Array.isArray(value.cards)) throw new Error("学习库实体格式损坏");
    // 显式类型只在形状验证后使用。
    const snapshot = value as NormalizedCatalog;
    // 唯一索引防止引用被重复实体静默覆盖。
    const expressions = new Map(snapshot.expressions.map(item => [item.id, item]));
    // 资料身份独立于其复习题型。
    const materials = new Map(snapshot.materials.map(item => [item.id, item]));
    if (expressions.size !== snapshot.expressions.length || materials.size !== snapshot.materials.length || new Set(snapshot.cards.map(item => item.id)).size !== snapshot.cards.length) throw new Error("学习库实体身份重复");
    // 丢失资料或词条的卡片不能降级为空内容。
    const records = snapshot.cards.map(card => {
        // 获取复习卡片所属资料和词条。
        const material = materials.get(card.materialId);
        // 资料引用无效时立即拒绝整个库。
        const expression = material && expressions.get(material.expressionId);
        if (!material || !expression || expressionKey(expression.language, expression.text) !== expression.key) throw new Error("学习库实体引用损坏");
        // 资料元信息映射回兼容界面，不传播存储布局。
        const { id: _id, displayText, expressionId: _expressionId, content, ...attributes } = material;
        return { ...attributes, card: { ...content, id: card.id, expressionId: expression.id, language: expression.language, text: displayText ?? expression.text, kind: card.kind, owner: card.owner } };
    });
    // 元信息排除实体集合，避免每次读取重复扩散数据。
    const { expressions: _expressions, materials: _materials, cards: _cards, schema: _schema, ...metadata } = snapshot;
    return { ...metadata, schema: 2, records };
}
