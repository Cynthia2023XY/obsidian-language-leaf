import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { parseCards, validateCard } from "./article";
import { captureCounts } from "./capture-count";
import { expressionKey } from "./domain";
import type { CaptureOperation } from "./storage";
import { LibraryFiles } from "./library-files";
import { LearningLibrary } from "./library";
import type { LibraryCatalog, LibraryRecord, LibrarySource } from "./library";
import { ReviewStore } from "./review/engine";
import { importSchedule } from "./review/import-schedule";

/** 迁移输入不要求加载 Obsidian，默认只预览 */
export interface LibraryMigrationOptions {
    /** 原笔记库绝对位置 */
    vault: string;
    /** 独立学习库绝对位置 */
    destination: string;
    /** 显式执行迁移 */
    apply?: boolean;
}
/** 按原始字节生成文件快照，不读取隐藏的插件缓存 */
async function snapshot(directory: string, excludeHidden = false): Promise<Map<string, string>> {
    // 保存相对路径，便于比较原库和备份。
    const hashes = new Map<string, string>();
    // 不跟随链接，避免越出用户指定范围。
    const visit = async (folder: string): Promise<void> => {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
            if (excludeHidden && entry.name.startsWith(".")) continue;
            // 原文件保持原始字节，不转换换行或编码。
            const full = path.join(folder, entry.name);
            if (entry.isDirectory()) await visit(full);
            else if (entry.isFile()) hashes.set(path.relative(directory, full), createHash("sha256").update(await fs.readFile(full)).digest("hex"));
        }
    };
    await visit(directory);
    return hashes;
}
/** 导入原文卡片、孤立快照、收录次数和完整复习历史，从不改原库 */
export async function migrateLibrary(options: LibraryMigrationOptions) {
    // 固定源和目标，避免受工作目录影响。
    const vault = path.resolve(options.vault);
    // 独立目录不允许与原库相互包含。
    const destination = path.resolve(options.destination);
    if (destination === vault || destination.startsWith(vault + path.sep) || vault.startsWith(destination + path.sep)) throw new Error("学习库与原笔记库不能互相包含");
    // 迁移重跑不得用旧文章覆盖新版修改。
    const existing = new LearningLibrary(destination);
    if (await existing.port.read("catalog.json")) {
        // 已有库只接受同一来源的幂等重试。
        const report = JSON.parse(await existing.port.read("migration-report.json") || "null");
        if (report?.vault !== vault) throw new Error("目标已包含其他学习库，请使用追加导入流程");
        return { ...report, alreadyMigrated: true, currentCards: (await existing.catalog()).records.filter(record => !record.deleted).length };
    }
    // 只使用当前设置，不把凭据或词句写入统计报告。
    const settings = JSON.parse(await fs.readFile(path.join(vault, ".obsidian/plugins/language-leaf/data.json"), "utf8"));
    // 核对全部非隐藏文件，覆盖文章和旧数据。
    const before = await snapshot(vault, true);
    // 旧数据端口只用于读取。
    const oldFiles = new LibraryFiles(path.join(vault, "LinguaLeafData"));
    // 每张语境卡都单独保留，不能只取词条最后一份快照。
    const records = new Map<string, LibraryRecord>();
    // 无内置历史的 SR 卡片需要转换旧调度。
    const schedules = new Map<string, string>();
    // 独立来源身份防止两个库相同路径串联。
    const vaultId = settings.learning?.vaultId || randomUUID();
    // 本次迁移统一时间。
    const now = new Date().toISOString();
    // 来源记录只负责跳转，没有回写能力。
    const source = (relative: string): LibrarySource => ({ vaultId, vaultName: path.basename(vault), path: relative });
    // 当前文章内容优先于历史恢复快照。
    let articleCards = 0;
    for (const relative of before.keys()) {
        if (!relative.endsWith(".md") || relative.startsWith("LinguaLeafData/")) continue;
        // 读取正文只发生在显式迁移阶段。
        const text = await fs.readFile(path.join(vault, relative), "utf8");
        if (!text.includes("<!-- ll-card:")) continue;
        for (const located of parseCards(text, settings.learning?.separator || "?")) {
            if (records.has(located.card.id)) throw new Error(`重复卡片身份：${located.card.id}`);
            articleCards++;
            records.set(located.card.id, { card: { ...located.card, owner: "builtin" }, sources: [source(relative)], baseline: 0, captures: [], revision: 1, updatedAt: now });
            schedules.set(located.card.id, located.schedule);
        }
    }
    // 没有当前文章的旧快照同样是已收录资料。
    let snapshotCards = 0;
    for (const relative of await oldFiles.list("expressions/")) {
        // 拒绝不认识的实体格式。
        const value = JSON.parse(await oldFiles.read(relative) || "null");
        if (value?.schema !== 1) throw new Error(`未知词条快照版本：${relative}`);
        // 身份校验复用正式插件规则。
        const card = validateCard(value.card);
        if (!records.has(card.id)) {
            records.set(card.id, { card: { ...card, owner: "builtin" }, sources: value.sourcePath ? [source(value.sourcePath)] : [], baseline: 0, captures: [], revision: 1, updatedAt: now });
            snapshotCards++;
        }
        for (const record of records.values()) if (expressionKey(record.card.language, record.card.text) === expressionKey(card.language, card.text)) record.card.tags = [...(card.tags || [])];
    }
    // 迁移收录次数，也恢复尚未标记完成的确认操作。
    const operations: CaptureOperation[] = [];
    // 明确报告恢复数量。
    let pendingOperations = 0;
    for (const relative of await oldFiles.list("operations/")) {
        // 操作损坏不能静默丢弃。
        const operation = JSON.parse(await oldFiles.read(relative) || "null") as CaptureOperation;
        if (!operation || typeof operation.id !== "string" || typeof operation.path !== "string" || typeof operation.done !== "boolean") throw new Error(`旧收录操作损坏：${relative}`);
        validateCard(operation.card);
        if (!operation.done) {
            pendingOperations++;
            if (!records.has(operation.card.id)) records.set(operation.card.id, { card: { ...operation.card, owner: "builtin" }, sources: [source(operation.path)], baseline: 0, captures: [], revision: 1, updatedAt: now });
        }
        operations.push({ ...operation, done: true });
    }
    for (const relative of await oldFiles.list("deletions/")) {
        // 显式删除的资料不能由旧快照复活。
        const value = JSON.parse(await oldFiles.read(relative) || "null");
        if (records.has(value?.cardId)) records.get(value.cardId)!.deleted = true;
    }
    // 按旧规则保存基数，编辑日志不计为新收录。
    const counts = captureCounts([...records.values()], operations);
    // 每个词条的总基数只分配一次。
    const assigned = new Set<string>();
    for (const record of records.values()) {
        // 标准化与旧版保持一致，不混合语言或重音。
        const key = expressionKey(record.card.language, record.card.text);
        record.baseline = assigned.has(key) ? 0 : counts.get(key) || 1;
        assigned.add(key);
    }
    // 事件保持原始路径与全部字段不变。
    const oldPort = new LibraryFiles(vault);
    // 检查每条历史版本链，不重排到期时间。
    const oldReview = new ReviewStore(oldPort, "LinguaLeafData");
    // 保留所有评分事件，包括撤销和暂停。
    const eventFiles = await oldPort.list("LinguaLeafData/review/events/");
    for (const id of new Set(eventFiles.map(relative => relative.split("/")[3]))) {
        await oldReview.events(id);
        if (!records.has(id)) throw new Error(`复习历史缺少对应资料：${id}`);
    }
    // 预览和实际迁移共用同一份可审计统计。
    const report = { schema: 2, vault, destination, vaultId, at: now, articleCards, snapshotCards, pendingOperations, totalCards: records.size, activeCards: [...records.values()].filter(record => !record.deleted).length, expressions: assigned.size, reviewEvents: eventFiles.length, originalFiles: before.size, originalNotesUnchanged: false, backup: "", importedSchedules: 0 };
    if (!options.apply) return report;
    // 同级临时目录验证成功后再整体发布。
    const stage = `${destination}.migration-${randomUUID()}`;
    // 备份位于原库之外，包含笔记、旧数据和插件原设置。
    const backup = `${destination}.backup-${now.replace(/[:.]/g, "-")}`;
    await fs.mkdir(stage, { recursive: true });
    await fs.mkdir(backup, { recursive: true });
    await fs.cp(path.join(vault, "LinguaLeafData"), path.join(backup, "LinguaLeafData"), { recursive: true, force: false, errorOnExist: true });
    await fs.copyFile(path.join(vault, ".obsidian/plugins/language-leaf/data.json"), path.join(backup, "plugin-data.json"));
    for (const relative of before.keys()) if (relative.endsWith(".md") && !relative.startsWith("LinguaLeafData/")) {
        await fs.mkdir(path.dirname(path.join(backup, "notes", relative)), { recursive: true });
        await fs.copyFile(path.join(vault, relative), path.join(backup, "notes", relative));
    }
    await fs.writeFile(path.join(backup, "source-hashes.json"), JSON.stringify(Object.fromEntries(before), null, 2));
    // 新目录只放正式卡片与评分，不加载旧待写回逻辑。
    const staged = new LearningLibrary(stage);
    // 复习规则沿用用户设置。
    const catalog: LibraryCatalog = { schema: 2, id: randomUUID(), review: { newLimit: settings.review?.newLimit || 100, retention: settings.review?.retention || .9 }, records: [...records.values()] };
    await staged.port.create("catalog.json", JSON.stringify(catalog, null, 2));
    for (const relative of eventFiles) await staged.port.create(relative, (await oldPort.read(relative))!);
    // 无历史但有旧 SR 调度的卡片只生成一条导入事件。
    const review = new ReviewStore(staged.port, "LinguaLeafData");
    for (const record of records.values()) {
        // 已有历史逐字段比较最终状态。
        const original = await oldReview.state(record.card.id);
        if (original.revision > 0) {
            if (JSON.stringify(original) !== JSON.stringify(await review.state(record.card.id))) throw new Error("复习状态核对失败");
        } else if (schedules.get(record.card.id)?.trim()) {
            // 未知调度格式会停止，不偷偷重置进度。
            const imported = importSchedule(schedules.get(record.card.id)!, false);
            await review.append({ schema: 1, id: randomUUID(), cardId: record.card.id, at: now, session: "independent-migration", kind: "import", before: await review.state(record.card.id), after: { ...imported.state, revision: 1 }, library: "ts-fsrs@5.4.1", retention: catalog.review.retention });
            report.importedSchedules++;
        }
    }
    await staged.catalog();
    // 校验备份和原库的所有实际字节。
    const backupData = await snapshot(path.join(backup, "LinguaLeafData"));
    // 笔记校验与学习数据分开，避免相同名称串联。
    const backupNotes = await snapshot(path.join(backup, "notes"));
    for (const [relative, hash] of before) {
        if (relative.startsWith("LinguaLeafData/") && backupData.get(relative.slice("LinguaLeafData/".length)) !== hash) throw new Error("旧数据备份校验失败");
        if (relative.endsWith(".md") && !relative.startsWith("LinguaLeafData/") && backupNotes.get(relative) !== hash) throw new Error("笔记备份校验失败");
    }
    // 原库变化时停止发布，保留现场供重新核对。
    const after = await snapshot(vault, true);
    if (before.size !== after.size || [...before].some(([relative, hash]) => after.get(relative) !== hash)) throw new Error("迁移期间原库发生变化，已停止切换，请结束收录和复习后重试");
    report.originalNotesUnchanged = true; report.backup = backup;
    await staged.port.create("migration-report.json", JSON.stringify(report, null, 2));
    await fs.rename(stage, destination);
    return report;
}
