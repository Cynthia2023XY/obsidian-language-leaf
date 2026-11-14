import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { LearningLibrary } from "./library";
import { ReviewStore } from "./review/engine";

/** 将唯一主词库移动进主笔记库，卡片和事件身份保持原样 */
export interface RelocationOptions {
    /** 原统一学习库绝对路径 */
    source: string;
    /** 主笔记库绝对路径，发布前的暂存必须位于它之外 */
    vault: string;
    /** 主库内普通相对目录 */
    relative: string;
    /** 必须保留的学习库身份 */
    libraryId: string;
}
/** 主库迁移只复制权威文件，不携带本机运行状态 */
export async function relocateLibrary(options: RelocationOptions) {
    // 路径判断先于任何写入。
    const source = path.resolve(options.source);
    // 不允许选择主库根目录或越出主库。
    const vault = path.resolve(options.vault);
    if (!options.relative || path.isAbsolute(options.relative) || options.relative.split(/[\\/]/).some(part => !part || part === "." || part === ".." || part.startsWith("."))) throw new Error("主词库必须使用库内普通相对目录");
    // 发布目标保留现有资料身份，不进行第二次导入。
    const target = path.join(vault, options.relative);
    if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) throw new Error("主词库新旧目录不能互相包含");
    // 已有目标不能覆盖；重跑只接受已完成的同一迁移报告。
    const previous = await fs.readFile(path.join(target, "relocation-report.json"), "utf8").catch((error): null => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null; });
    if (previous) {
        // 复用已完成迁移，不再次拷贝或合并卡片。
        const report = JSON.parse(previous);
        if (report.source !== source || report.libraryId !== options.libraryId) throw new Error("迁移目标已属于其他学习库");
        await new LearningLibrary(target, options.libraryId).catalog();
        // 发布后若进程在停用源目录前中断，重跑只完成停用，不再次复制。
        const activeSource = await fs.readFile(path.join(source, "catalog.json"), "utf8").catch((error): null => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null; });
        if (activeSource) {
            // 只有源权威文件仍与已发布版本逐字节一致时才能停用。
            const library = new LearningLibrary(source, options.libraryId);
            await library.port.exclusive(async () => {
                // 同时阻止尚未重载的旧客户端写入。
                const legacyLock = path.join(source, ".catalog.lock");
                await fs.writeFile(legacyLock, `${process.pid}:${randomUUID()}`, { flag: "wx", mode: 0o600 });
                try {
                    for (const [relative, hash] of Object.entries(report.hashes as Record<string, string>)) if (createHash("sha256").update(await fs.readFile(path.join(source, relative))).digest("hex") !== hash) throw new Error("源词库在迁移中断后发生变化，不能自动停用，请先处理差异");
                    await fs.rename(path.join(source, "catalog.json"), path.join(source, "catalog.retired.json"));
                    await fs.writeFile(path.join(source, "relocation.json"), JSON.stringify({ schema: 1, libraryId: options.libraryId, target }, null, 2));
                } finally { await fs.unlink(legacyLock); }
            });
        }
        return { ...report, alreadyRelocated: true };
    }
    try { await fs.stat(target); throw new Error("主词库目标目录已存在，已停止覆盖"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // 两套锁同时保护旧代码与本次代码，迁移期间不允许旧窗口提交。
    const library = new LearningLibrary(source, options.libraryId);
    return library.port.exclusive(async () => {
        // 旧版客户端仍使用源库内锁，兼容到本次迁移结束。
        const legacyLock = path.join(source, ".catalog.lock");
        await fs.writeFile(legacyLock, `${process.pid}:${randomUUID()}`, { flag: "wx", mode: 0o600 });
        // 暂存和备份均在主笔记库之外，同文件系统最终整目录原子发布。
        const stage = path.join(path.dirname(vault), `.language-leaf-relocation-${randomUUID()}`);
        // 完整原库保留为不可写回的恢复备份。
        const backup = `${source}.backup-vault-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        try {
            // 读取目录和全部历史作为迁移唯一基线。
            const catalog = await library.catalog();
            // 原始事件字节完全保留，不重新生成调度状态。
            const store = new ReviewStore(library.port, "LinguaLeafData");
            for (const record of catalog.records) await store.events(record.card.id);
            // 权威文件只有元数据与追加事件；锁、临时文件、会话和索引不发布。
            const paths = ["catalog.json", ...await library.port.list("LinguaLeafData/review/events/")];
            // 文件哈希同时用于暂存校验与迁移报告。
            const hashes: Record<string, string> = {};
            await fs.cp(source, backup, { recursive: true, force: false, errorOnExist: true, filter: entry => !path.basename(entry).startsWith(".catalog.lock") });
            await fs.mkdir(stage);
            for (const relative of paths) {
                // 按原始字节复制，避免任何 JSON 重序列化。
                const bytes = await fs.readFile(path.join(source, relative));
                await fs.mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
                await fs.writeFile(path.join(stage, relative), bytes, { flag: "wx", mode: 0o600 });
                hashes[relative] = createHash("sha256").update(bytes).digest("hex");
                if (createHash("sha256").update(await fs.readFile(path.join(stage, relative))).digest("hex") !== hashes[relative]) throw new Error("迁移文件字节校验失败");
            }
            // 暂存库重新校验身份与全部事件链。
            const staged = new LearningLibrary(stage, options.libraryId);
            await staged.catalog();
            // 检查所有卡的完整状态，任何一张不一致都不能发布。
            const stagedStore = new ReviewStore(staged.port, "LinguaLeafData");
            for (const record of catalog.records) if (JSON.stringify(await store.state(record.card.id)) !== JSON.stringify(await stagedStore.state(record.card.id))) throw new Error("迁移后复习状态不一致");
            // 兼容没有遵守业务锁的外部写入，发布前再次校验源字节。
            for (const relative of paths) if (createHash("sha256").update(await fs.readFile(path.join(source, relative))).digest("hex") !== hashes[relative]) throw new Error("迁移期间源词库被修改，已停止发布");
            // 迁移报告不包含单词或个人笔记内容。
            const report = { schema: 1, libraryId: catalog.id, source, target, backup, at: new Date().toISOString(), cards: catalog.records.length, reviewEvents: paths.length - 1, filesVerified: paths.length, hashes, alreadyRelocated: false };
            await fs.writeFile(path.join(stage, "relocation-report.json"), JSON.stringify(report, null, 2));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.rename(stage, target);
            // 源目录退出运行，遗留旧窗口不能继续向库外副本写入。
            await fs.rename(path.join(source, "catalog.json"), path.join(source, "catalog.retired.json"));
            await fs.writeFile(path.join(source, "relocation.json"), JSON.stringify({ schema: 1, libraryId: catalog.id, target }, null, 2));
            return report;
        } finally {
            await fs.unlink(legacyLock);
            // 未发布暂存是本次创建的临时数据，备份始终保留。
            await fs.rm(stage, { recursive: true, force: true });
        }
    });
}
