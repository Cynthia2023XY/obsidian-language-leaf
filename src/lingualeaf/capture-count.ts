import { expressionKey } from "./domain";
import type { LeafCard } from "./domain";
import type { CaptureOperation } from "./storage";

/** 统计已完成的主动收录请求，来源删除不清除曾经收录的事实 */
export function captureCounts(cards: Array<{ card: LeafCard }>, operations: CaptureOperation[]): Map<string, number> {
    // 同一请求重复保存或崩溃恢复只计一次。
    const identities = new Map<string, Set<string>>();
    // 有计数日志的卡片不再额外使用默认一次的基数。
    const tracked = new Set<string>();
    // 统一按语言与规范化表达归并，重音和不同语言仍分开。
    const add = (card: LeafCard, id: string): void => {
        // 单词与短语使用同一个身份标准。
        const key = expressionKey(card.language, card.text);
        if (!identities.has(key)) identities.set(key, new Set());
        identities.get(key)!.add(id);
    };
    for (const operation of operations) {
        if (!operation.done || !operation.captureId) continue;
        tracked.add(operation.card.id);
        add(operation.card, `capture:${operation.captureId}`);
        if (operation.legacyCapture) add(operation.card, `baseline:${operation.card.id}`);
    }
    for (const item of cards) if (!tracked.has(item.card.id)) add(item.card, `baseline:${item.card.id}`);
    return new Map([...identities].map(([key, values]) => [key, values.size]));
}
