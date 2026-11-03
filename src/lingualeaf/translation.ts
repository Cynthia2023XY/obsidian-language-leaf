/** 还原文本中的 HTML 实体，兼容第三方译文的重复转义和全角分号 */
export function decodeTextEntities(value: string): string {
    // 限定层数，避免不可信文本造成无界转换；不把输入当作 HTML 执行。
    for (let pass = 0; pass < 4; pass++) {
        // 只修复能明确识别的实体，不猜测已经丢失的引号或翻译语义。
        const normalized = value.replace(/&\s*#\s*(x\s*[\da-f]+|\d+)\s*[;；]/gi, (_, token: string) => `&#${token.replace(/\s/g, "")};`);
        const next = normalized.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#(?:x[\da-f]+|\d+))[;；]/gi, entity => {
            // 命名实体仅处理与正文有关的常用字符。
            const token = entity.slice(1, -1).toLowerCase();
            if (!token.startsWith("#")) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[token] || entity;
            // 数值实体校验 Unicode 范围，损坏数值保持原样供用户判断。
            const point = token.startsWith("#x") ? parseInt(token.slice(2), 16) : Number(token.slice(1));
            return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
        });
        if (next === value) break;
        value = next;
    }
    return value;
}

/** 从有道段落结果中提取纯文本译文，不向表单或文章插入第三方 HTML */
export function translationText(html: string): string {
    // 沿用有道原文、译文两个段落的结构，不将原文误当译文。
    const paragraph = new DOMParser().parseFromString(html, "text/html").querySelectorAll("p")[1];
    return decodeTextEntities(paragraph?.textContent || "");
}

/** 按原文段落翻译，保留分段；缺失任一段译文时不生成错位的部分结果。 */
export async function translateContext(text: string, translate: (paragraph: string) => Promise<string>): Promise<string> {
    const parts = text.split(/(\n+)/);
    for (let index = 0; index < parts.length; index++) {
        if (!parts[index].trim()) continue;
        parts[index] = await translate(parts[index]);
        if (!parts[index].trim()) return "";
    }
    return parts.join("");
}
