// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { LibraryBindings, resolveLibraryDirectory, vaultLibraryDirectory, UnavailableLibraryFiles } from "./library-connection";
import { LibraryManager } from "./library-manager";
import { LearningLibrary } from "./library";
import { ReviewService } from "./review/service";
import { relocateLibrary } from "./library-relocation";
import { readSettings } from "./config";
import type { LeafCard } from "./domain";

/** 所有测试仅创建临时文件，不读写正式学习资料 */
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
/** 创建两个笔记库和唯一词库，模拟用户主库与额外入口 */
async function fixture() {
    // 所有创建的运行目录和绑定文件均位于可清理根目录。
    const root = await fs.mkdtemp(path.join(tmpdir(), "leaf-vault-library-"));
    roots.push(root);
    // 主笔记库具有实际 Obsidian 目录标记。
    const vault = path.join(root, "Cynthia Note");
    await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
    // 原词库位于笔记库之外，初始只有一个权威来源。
    const library = await new LibraryManager().create(path.join(root, "external-library"));
    // 不使用真实词句或历史。
    const card: LeafCard = { id: "card-one", expressionId: "expression-one", language: "en", text: "leaf", meaning: "叶子", sentence: "A leaf.", translation: "一片叶子。", outline: "", notes: "", anchor: "", kind: "word", owner: "builtin" };
    await library.save(card, { vaultId: "yasi", vaultName: "雅思", path: "article.md" }, "first-capture");
    // 真实 FSRS 评分用于验证迁移前后逐字段状态一致。
    const review = new ReviewService(library.port, "LinguaLeafData", library, () => new Date("2026-11-14T06:00:00Z"));
    await review.commit(review.grade(review.preview(card.id, await review.store.state(card.id), .9), 3, "session"));
    return { root, vault, library, card, review, id: (await library.catalog()).id };
}

describe("主库相对连接与设备绑定", () => {
    it("同一主库同步到不同根目录后自动定位当地学习库", () => {
        // 可同步设置不包含设备用户名或绝对目录。
        const settings = readSettings({ learning: { libraryMode: "vault", libraryPath: "LanguageLeafLibrary", libraryId: "library-one" } }).learning;
        expect(resolveLibraryDirectory(settings, "/device-one/Cynthia Note")).toBe("/device-one/Cynthia Note/LanguageLeafLibrary");
        expect(resolveLibraryDirectory(settings, "/device-two/Cynthia Note")).toBe("/device-two/Cynthia Note/LanguageLeafLibrary");
    });
    it.each(["../outside", "/absolute", ".obsidian/library", "one/../outside", "one\\outside", "one//two"])("主库拒绝越界或隐藏路径 %s", relative => {
        expect(() => vaultLibraryDirectory("/vault", relative)).toThrow("相对目录");
    });
    it("雅思仅同步目标库身份，每台设备独立绑定本机路径", async () => {
        // 两份配置目录代表两台独立电脑。
        const { root, vault } = await fixture();
        const first = new LibraryBindings(path.join(root, "device-one"));
        const second = new LibraryBindings(path.join(root, "device-two"));
        const settings = readSettings({ learning: { libraryMode: "external", libraryPath: "", libraryId: "shared-library", vaultId: "yasi" } }).learning;
        await first.save("yasi", "shared-library", path.join(vault, "LanguageLeafLibrary"));
        expect(resolveLibraryDirectory(settings, "/Yasi", first)).toBe(path.join(vault, "LanguageLeafLibrary"));
        expect(() => resolveLibraryDirectory(settings, "/Yasi", second)).toThrow("此设备尚未连接");
        await second.save("yasi", "shared-library", "/another-device/Cynthia Note/LanguageLeafLibrary");
        expect(resolveLibraryDirectory(settings, "/Yasi", second)).toBe("/another-device/Cynthia Note/LanguageLeafLibrary");
    });
    it("未绑定时所有写入失败，不创建替代库或执行提交回调", async () => {
        // 缺失配置不能被解释为空词库。
        const port = new UnavailableLibraryFiles("请先连接主词库");
        await expect(port.read("catalog.json")).rejects.toThrow("请先连接");
        await expect(port.write("catalog.json", "{}")).rejects.toThrow("请先连接");
        await expect(port.exclusive(async () => "不应执行")).rejects.toThrow("请先连接");
    });
});

describe("主词库整体迁入与本机运行文件", () => {
    it("搬移保留身份、资料字节和复习状态，雅思新增直接写入主库", async () => {
        // 完整保存原始权威字节用于比较。
        const { vault, library, card, review, id } = await fixture();
        const original = await library.port.read("catalog.json");
        const before = await review.store.state(card.id);
        const options = { source: library.port.directory, vault, relative: "LanguageLeafLibrary", libraryId: id };
        const report = await relocateLibrary(options);
        expect(report.cards).toBe(1);
        expect(report.reviewEvents).toBe(1);
        const primary = new LearningLibrary(path.join(vault, "LanguageLeafLibrary"), id);
        expect(await primary.port.read("catalog.json")).toBe(original);
        expect(await new ReviewService(primary.port, "LinguaLeafData", primary).store.state(card.id)).toEqual(before);
        // 偶尔收录的来源库连接同一物理目录，不建立镜像。
        const yasi = new LearningLibrary(primary.port.directory, id);
        await yasi.save({ ...card, id: "yasi-card", text: "tree" }, { vaultId: "yasi", vaultName: "雅思", path: "new.md" }, "second-capture");
        expect((await primary.catalog()).records).toHaveLength(2);
        await expect(new LearningLibrary(options.source, id).catalog()).rejects.toThrow();
        expect((await relocateLibrary(options)).alreadyRelocated).toBe(true);
    });
    it("锁、临时文件、会话和索引不会进入主库同步范围", async () => {
        // 主库内只允许发布权威数据文件。
        const { vault, library, card, id } = await fixture();
        await relocateLibrary({ source: library.port.directory, vault, relative: "LanguageLeafLibrary", libraryId: id });
        const primary = new LearningLibrary(path.join(vault, "LanguageLeafLibrary"), id);
        const review = new ReviewService(primary.port, "LinguaLeafData", primary);
        await review.checkpoint("session-key", "session-id", new Set([card.id]));
        await review.queue([{ card }], "session-id", new Set());
        expect(await fs.readdir(primary.port.directory)).not.toContain(".catalog.lock");
        await expect(fs.stat(path.join(primary.port.directory, "LinguaLeafData/review/projection.json"))).rejects.toThrow();
        await expect(fs.stat(path.join(primary.port.directory, "LinguaLeafData/review/sessions"))).rejects.toThrow();
        // 本机缓存仍可正常恢复，但位于整个笔记库之外。
        const runtime = await (primary.port as import("./library-files").LibraryFiles).runtimeDirectory();
        expect(runtime.startsWith(vault + path.sep)).toBe(false);
        expect(await review.resume("session-key")).toEqual({ id: "session-id", skipped: [card.id] });
        await primary.port.exclusive(async () => {
            expect((await fs.readdir(primary.port.directory)).some(name => name.endsWith(".tmp") || name.includes("lock"))).toBe(false);
            expect((await fs.readdir(runtime)).some(name => name.includes("lock"))).toBe(true);
        });
    });
    it("同步后的主库在另一台设备根目录可直接读取相同资料和进度", async () => {
        // 文件复制模拟同步结果，连接与复习逻辑保持真实实现。
        const { root, vault, library, card, review, id } = await fixture();
        await relocateLibrary({ source: library.port.directory, vault, relative: "LanguageLeafLibrary", libraryId: id });
        // 第二台设备拥有不同的笔记库根路径，没有任何外部绑定。
        const otherVault = path.join(root, "device-two", "Cynthia Note");
        await fs.mkdir(path.join(otherVault, ".obsidian"), { recursive: true });
        await fs.cp(path.join(vault, "LanguageLeafLibrary"), path.join(otherVault, "LanguageLeafLibrary"), { recursive: true });
        // 相同可同步设置在另一台设备解析为本地目录。
        const settings = readSettings({ learning: { libraryMode: "vault", libraryPath: "LanguageLeafLibrary", libraryId: id } }).learning;
        const other = new LearningLibrary(resolveLibraryDirectory(settings, otherVault)!, id);
        expect((await other.catalog()).records[0].card).toEqual(card);
        expect(await new ReviewService(other.port, "LinguaLeafData", other).store.state(card.id)).toEqual(await review.store.state(card.id));
    });
    it("目标发布后停用源目录中断，重跑完成停用且不重复导入", async () => {
        // 重建发布完成、源目录尚未停用的真实磁盘状态，模拟进程中断。
        const { vault, library, id } = await fixture();
        const options = { source: library.port.directory, vault, relative: "LanguageLeafLibrary", libraryId: id };
        await relocateLibrary(options);
        // 目标已完整发布，但源目录仍是可读取的旧基线。
        await fs.rename(path.join(options.source, "catalog.retired.json"), path.join(options.source, "catalog.json"));
        await fs.unlink(path.join(options.source, "relocation.json"));
        expect((await relocateLibrary(options)).alreadyRelocated).toBe(true);
        expect((await new LearningLibrary(path.join(vault, "LanguageLeafLibrary"), id).catalog()).records).toHaveLength(1);
        await expect(new LearningLibrary(options.source, id).catalog()).rejects.toThrow();
    });
    it("错误学习库身份或已占用目录都不会覆盖现存文件", async () => {
        // 错误输入必须在发布任何目标资料前失败。
        const { vault, library, id } = await fixture();
        await expect(relocateLibrary({ source: library.port.directory, vault, relative: "LanguageLeafLibrary", libraryId: "wrong-id" })).rejects.toThrow("身份不匹配");
        await fs.mkdir(path.join(vault, "LanguageLeafLibrary"));
        await fs.writeFile(path.join(vault, "LanguageLeafLibrary", "keep.txt"), "keep");
        await expect(relocateLibrary({ source: library.port.directory, vault, relative: "LanguageLeafLibrary", libraryId: id })).rejects.toThrow("已存在");
        expect(await fs.readFile(path.join(vault, "LanguageLeafLibrary", "keep.txt"), "utf8")).toBe("keep");
    });
});
