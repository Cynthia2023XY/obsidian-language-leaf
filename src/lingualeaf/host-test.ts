import { describe, it, expect, vi } from "vitest";
import { TFile } from "obsidian";
import { LeafHost } from "./host";
import { parseCards } from "./article";
import type { LeafCard } from "./domain";

vi.mock("obsidian", () => {
    /** 测试文件只提供宿主需要的身份字段 */
    class TestFile {
        /** 文件路径与改名后的身份 */
        path: string;
        /** 可索引的扩展名 */
        extension: string;
        /** 创建模拟文件 */
        constructor(path: string) { this.path = path; this.extension = path.split(".").pop()!; }
    }
    return { TFile: TestFile, normalizePath: (path: string) => path, parseYaml: () => ({}) };
});
/** 模拟具有原子 process 的 Vault，覆盖真正的文章写入用例 */
function fixture() {
    // 文件和文件夹分开保存，模拟宿主 instanceof 检查。
    const files = new Map<string, string>([["Article.md", "An old bookmark.\n"]]);
    // 同一个文件对象在读写过程中保持稳定。
    const entries = new Map<string, unknown>([["Article.md", new (TFile as any)("Article.md")]]);
    // 模拟 SR 在 LL 读取之后、提交之前写入调度数据。
    let concurrent: (() => void) | null = null;
    // 宿主 API 的最小实际契约。
    const vault = {
        getAbstractFileByPath: (path: string) => entries.get(path),
        getFiles: () => [...entries.values()].filter(file => file instanceof TFile),
        getMarkdownFiles: () => [...entries.values()].filter(file => file instanceof TFile && file.extension === "md"),
        read: async (file: TFile) => files.get(file.path)!,
        cachedRead: async (file: TFile) => files.get(file.path)!,
        modify: async (file: TFile, content: string) => { files.set(file.path, content); },
        create: async (path: string, content: string) => { files.set(path, content); entries.set(path, new (TFile as any)(path)); },
        createFolder: async (path: string) => { entries.set(path, { path }); },
        process: async (file: TFile, transform: (content: string) => string) => {
            if (concurrent) { concurrent(); concurrent = null; }
            // 回调拿到的是原子提交期间最新原文。
            const output = transform(files.get(file.path)!);
            files.set(file.path, output); return output;
        }
    };
    // 真实 host 使用相同接口，无需修改产品实现以适配测试。
    const host = new LeafHost({ app: { vault } } as any, {});
    // 标准测试卡片的内容与来源。
    const card: LeafCard = { id: "card-original", expressionId: "expression-original", text: "bookmark", language: "en", meaning: "书签", sentence: "An old bookmark.", translation: "", outline: "", notes: "", anchor: "An old bookmark.", kind: "word", owner: "spaced-repetition" };
    return { host, files, entries, card, file: entries.get("Article.md") as TFile, beforeProcess: (run: () => void) => { concurrent = run; } };
}

describe("文章写入与崩溃恢复", () => {
    it("SR 在提交前新增评分也不会被 LL 的旧读取覆盖", async () => {
        // 先创建一张真实管理卡。
        const setup = fixture();
        await setup.host.save(setup.file, setup.card);
        setup.beforeProcess(() => {
            setup.files.set("Article.md", setup.files.get("Article.md")!.replace("书签\n\n<!-- ll-end", "书签\n\n<!-- ll-end").replace("**原句**：An old bookmark.\n\n", "**原句**：An old bookmark.\n<!--SR:!2026-10-22,3,250-->\n\n"));
        });
        await setup.host.save(setup.file, { ...setup.card, meaning: "用户更新释义" });
        expect(parseCards(setup.files.get("Article.md")!, "?")[0].schedule).toBe("<!--SR:!2026-10-22,3,250-->");
    });
    it("同词二次收录在日志中保留真正的旧卡 ID，重放不覆盖后来手改内容", async () => {
        // 二次表单提供新 ID，但落盘应该复用已有卡片。
        const setup = fixture();
        await setup.host.save(setup.file, setup.card);
        await setup.host.save(setup.file, { ...setup.card, id: "new-form-id", meaning: "第二次收录" });
        // 模拟文章已写入，而完成日志尚未持久的崩溃窗口。
        const operations = [...setup.files.keys()].filter(path => path.includes("/operations/"));
        // 找到第二次收录对应的恢复记录。
        const path = operations.find(path => JSON.parse(setup.files.get(path)!).card.meaning === "第二次收录")!;
        // 原始操作身份必须和实际写入的卡片一致。
        const operation = JSON.parse(setup.files.get(path)!);
        expect(operation.card.id).toBe("card-original");
        operation.done = false; setup.files.set(path, JSON.stringify(operation));
        setup.files.set("Article.md", setup.files.get("Article.md")!.replace("第二次收录\n", "用户后来手工修订\n"));
        expect(await setup.host.recover()).toEqual([]);
        expect(parseCards(setup.files.get("Article.md")!, "?")[0].card.meaning).toBe("用户后来手工修订");
    });
    it("原文删除后仍保留全局词条，但不伪造可复习 SR 来源", async () => {
        // 已经落盘的全局实体不随笔记删除丢失。
        const setup = fixture();
        await setup.host.save(setup.file, setup.card);
        setup.entries.delete("Article.md"); setup.files.delete("Article.md");
        // 索引从文件恢复，孤立项没有有效原文路径。
        const cards = await setup.host.scan();
        expect(cards).toHaveLength(1);
        expect(cards[0].path).toBe("");
        expect(cards[0].card.text).toBe("bookmark");
    });
    it("完整预览后的原子替换遇到 SR 并发变化时拒绝覆盖", async () => {
        // 大纲更新与引擎转换必须保护最新版本。
        const setup = fixture();
        setup.beforeProcess(() => setup.files.set("Article.md", "SR 同时修改后的内容"));
        await expect(setup.host.replaceExact(setup.file, "An old bookmark.\n", "新的内容")).rejects.toThrow("已改变");
        expect(setup.files.get("Article.md")).toBe("SR 同时修改后的内容");
    });
    it("删除卡片先备份，保留全局词条，旧待处理操作不复活卡片", async () => {
        // 模拟收录成功而日志尚未结束的中断窗口。
        const setup = fixture();
        await setup.host.save(setup.file, setup.card);
        // 找到最后的持久意图，刻意回退完成标记。
        const path = [...setup.files.keys()].find(path => path.includes("/operations/"))!;
        // 删除记录需胜过历史待处理意图。
        const operation = JSON.parse(setup.files.get(path)!); operation.done = false; setup.files.set(path, JSON.stringify(operation));
        await setup.host.removeCard(setup.file, setup.card.id);
        expect(parseCards(setup.files.get("Article.md")!, "?")).toHaveLength(0);
        expect([...setup.files.keys()].some(path => path.includes("/backups/delete-"))).toBe(true);
        expect(await setup.host.recover()).toEqual([]);
        expect(parseCards(setup.files.get("Article.md")!, "?")).toHaveLength(0);
        expect((await setup.host.scan())[0].card.text).toBe("bookmark");
    });

    it("主动收录累计，重复提交、编辑和恢复不重复计数", async () => {
        // 真实文件落盘后验证同文仍然只有一张 SR 卡。
        const setup = fixture();
        await setup.host.save(setup.file, setup.card, "query-1");
        await setup.host.save(setup.file, { ...setup.card, meaning: "补充含义" }, "query-1");
        expect((await setup.host.scan())[0].captureCount).toBe(1);
        await setup.host.save(setup.file, setup.card, "query-2");
        await setup.host.save(setup.file, { ...setup.card, meaning: "只编辑" });
        expect((await setup.host.scan())[0].captureCount).toBe(2);
        expect(parseCards(setup.files.get("Article.md")!, "?")).toHaveLength(1);
        // 完成标记未写入的崩溃重放必须仍然只计该次请求一次。
        const path = [...setup.files.keys()].find(path => path.includes("/operations/") && JSON.parse(setup.files.get(path)!).captureId === "query-2")!;
        const operation = JSON.parse(setup.files.get(path)!);
        operation.done = false; setup.files.set(path, JSON.stringify(operation));
        expect(await setup.host.recover()).toEqual([]);
        expect((await setup.host.scan())[0].captureCount).toBe(2);
    });
    it("跨文同词共享计数，不同语言分开，删除来源后保留历史", async () => {
        // 不同文章的独立闪卡保留各自的来源身份。
        const setup = fixture();
        await setup.host.save(setup.file, setup.card, "query-en-1");
        // 建立第二个有效 Markdown 来源。
        const second = new (TFile as any)("Second.md");
        setup.entries.set(second.path, second); setup.files.set(second.path, "Another bookmark.");
        await setup.host.save(second, { ...setup.card, id: "second-card", expressionId: "second-expression", text: " BOOKMARK " }, "query-en-2");
        // 相同拼写的法语词仍不能算到英语词条中。
        const french = new (TFile as any)("French.md");
        setup.entries.set(french.path, french); setup.files.set(french.path, "French context.");
        await setup.host.save(french, { ...setup.card, id: "french-card", expressionId: "french-expression", language: "fr" }, "query-fr-1");
        expect((await setup.host.scan()).filter(item => item.card.language === "en").map(item => item.captureCount)).toEqual([2, 2]);
        expect((await setup.host.scan()).find(item => item.card.language === "fr")!.captureCount).toBe(1);
        await setup.host.removeCard(second, "second-card");
        expect((await setup.host.scan()).find(item => item.path === "Article.md")!.captureCount).toBe(2);
    });
    it("已有卡片按一次起算，重新收录增加一次，重启后可重建", async () => {
        // 旧卡没有主动收录请求标记，不从编辑日志推测次数。
        const setup = fixture();
        await setup.host.save(setup.file, setup.card);
        await setup.host.save(setup.file, { ...setup.card, meaning: "旧卡编辑" });
        expect((await setup.host.scan())[0].captureCount).toBe(1);
        await setup.host.save(setup.file, setup.card, "recapture-old");
        expect((await setup.host.scan())[0].captureCount).toBe(2);
        // 新宿主实例只能从文件恢复，不依赖前一个实例内存计数。
        const restarted = new LeafHost(setup.host.plugin, {});
        expect((await restarted.scan())[0].captureCount).toBe(2);
    });

});
