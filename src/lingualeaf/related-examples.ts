import { expressionKey } from "./domain";
import type { IndexedCard } from "./host";
import { cardToForm } from "./panel-model";
import type { Sentence } from "./panel-model";

/** 按规范化词条索引卡片，兼容旧卡中未统一的词条 ID。 */
export function indexRelatedCards(cards: IndexedCard[]): Map<string, IndexedCard[]> {
    const index = new Map<string, IndexedCard[]>();
    for (const item of cards) {
        const key = expressionKey(item.card.language, item.card.text);
        const bucket = index.get(key);
        if (bucket) bucket.push(item);
        else index.set(key, [item]);
    }
    return index;
}

/** 同名路径在不同笔记库中是不同的文章。 */
function articleKey(item: IndexedCard): string | undefined {
    const source = item.sources?.[0];
    if (source?.kind && source.kind !== "obsidian") return undefined;
    const path = source?.path || item.path;
    return path ? JSON.stringify([source?.vaultId || source?.vaultName || "", path]) : undefined;
}

/** 同一篇文章的例句共享一个出处，每张卡保留自己的语境释义。 */
interface RelatedArticle {
    item: IndexedCard;
    title: string;
    sourceLabel: string;
    contexts: Array<{ examples: Sentence[]; meaning?: string }>;
}

function normalizeMeaning(text: string): string {
    return text.trim().replace(/\s+/g, " ");
}

/** 使用已加载的词库生成按文章组织的展示数据。 */
export function relatedExamples(index: ReadonlyMap<string, IndexedCard[]>, current: IndexedCard): RelatedArticle[] {
    const key = expressionKey(current.card.language, current.card.text);
    const currentArticle = articleKey(current);
    const currentMeaning = normalizeMeaning(current.card.meaning);
    const articles = new Map<string, RelatedArticle>();
    const titleCounts = new Map<string, number>();
    for (const item of index.get(key) || []) {
        const article = articleKey(item);
        if (item.card.id === current.card.id || !article || article === currentArticle) continue;
        const examples = cardToForm(item.card, item.path).sentences.filter(entry => entry.text.trim());
        if (!examples.length) continue;
        const meaning = item.card.meaning.trim();
        const context = { examples, meaning: normalizeMeaning(meaning) === currentMeaning ? undefined : meaning };
        const existing = articles.get(article);
        if (existing) {
            existing.contexts.push(context);
            continue;
        }
        const source = item.sources?.[0];
        const path = source?.path || item.path;
        const title = (path.split("/").pop() || path).replace(/\.md$/i, "");
        const sourceLabel = [source?.vaultName, path].filter(Boolean).join(" / ");
        articles.set(article, { item, title, sourceLabel, contexts: [context] });
        titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }
    return Array.from(articles.values(), group => (titleCounts.get(group.title) || 0) > 1
        ? { ...group, title: group.sourceLabel.replace(/\.md$/i, "") }
        : group);
}
