// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { LearningLibrary } from "./library";
import { ReviewStore, prepare } from "./review/engine";
import { migrateLibrary } from "./library-migration";
import { renderCard } from "./article";
import type { LeafCard } from "./domain";

/** 自动清理测试目录，不碰真实学习库 */
const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
/** 提供完整卡片，不使用真实用户资料 */
const card: LeafCard = { id: "card-one", expressionId: "expression-one", language: "en", text: "leaf", meaning: "叶子", sentence: "A green leaf.", translation: "一片绿叶。", outline: "", notes: "", anchor: "", kind: "word", owner: "builtin" };
/** 在磁盘创建实际学习库，验证跨实例读写而非内存 mock */
async function fixture() {
    // 所有持久化均限制在本测试创建的目录。
    const root = await fs.mkdtemp(path.join(tmpdir(), "leaf-library-test-"));
    temporary.push(root);
    // 学习库与笔记目录彼此独立。
    const library = new LearningLibrary(path.join(root, "library"));
    await library.port.create("catalog.json", JSON.stringify({ schema: 2, id: "library-test", review: { newLimit: 100, retention: .9 }, records: [] }));
    return { root, library };
}

describe("独立学习库真实磁盘行为", () => {
    it("来源不存在也能编辑和评分，重新连接保留内容与进度", async () => {
        // 虚构的来源文章从未创建，验证复习不依赖原库。
        const { library } = await fixture();
        await library.save(card, { vaultId: "vault-one", vaultName: "Missing", path: "missing.md" }, "capture-one");
        // 新实例读取同一数据源。
        const other = new LearningLibrary(library.port.directory);
        await other.save({ ...card, meaning: "独立修改" }, undefined, undefined, 1);
        // 评分引擎直接使用外部事件文件。
        const store = new ReviewStore(other.port, "LinguaLeafData");
        // 评分前状态和输出来自正式 FSRS 引擎。
        const before = await store.state(card.id);
        // 准备实际评分，检查可重启恢复。
        const prepared = prepare(card.id, before, new Date(), .9);
        await store.append({ schema: 1, id: "grade-one", cardId: card.id, at: new Date().toISOString(), session: "test", kind: "grade", before, after: { ...before, revision: 1, card: prepared.choices[3] }, rating: 3, library: "ts-fsrs@5.4.1", retention: .9 });
        expect((await library.catalog()).records[0].card.meaning).toBe("独立修改");
        expect((await new ReviewStore(library.port, "LinguaLeafData").state(card.id)).revision).toBe(1);
    });
    it("重复收录幂等，旧版本编辑被拒绝，软删除不会由旧请求复活", async () => {
        // 两次同请求只记一次主动收录。
        const { library } = await fixture();
        await library.save(card, undefined, "capture-one");
        await library.save({ ...card, meaning: "重复请求" }, undefined, "capture-one");
        expect((await library.catalog()).records[0].captures).toEqual(["capture-one"]);
        expect((await library.catalog()).records[0].card.meaning).toBe("叶子");
        await library.save({ ...card, meaning: "新版本" }, undefined, undefined, 1);
        await expect(library.save(card, undefined, undefined, 1)).rejects.toThrow("其他窗口修改");
        await library.remove(card.id, 2);
        expect((await library.save(card, undefined, "capture-one")).revision).toBe(1);
        expect((await library.catalog()).records[0].deleted).toBe(true);
    });
    it("两个写者竞争相同评分版本时只发布完整的一条", async () => {
        // 两个实例各自读取旧状态，竞争同一评分事件。
        const { library } = await fixture();
        await library.save(card);
        // 另一窗口共享完全相同的事件目录。
        const other = new LearningLibrary(library.port.directory);
        // 独占发布必须拒绝覆盖。
        const results = await Promise.allSettled([library.port.create("events/one.json", JSON.stringify({ id: "a" })), other.port.create("events/one.json", JSON.stringify({ id: "b" }))]);
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect(["a", "b"]).toContain(JSON.parse((await library.port.read("events/one.json"))!).id);
    });
    it("两个库相同文章路径不串卡，卡片内容更改不修改来源字节", async () => {
        // 真实文件用来验证学习库完全不回写。
        const { root, library } = await fixture();
        // 原文章不包含插件标记。
        const article = path.join(root, "Article.md");
        await fs.writeFile(article, "Original article\r\n");
        await library.save(card, { vaultId: "a", vaultName: "A", path: "Article.md" }, "one");
        await library.save({ ...card, id: "card-two" }, { vaultId: "b", vaultName: "B", path: "Article.md" }, "two");
        await library.save({ ...card, meaning: "更新学习资料" }, undefined, undefined, 1);
        await library.remove(card.id);
        expect(await fs.readFile(article, "utf8")).toBe("Original article\r\n");
        expect((await library.catalog()).records).toHaveLength(2);
    });
    it("数据源缺失或损坏不会自动创建或覆盖空库", async () => {
        // 连接错误应明确失败。
        const { root, library } = await fixture();
        await expect(new LearningLibrary(path.join(root, "missing")).catalog()).rejects.toThrow("不存在");
        await library.port.write("catalog.json", "broken");
        await expect(library.save(card)).rejects.toThrow();
        expect(await library.port.read("catalog.json")).toBe("broken");
    });
});

describe("独立学习库迁移", () => {
    it("保留全部语境和孤立快照，进度逐字段一致，重跑不覆盖新编辑", async () => {
        // 创建最小原库，包含两个语境和一个孤立词条。
        const { root } = await fixture();
        // 原库与学习库放在同级目录。
        const vault = path.join(root, "Vault");
        // 新迁移目标与 fixture 的库不同。
        const destination = path.join(root, "migrated");
        await fs.mkdir(path.join(vault, ".obsidian/plugins/language-leaf"), { recursive: true });
        await fs.writeFile(path.join(vault, ".obsidian/plugins/language-leaf/data.json"), JSON.stringify({ learning: { separator: "?" }, review: { newLimit: 200, retention: .9 } }));
        // 两篇文章保留不同语境卡片身份。
        const original = renderCard(card, "?");
        await fs.writeFile(path.join(vault, "A.md"), original);
        await fs.writeFile(path.join(vault, "B.md"), renderCard({ ...card, id: "card-two", sentence: "Another leaf." }, "?"));
        // 孤立快照没有文章也必须导入。
        const port = new LearningLibrary(vault).port;
        await port.write("LinguaLeafData/expressions/orphan.json", JSON.stringify({ schema: 1, card: { ...card, id: "card-orphan", expressionId: "expression-orphan", text: "orphan" }, sourcePath: "Deleted.md" }));
        // 原始评分包含全部字段，迁移后必须完全一致。
        const old = new ReviewStore(port, "LinguaLeafData");
        // 新卡评分事件链的基线。
        const before = await old.state(card.id);
        // 使用固定日期确保到期时间比较具有意义。
        const prepared = prepare(card.id, before, new Date("2026-11-11T08:00:00Z"), .9);
        await old.append({ schema: 1, id: "old-grade", cardId: card.id, at: "2026-11-11T08:00:00Z", session: "old", kind: "grade", before, after: { ...before, revision: 1, card: prepared.choices[3] }, library: "ts-fsrs@5.4.1", retention: .9 });
        expect((await migrateLibrary({ vault, destination })).totalCards).toBe(3);
        // 预览不得创建目标目录。
        await expect(fs.stat(destination)).rejects.toThrow();
        // 实际迁移返回经过原文件校验的结果。
        const report = await migrateLibrary({ vault, destination, apply: true });
        expect(report.originalNotesUnchanged).toBe(true);
        expect(await fs.readFile(path.join(vault, "A.md"), "utf8")).toBe(original);
        // 新资料可以在删除原文章后继续编辑和读取。
        const library = new LearningLibrary(destination);
        expect(await new ReviewStore(library.port, "LinguaLeafData").state(card.id)).toEqual(await old.state(card.id));
        await library.save({ ...card, meaning: "迁移后编辑" }, undefined, undefined, 1);
        expect((await migrateLibrary({ vault, destination, apply: true })).alreadyMigrated).toBe(true);
        expect((await library.catalog()).records.find(record => record.card.id === card.id)!.card.meaning).toBe("迁移后编辑");
    });
});

describe("架构升级后的并发与恢复", () => {
    it("同词不同语境改成另一词时重新绑定身份并保留卡片身份", async () => {
        // 两张资料原先共享一个词条。
        const { library } = await fixture();
        await library.save(card);
        await library.save({ ...card, id: "another-card" });
        // 修改当前语境表达不影响另外一张资料。
        const changed = await library.save({ ...card, text: "tree" }, undefined, undefined, 1);
        expect(changed.card.id).toBe(card.id);
        expect(changed.card.expressionId).not.toBe(card.expressionId);
        expect((await library.catalog()).records.find(item => item.card.id === "another-card")!.card.expressionId).toBe(card.expressionId);
        // 改到已有词条时使用已有身份。
        const shared = await library.save({ ...card, id: "third-card", text: "tree" });
        expect(shared.card.expressionId).toBe(changed.card.expressionId);
        expect(JSON.parse((await library.port.read("catalog.json"))!).schema).toBe(3);
        expect(await library.port.read("backups/schema-2-library-test.json")).toBeTruthy();
    });
    it("已提交收录在后续编辑后重试返回原始确认结果", async () => {
        // 第一次请求成功但客户端假设确认丢失。
        const { library } = await fixture();
        const committed = await library.save(card, undefined, "operation-one");
        await library.save({ ...card, meaning: "后续人工编辑" }, undefined, undefined, 1);
        expect(await library.save(card, undefined, "operation-one", 0)).toEqual(committed);
        expect((await library.catalog()).records[0].card.meaning).toBe("后续人工编辑");
    });
    it("共享设置按字段合并，同字段旧基线明确冲突", async () => {
        // 两个窗口分别修改不同设置。
        const { library } = await fixture();
        const other = new LearningLibrary(library.port.directory);
        await library.configure({ newLimit: 150 }, { newLimit: 100 });
        await other.configure({ retention: .92 }, { retention: .9 });
        expect((await library.catalog()).review).toEqual({ newLimit: 150, retention: .92 });
        await expect(other.configure({ newLimit: 200 }, { newLimit: 100 })).rejects.toThrow("其他窗口修改");
    });
    it("连接身份不匹配时拒绝另一份有效学习库", async () => {
        // 路径存在且内容有效也不能掩盖库身份错误。
        const { library } = await fixture();
        await expect(new LearningLibrary(library.port.directory, "wrong-library").catalog()).rejects.toThrow("身份不匹配");
    });
    it("最后一个新卡额度被另一个窗口用掉后，提交拒绝超额评分", async () => {
        // 固定时钟与真实文件，两个独立服务实例共用同一库。
        const { library } = await fixture();
        const { ReviewService } = await import("./review/service");
        const now = new Date("2026-11-13T06:00:00Z");
        await library.configure({ newLimit: 10 });
        for (let index = 0; index < 11; index++) await library.save({ ...card, id: `quota-${index}` });
        const first = new ReviewService(library.port, "LinguaLeafData", library, () => now);
        const otherLibrary = new LearningLibrary(library.port.directory);
        const second = new ReviewService(otherLibrary.port, "LinguaLeafData", otherLibrary, () => now);
        for (let index = 0; index < 9; index++) {
            // 前九个新卡均成功提交。
            const prepared = first.preview(`quota-${index}`, await first.store.state(`quota-${index}`), .9);
            await first.commit(first.grade(prepared, 3, "first"));
        }
        // 两个窗口都在队列时看见最后一个额度。
        const a = first.grade(first.preview("quota-9", await first.store.state("quota-9"), .9), 3, "first");
        const b = second.grade(second.preview("quota-10", await second.store.state("quota-10"), .9), 3, "second");
        await first.commit(a);
        await expect(second.commit(b)).rejects.toThrow("额度已用完");
        // 成功请求即便额度已满仍可确认重试。
        await first.commit(a);
        expect((await second.store.state("quota-10")).revision).toBe(0);
        await first.undo(a);
        await second.commit(b);
        expect((await second.store.state("quota-10")).revision).toBe(1);
    });
    it("第二库追加保留同名语境、次数和历史，确认丢失后重跑不重复导入", async () => {
        // 两份来源可以包含相同卡片 ID，目标必须隔离。
        const { root, library } = await fixture();
        const { LibraryManager } = await import("./library-manager");
        const manager = new LibraryManager();
        const source = await manager.create(path.join(root, "second-library"));
        await library.save(card, undefined, "target-capture");
        await source.save({ ...card, meaning: "第二库语境" }, { vaultId: "second", vaultName: "Second", path: "same.md" }, "source-capture");
        const review = new ReviewStore(source.port, "LinguaLeafData");
        const before = await review.state(card.id);
        const prepared = prepare(card.id, before, new Date("2026-11-13T06:00:00Z"), .9);
        await review.append({ schema: 1, id: "source-grade", cardId: card.id, at: prepared.at.toISOString(), session: "source", kind: "grade", before, after: { ...before, revision: 1, card: prepared.choices[3] }, rating: 3, retention: .9, library: "ts-fsrs@5.4.1" });
        expect(await manager.import(library, source.port.directory)).toEqual({ imported: 1, alreadyImported: false });
        const records = (await library.catalog()).records;
        expect(records).toHaveLength(2);
        const imported = records.find(item => item.card.id !== card.id)!;
        expect(imported.card.meaning).toBe("第二库语境");
        expect(imported.card.expressionId).toBe(records[0].card.expressionId);
        expect(await new ReviewStore(library.port, "LinguaLeafData").state(imported.card.id)).toEqual(await review.state(card.id));
        expect(await manager.import(library, source.port.directory)).toEqual({ imported: 0, alreadyImported: true });
        expect((await source.catalog()).records).toHaveLength(1);
    });
    it("导入发布中断后目标资料不变，重试使用已写事件继续提交", async () => {
        // 注入一次目录发布失败，验证中断边界而非模拟整个业务服务。
        const { root, library } = await fixture();
        const { LibraryManager } = await import("./library-manager");
        const { vi } = await import("vitest");
        const manager = new LibraryManager();
        const source = await manager.create(path.join(root, "second-library"));
        await source.save(card);
        const original = library.port.write.bind(library.port);
        const failed = vi.spyOn(library.port, "write").mockImplementation(async (relative, content) => {
            if (relative === "catalog.json") throw new Error("模拟断电");
            await original(relative, content);
        });
        await expect(manager.import(library, source.port.directory)).rejects.toThrow("模拟断电");
        expect((await library.catalog()).records).toHaveLength(0);
        failed.mockRestore();
        expect((await manager.import(library, source.port.directory)).imported).toBe(1);
    });
});

describe("派生索引与通用来源", () => {
    it("派生快照损坏或被删除后可从评分链重建相同队列", async () => {
        // 派生文件不具备权威性，损坏不能导致丢失学习进度。
        const { library } = await fixture();
        const { ReviewService } = await import("./review/service");
        const now = new Date("2026-11-13T06:00:00Z");
        await library.save(card);
        const service = new ReviewService(library.port, "LinguaLeafData", library, () => now);
        const before = await service.store.state(card.id);
        const grade = service.grade(service.preview(card.id, before, .9), 3, "projection-session");
        await service.commit(grade);
        const expected = await service.queue([{ card }], "projection-session", new Set());
        await library.port.write("LinguaLeafData/review/projection.json", "broken-cache");
        const rebuilt = await new ReviewService(library.port, "LinguaLeafData", library, () => now).queue([{ card }], "projection-session", new Set());
        expect(rebuilt.rows).toEqual(expected.rows);
        expect(rebuilt.newToday).toEqual(expected.newToday);
        expect(rebuilt.reviewed).toEqual(expected.reviewed);
        expect(rebuilt.last).toEqual(expected.last);
    });
    it("资料身份不由路径决定，同来源新建资料保持独立，网页引用按地址去重", async () => {
        // 同一文章可以有同表达的多个独立学习资料。
        const { library } = await fixture();
        const source = { vaultId: "vault", vaultName: "Vault", path: "article.md" };
        await library.save(card, source, "capture-a");
        await library.save({ ...card, id: "separate-material" }, source, "capture-b");
        expect((await library.catalog()).records).toHaveLength(2);
        await library.save(card, { kind: "web", uri: "https://example.test/first" });
        await library.save(card, { kind: "web", uri: "https://example.test/second" });
        expect((await library.catalog()).records[0].sources).toHaveLength(3);
    });
});
