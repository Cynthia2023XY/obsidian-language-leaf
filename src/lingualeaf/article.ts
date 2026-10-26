import type { ArticleContext, LeafCard, LocatedCard } from "./domain";
import { expressionKey } from "./domain";
import { decodeTextEntities } from "./translation";

/** 将单行字段转为无空行的安全卡片正文，阻止输入制造第二张 SR 卡 */
export function cardLine(value: string): string {
    return value.replace(/\r?\n/g, " ").replace(/<!--SR:[\s\S]*?-->/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/:/g, "&#58;").replace(/=/g, "&#61;").replace(/\?/g, "&#63;").trim();
}
/** 从卡片文本恢复实体转义，避免编辑时丢失尖括号等原文 */
export function decodeCardLine(value: string): string {
    return value.replace(/&#58;/g, ":").replace(/&#61;/g, "=").replace(/&#63;/g, "?").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
/** 从 Markdown 表示提取用于选区定位的可读文本 */
export function plainText(value: string): string {
    return decodeTextEntities(value).replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[*_`]/g, "").replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[entity] || entity)).replace(/\s+/g, " ").trim();
}
/** 仅在非代码块位置定位 fenced block，兼容波浪线和长围栏 */
export function fencedBlocks(source: string): Array<{ info: string; body: string; from: number; to: number }> {
    // 逐行偏移保留 CRLF 原始字节，不把示例中的代码当成元数据。
    const result: Array<{ info: string; body: string; from: number; to: number }> = [];
    // 当前尚未结束的围栏及内容起点。
    let open: { mark: string; info: string; from: number; bodyFrom: number } | null = null;
    // 当前行的源文件偏移。
    let offset = 0;
    for (const line of (source.match(/[^\n]*\n|[^\n]+$/g) || [])) {
        // Markdown 围栏最多允许三个前导空格。
        const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
        if (!open && match) open = { mark: match[1], info: match[2].trim(), from: offset, bodyFrom: offset + line.length };
        else if (open && match && match[1][0] === open.mark[0] && match[1].length >= open.mark.length && !match[2].trim()) {
            result.push({ info: open.info, body: source.slice(open.bodyFrom, offset), from: open.from, to: offset + line.length });
            open = null;
        }
        offset += line.length;
    }
    if (open) result.push({ info: open.info, body: source.slice(open.bodyFrom), from: open.from, to: source.length });
    return result;
}
/** 掩去代码和 frontmatter，但保持源文件偏移以用于定位 */
export function articleBody(source: string): string {
    // 排除数据区、源码示例以及 YAML。
    const ranges = fencedBlocks(source).map(block => [block.from, block.to]);
    // YAML 仅能出现在文件开头。
    const front = source.match(/^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (front) ranges.push([0, front[0].length]);
    // 文末 LL 卡片不是学习文章正文。
    const cards = source.indexOf("<!-- ll-card:");
    if (cards >= 0) ranges.push([cards, source.length]);
    return ranges.sort((a, b) => b[0] - a[0]).reduce((text, range) => text.slice(0, range[0]) + text.slice(range[0], range[1]).replace(/[^\r\n]/g, " ") + text.slice(range[1]), source);
}
/** 从符合约定的唯一段落读取已有中文，重复段落时拒绝猜配 */
export function extractContext(source: string, selected: string, outline: string, paragraphHint?: string): ArticleContext {
    // 保留自然段和紧随的翻译 callout，不推测句子级一对一翻译。
    const paragraphs = articleBody(source).split(/\r?\n\s*\r?\n|\r?\n(?=>\s*\[!translation\][+-]?(?:[^\r\n]*)$)/m);
    // 同文重复时必须通过渲染段落上下文缩小候选。
    const candidates = paragraphs.map((paragraph, index) => ({ paragraph, index }))
        .filter(item => !/^\s*(>|#{1,6} |[-*] )/.test(item.paragraph) && plainText(item.paragraph).includes(plainText(selected)))
        .filter(item => !paragraphHint || plainText(item.paragraph) === plainText(paragraphHint));
    if (candidates.length !== 1) throw new Error(candidates.length ? "选区来源重复，请缩小选区或通过所在段落查询" : "无法唯一定位正文，请在普通段落中重新选择");
    // 当前段落后只能跟一个明确的 translation callout。
    const current = candidates[0];
    // 翻译必须位于紧随的块，不能跨标题和其他正文找译文。
    const next = paragraphs[current.index + 1] || "";
    // 仅接受整块引用，避免把其他段落吞进译文。
    const translation = /^>\s*\[!translation\][+-]?[^\n]*\r?\n/i.test(next) && next.split(/\r?\n/).every(line => !line.trim() || /^>/.test(line))
        ? next.split(/\r?\n/).slice(1).map(line => line.replace(/^>\s?/, "")).join("\n").trim() : "";
    return { sentence: plainText(current.paragraph), translation, outline, anchor: plainText(current.paragraph) };
}
/** 验证持久元数据而不信任导入文件的任意对象 */
export function validateCard(value: unknown): LeafCard {
    // 运行时校验保证恶意或损坏元数据不进入文件写回流程。
    const card = value as LeafCard;
    if (!card || !["id", "expressionId", "language", "text", "meaning", "sentence", "translation", "outline", "notes", "anchor"].every(key => typeof (card as any)[key] === "string") ||
        !/^[a-zA-Z0-9-]+$/.test(card.id) || !/^[a-zA-Z0-9-]+$/.test(card.expressionId) || !card.text.trim() || !/^[a-zA-Z0-9-]+$/.test(card.language) ||
        (card.tags !== undefined && (!Array.isArray(card.tags) || !card.tags.every(tag => typeof tag === "string"))) ||
        !["word", "phrase"].includes(card.kind) || card.owner !== "spaced-repetition") throw new Error("卡片元数据损坏或版本不兼容");
    if (card.noteEntries !== undefined && (!Array.isArray(card.noteEntries) || !card.noteEntries.every(entry => typeof entry === "string"))) throw new Error("笔记结构损坏");
    if (card.sentences !== undefined && (!Array.isArray(card.sentences) || !card.sentences.every(entry => entry && [entry.text, entry.trans, entry.origin].every(value => typeof value === "string")))) throw new Error("例句结构损坏");
    return { ...(card.noteEntries ? { noteEntries: card.noteEntries } : {}), ...(card.sentences ? { sentences: card.sentences } : {}), id: card.id, expressionId: card.expressionId, language: card.language, text: card.text, meaning: card.meaning,
        sentence: card.sentence, translation: card.translation, outline: card.outline, notes: card.notes, anchor: card.anchor, kind: card.kind, owner: card.owner, ...(card.tags ? { tags: card.tags } : {}) };
}
/** 生成可直接由 Spaced Repetition 读取的多行闪卡 */
export function renderCard(card: LeafCard, separator: string, schedule = ""): string {
    card = validateCard(card);
    // 每张卡均使用 SR 的有效多行问答分隔符。
    const delimiter = separator;
    // 元数据仅提供定位与宿主无关身份，正文内容会在解析时反向覆盖快照字段。
    const metadata = { schema: 1, ...card };
    // JSON 作为 HTML 注释时需逃逸连字符序列，防止用户文本提前关闭注释。
    const encoded = JSON.stringify(metadata).replace(/--/g, "\\u002d\\u002d").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    // 用显式换行提供段间留白，物理空行仍保留给 SR 判断卡片边界。
    const answer = [cardLine(card.meaning), card.sentence && `**原句**：${cardLine(card.sentence)}`,
        card.translation && `**译文**：${cardLine(card.translation)}`,
        card.outline && `**概览**：${cardLine(card.outline)}`, card.notes && `**笔记**：${cardLine(card.notes)}`,
        ...(card.sentences || []).slice(1).map(entry => `**补充例句**：${cardLine(JSON.stringify(entry))}`),
        card.sentences?.[0]?.origin && `<small class="ll-card-source">出处：${cardLine(card.sentences[0].origin)}</small>`]
        .filter(Boolean).join('\n<br class="ll-card-gap">\n');
    if (!card.meaning.trim() || !separator.trim() || /[\r\n]/.test(separator)) throw new Error("释义不能为空，分隔符必须是单行文本");
    return `<!-- ll-card: ${card.id} -->\n<!-- ll-meta: ${encoded} -->\n\n#word\n#### ${cardLine(card.text)}\n${delimiter}\n${answer}${schedule ? "\n" + schedule : ""}\n\n<!-- ll-end: ${card.id} -->`;
}
/** 解析管理卡片，并优先读取用户手工编辑的可见题面和答案 */
export function parseCards(source: string, separator: string): LocatedCard[] {
    // 只识别真实正文，忽略围栏里作为示例展示的标记。
    const fences = fencedBlocks(source);
    // 区域标记使局部更新不依赖词条拼写或全局排序。
    const pattern = /<!-- ll-card: ([a-zA-Z0-9-]+) -->\r?\n<!-- ll-meta: (.+?) -->\r?\n\r?\n([\s\S]*?)\r?\n\r?\n<!-- ll-end: \1 -->/g;
    // 卡片身份在单个文件中必须唯一。
    const seen = new Set<string>();
    // 当前文件中校验通过的卡片。
    const cards: LocatedCard[] = [];
    // 当前区域匹配结果。
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        if (fences.some(block => match!.index >= block.from && match!.index < block.to)) continue;
        // 避免对未知协议或损坏元数据自动降级重写。
        const metadata = JSON.parse(match[2]);
        if (metadata.schema !== 1) throw new Error("未知闪卡协议版本，已停止自动写回");
        // 内容是权威，元数据中只是恢复快照。
        const card = validateCard(metadata);
        if (card.id !== match[1] || seen.has(card.id)) throw new Error("文章内存在重复或不一致的卡片 ID");
        seen.add(card.id);
        // SR 可以将调度注释放在末行或单独下一行。
        const schedule = (match[3].match(/<!--SR:[\s\S]*?-->/g) || []).join("\n");
        // 从显示内容中分离 SR 注释，不改变注释原文。
        const lines = match[3].replace(/<!--SR:[\s\S]*?-->/g, "").split(/\r?\n/)
            .filter(line => !/^<br class="ll-card-gap">(?:<br>)?$/.test(line.trim()))
            .map(line => line.replace(/^<small class="ll-card-source">出处：(.*)<\/small>$/, "**出处**：$1"));
        // 标题保持 H4，以兼容旧发音交互。
        const title = lines.findIndex(line => line.startsWith("#### "));
        // 题面与答案按当前 SR 多行问答格式解析。
        const split = lines.indexOf(separator);
        if (title < 0 || split !== title + 1 || !lines[split + 1]?.trim()) throw new Error("闪卡题面或分隔符损坏，请检查设置和手工修改");
        card.text = decodeCardLine(lines[title].slice(5).trim());
        card.meaning = decodeCardLine(lines[split + 1].trim());
        // 连续字段行协议让手工改释义和笔记后仍可重新建立索引。
        const field = (...labels: string[]): string => {
            const label = labels.find(label => lines.slice(split + 2).some(line => line.startsWith(`**${label}**：`)));
            return label ? lines.slice(split + 2).filter(line => line.startsWith(`**${label}**：`)).map(line => decodeCardLine(line.slice(label.length + 5))).join("\n") : "";
        };
        card.sentence = field("原句");
        card.translation = field("译文", "本文译文（段落）");
        card.outline = field("概览", "文章概览（收录时）");
        // 未识别的旧格式行作为笔记保留，不能在第一次编辑时丢弃原文信息。
        const extra = lines.slice(split + 2).filter(line => line.trim() && !/^\*\*(原句|译文|本文译文（段落）|概览|文章概览（收录时）|笔记|补充例句|出处|例句出处)\*\*：/.test(line));
        card.notes = [field("笔记"), extra.join("；")].filter(Boolean).join("；");
        // 可见字段是权威；手改后同步第一条例句和笔记，避免隐藏快照覆盖正文。
        if (card.sentences) {
            // 正文仅合并换行以兼容 SR；未被手改的表单字段保留原来的多行结构。
            const first = card.sentences[0];
            // 对照可见内容后恢复换行，手改字段仍使用当前正文。
            const restore = (snapshot: string | undefined, visible: string): string => snapshot !== undefined && decodeCardLine(cardLine(snapshot)) === visible ? snapshot : visible;
            // 用户删除所有例句后不额外生成一条空记录。
            const primary = first || card.sentence || card.translation || field("出处", "例句出处") ? [{ text: restore(first?.text, card.sentence), trans: restore(first?.trans, card.translation), origin: restore(first?.origin, field("出处", "例句出处")) }] : [];
            card.sentences = [...primary, ...lines.slice(split + 2).filter(line => line.startsWith("**补充例句**：")).map(line => {
            // 补充例句以单行 JSON 保存，避免 SR 将空行识别为卡片边界。
            const entry = JSON.parse(decodeCardLine(line.slice("**补充例句**：".length)));
            if (!entry || ![entry.text, entry.trans, entry.origin].every(value => typeof value === "string")) throw new Error("补充例句结构损坏");
            return entry;
        })];
        }
        if (card.noteEntries && decodeCardLine(cardLine(card.noteEntries.join("；"))) !== card.notes) card.noteEntries = card.notes ? [card.notes] : [];
        cards.push({ card, from: match.index, to: match.index + match[0].length, schedule });
    }
    // 不完整区域也不能被当作“没有卡片”后再追加重复记录。
    const starts = [...source.matchAll(/<!-- ll-card: /g)].filter(item => !fences.some(block => item.index! >= block.from && item.index! < block.to));
    if (starts.length !== cards.length) throw new Error("检测到不完整的 Language Leaf 闪卡区域，已停止写入");
    return cards;
}
/** 保持 CRLF 风格，只局部增改同一文章中的同一词条卡片 */
export function upsertCard(source: string, card: LeafCard, separator: string, deckTag: string): string {
    // 在写前校验整份文件，损坏卡片不能被忽略。
    const cards = parseCards(source, separator);
    // 同文同词重复添加合并，不覆盖其他文章的卡片进度。
    const previous = cards.find(item => item.card.id === card.id || expressionKey(item.card.language, item.card.text) === expressionKey(card.language, card.text));
    // 保留旧的卡片和词条身份，更新用户本次确认的内容。
    const next = previous ? { ...card, id: previous.card.id, expressionId: previous.card.expressionId, owner: previous.card.owner } : card;
    // 局部修改保持文件换行习惯。
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    // SR 管理的数据必须来自刚刚重读的文章。
    const rendered = renderCard(next, separator, previous?.schedule).replace(/\n/g, newline);
    if (previous) return source.slice(0, previous.from) + rendered + source.slice(previous.to);
    if (!/^#[\p{L}\p{N}_/-]+$/u.test(deckTag)) throw new Error("卡组标签格式无效");
    // 首次收词才补文章身份，原有 YAML 字段保持原样。
    const front = source.match(/^(\uFEFF?(?:[ \t]*\r?\n)*---\r?\n)[\s\S]*?\r?\n---(?:\r?\n|$)/);
    // 文章 ID 独立于可变路径，在重复重试时保持稳定。
    const identity = `ll-article-id: "article-${card.id}"${newline}ll-language: "${card.language}"${newline}`;
    if (!front) source = `---${newline}${identity}---${newline}${newline}` + source;
    else if (!/^ll-article-id:/m.test(front[0])) {
        // 已有语言声明不覆盖，其他 frontmatter 的注释和排版保持不变。
        const additions = `ll-article-id: "article-${card.id}"${newline}` + (/^ll-language:/m.test(front[0]) ? "" : `ll-language: "${card.language}"${newline}`);
        source = source.slice(0, front[1].length) + additions + source.slice(front[1].length);
    }
    return source + (source.endsWith(newline) ? newline : newline + newline) +
        (cards.length ? "" : `## 本文词句${newline}${newline}${deckTag + newline + newline}`) + rendered + newline;
}
