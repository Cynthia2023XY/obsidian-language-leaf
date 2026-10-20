import { describe, it, expect } from "vitest";
import { extractContext, parseCards, renderCard, upsertCard, fencedBlocks } from "./article";
import { expressionKey, newId } from "./domain";
import type { LeafCard } from "./domain";
import { LearningStore } from "./storage";
import type { FilePort } from "./storage";

/** 可重复的测试词句，不依赖宿主或 IndexedDB */
function card(overrides: Partial<LeafCard> = {}): LeafCard {
    return { id: "card-1", expressionId: "expression-1", language: "en", text: "in its place", meaning: "取而代之", sentence: "In its place was a slip of paper.", translation: "取而代之的是纸条。", outline: "书签留下线索", notes: "", anchor: "In its place was a slip of paper.", kind: "phrase", owner: "spaced-repetition", ...overrides };
}
/** 模拟文件持久化，多个仓库实例共用同一份数据 */
function memoryPort(): FilePort & { files: Map<string, string>; failNext: boolean } {
    // 可注入写失败，验证评分不会因重试计入两次。
    const port = {
        files: new Map<string, string>(), failNext: false,
        async read(path: string) { return port.files.get(path) ?? null; },
        async write(path: string, content: string) { if (port.failNext) { port.failNext = false; throw new Error("disk full"); } port.files.set(path, content); },
        async list(prefix: string) { return [...port.files.keys()].filter(path => path.startsWith(prefix)); }
    };
    return port;
}

describe("普通 Markdown 上下文与双语对齐", () => {
    it("折叠翻译按段落读取，不请求在线翻译", () => {
        // 已有英文和中文均为来源证据。
        const source = "The old bookmark was gone. In its place was paper.\n\n> [!translation]-\n> 旧书签不见了。\n> 换成了一张纸。";
        expect(extractContext(source, "In its place", "线索")).toEqual({ sentence: "The old bookmark was gone. In its place was paper.", translation: "旧书签不见了。\n换成了一张纸。", outline: "线索", anchor: "The old bookmark was gone. In its place was paper." });
    });
    it("标题隔开的中文不错误关联", () => {
        expect(extractContext("Hello world.\n\n## 下节\n\n> [!translation]-\n> 你好", "Hello", "").translation).toBe("");
    });
    it("重复段落拒绝第一次匹配，段落提示可缩小范围", () => {
        // 两个段落都含同词，但上下文不同。
        const source = "A blue bookmark.\n\nAnother blue bookmark.";
        expect(() => extractContext(source, "blue", "")).toThrow("重复");
        expect(extractContext(source, "blue", "", "Another blue bookmark.").sentence).toBe("Another blue bookmark.");
    });
    it("代码围栏内的正文示例不参与定位，包括更长外层围栏", () => {
        // 四反引号中的三反引号只是示例文本。
        const source = "````markdown\n```ll-outline\nHello\n```\n````\n\nReal Hello.";
        expect(fencedBlocks(source)).toHaveLength(1);
        expect(extractContext(source, "Hello", "").sentence).toBe("Real Hello.");
    });
    it("带链接和强调的段落按可读文本定位", () => {
        expect(extractContext("The **blue** [bookmark](url) is here.", "blue bookmark", "").sentence).toBe("The blue bookmark is here.");
    });
});

describe("原生闪卡与 SR 进度保留", () => {
    it("生成可直接识别的多行问答且答案内没有空行", () => {
        // 大纲和中文是答案正文的一部分，不需要插件特殊渲染。
        const result = renderCard(card(), "?");
        expect(result).toContain("#word\n#### in its place\n?\n取而代之\n**原句**");
        expect(result).toContain("**文章概览（收录时）**：书签留下线索");
        expect(result).not.toContain("<!--SR:");
        expect(parseCards(result, "?")[0].card).toEqual(card());
    });
    it.each(["\n<!--SR:!2026-10-20,3,250-->", " <!--SR:!2026-10-20,3,250-->"])("保留同行或下一行 SR 注释：%s", suffix => {
        // 模拟 SR 在评分后修改答案末尾。
        const source = "# 正文\n\nHello.\n\n" + renderCard(card(), "?").replace("书签留下线索\n\n", `书签留下线索${suffix}\n\n`);
        // 用户只更新释义，SR 到期数据必须保留。
        const updated = upsertCard(source, card({ meaning: "新的语境释义" }), "?", "#flashcards");
        expect(parseCards(updated, "?")[0].schedule).toBe("<!--SR:!2026-10-20,3,250-->");
        expect(updated.startsWith("# 正文\n\nHello.")).toBe(true);
        expect(updated).toContain("新的语境释义");
    });
    it("同文同词重复添加保持原卡 ID，其他正文保持原样", () => {
        // 用户原有 YAML 和段落在追加卡片时不能被整体改写。
        const source = "---\ntags: [reading]\n---\n\n正文。\n";
        // 首次添加只补身份和词句区。
        const once = upsertCard(source, card(), "?", "#flashcards");
        // 第二次来自新表单的随机身份会被旧卡身份替代。
        const twice = upsertCard(once, card({ id: "card-2", expressionId: "expression-2", meaning: "更新" }), "?", "#flashcards");
        expect(parseCards(twice, "?")).toHaveLength(1);
        expect(parseCards(twice, "?")[0].card.id).toBe("card-1");
        expect(twice).toContain("tags: [reading]\n---\n\n正文。");
        expect(twice).toContain('ll-article-id: "article-card-1"');
    });
    it("保留 CRLF 并且手工改释义后重建索引读取新值", () => {
        // Windows 换行不能因一张卡更新改变全篇。
        const source = upsertCard("正文\r\n", card(), "?", "#flashcards").replace("取而代之\r\n", "手工修订\r\n");
        expect(parseCards(source, "?")[0].card.meaning).toBe("手工修订");
        expect(source.replace(/\r\n/g, "")).not.toContain("\n");
    });
    it("损坏或重复的管理区域阻止自动写回", () => {
        // 不能把损坏卡片当作未收录后再追加一张。
        const source = renderCard(card(), "?");
        expect(() => parseCards(source.replace("ll-end:", "broken:"), "?")).toThrow("不完整");
        expect(() => parseCards(source + "\n\n" + source, "?")).toThrow("重复");
    });
    it("示例代码块中的闪卡不进入真实复习索引", () => {
        expect(parseCards("````markdown\n" + renderCard(card(), "?") + "\n````", "?")).toHaveLength(0);
    });
    it("只接受 SR 归属，不再创建内置复习卡片", () => {
        expect(() => renderCard(card({ owner: "builtin" as any }), "?")).toThrow("不兼容");
    });
    it("注释终止符和 HTML 内容无法突破元数据边界", () => {
        // 用户笔记中出现箭头或脚本也必须作为文本处理。
        const source = renderCard(card({ notes: "a --> b <script>text</script>" }), "?");
        expect(parseCards(source, "?")).toHaveLength(1);
        expect(source).toContain("\\u002d\\u002d");
        expect(source).not.toContain("<script>");
    });

});

describe("多语言词条身份", () => {
    it("英语法语同形词不合并，法语重音保留", () => {
        expect(expressionKey("en", "chat")).not.toBe(expressionKey("fr", "chat"));
        expect(expressionKey("fr", "été")).not.toBe(expressionKey("fr", "ete"));
        expect(expressionKey("en", "  Blue   BOOK  ")).toBe(expressionKey("en", "blue book"));
    });
    it("UUID 稳定格式且连续生成不重复", () => {
        expect(newId()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
        expect(newId()).not.toBe(newId());
    });

});

describe("可恢复收词持久化", () => {
    it("崩溃后待收词操作仍可枚举，完成标记幂等", async () => {
        // 待处理意图和卡片都随文件持久化。
        const port = memoryPort();
        // 新实例验证数据不只存在旧实例缓存。
        const store = new LearningStore(port, "LearningData");
        // 目标文件由宿主层校验，仓库只保存可重放意图。
        const operation = { id: "operation-1", path: "Article.md", card: card(), separator: "?", deck: "#flashcards", done: false };
        await store.capture(operation);
        expect(await new LearningStore(port, "LearningData").pending()).toHaveLength(1);
        await store.capture({ ...operation, done: true });
        expect(await store.pending()).toHaveLength(0);
    });
});
