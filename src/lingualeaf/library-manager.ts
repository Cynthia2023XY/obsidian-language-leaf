import { encodeCatalog } from "./library-schema";
import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { newId, expressionKey } from "./domain";
import { LearningLibrary } from "./library";
import type { LibraryCatalog } from "./library";
import { ReviewStore } from "./review/engine";

/** 创建、连接和追加导入均由显式入口调用，普通读取绝不隐式创建 */
export class LibraryManager {
    /** 创建一份全新学习库，不覆盖任何现存目录 */
    async create(directory: string): Promise<LearningLibrary> {
        // 构造器先验证绝对路径。
        const library = new LearningLibrary(directory);
        await fs.mkdir(directory, { recursive: false });
        // 学习日配置在创建时固定，之后所有设备共用。
        const catalog: LibraryCatalog = { schema: 2, id: newId(), review: { newLimit: 100, retention: .9 }, calendar: { timeZone: "Asia/Shanghai", rolloverHour: 4 }, records: [] };
        await library.port.create!("catalog.json", encodeCatalog(catalog));
        return library;
    }
    /** 校验学习库身份，不允许路径悄悄指向另一份有效数据 */
    async connect(directory: string, expectedId?: string): Promise<LearningLibrary> {
        // 连接只读验证；目录或文件无效时不写入任何内容。
        const library = new LearningLibrary(directory, expectedId);
        await library.catalog();
        return library;
    }
    /** 第二个独立学习库追加到当前库，保留每张资料及完整事件链 */
    async import(target: LearningLibrary, sourceDirectory: string): Promise<{ imported: number; alreadyImported: boolean }> {
        // 两份库不能互相包含，防止备份和事件目录混用。
        const source = await this.connect(sourceDirectory);
        if (path.resolve(target.port.directory) === path.resolve(source.port.directory)) throw new Error("不能将学习库导入自身");
        // 源库锁与目标锁不嵌套，避免两个反向导入形成死锁。
        const snapshot = await source.port.exclusive(async () => {
            // 源资料和事件在同一源锁中读取，保证导入基线一致。
            const catalog = await source.catalog();
            // 保留源库全部评分、撤销、暂停，不按时间重排。
            const store = new ReviewStore(source.port, "LinguaLeafData");
            // 每条链必须先验证才能进入目标。
            const events = await Promise.all(catalog.records.map(record => store.events(record.card.id)));
            return { catalog, events };
        });
        return target.port.exclusive(async () => {
            // 目标在锁内重新读取，不能覆盖别的窗口刚提交的内容。
            const catalog = await target.catalog();
            if (catalog.id === snapshot.catalog.id) throw new Error("两份目录属于同一个学习库，不能重复导入");
            // 导入账本和资料同一次原子发布，重试不会再增加次数。
            const imports = catalog.imports || {};
            if (imports[snapshot.catalog.id]) return { imported: 0, alreadyImported: true };
            // 命名空间稳定映射，即便上次导入在发布目录前中断也可重试。
            const mapId = (id: string): string => createHash("sha256").update(`${snapshot.catalog.id}:${id}`).digest("hex").slice(0, 32);
            // 合并同形词条，但语境资料和卡片不丢弃。
            const expressions = new Map(catalog.records.map(record => [expressionKey(record.card.language, record.card.text), record.card.expressionId]));
            // 目标旧目录单独备份，用户可审查导入之前的学习资料。
            await target.port.write(`backups/import-${snapshot.catalog.id}.json`, encodeCatalog(catalog));
            for (let index = 0; index < snapshot.catalog.records.length; index++) {
                // 只克隆资料，绝不改源对象。
                const record = structuredClone(snapshot.catalog.records[index]);
                // 词条按语言和规范化表达合并，卡片按源库命名空间隔离。
                const key = expressionKey(record.card.language, record.card.text);
                record.card.id = mapId(record.card.id);
                record.card.expressionId = expressions.get(key) || mapId(record.card.expressionId);
                expressions.set(key, record.card.expressionId);
                record.captures = record.captures.map(mapId);
                if (catalog.records.some(item => item.card.id === record.card.id)) throw new Error("导入资料身份冲突");
                // 先独占发布完整事件；目录尚未提交时这些事件不可见。
                for (const original of snapshot.events[index]) {
                    // 事件因果链和 FSRS 状态完全保留，只隔离跨库身份。
                    const event = { ...original, id: mapId(original.id), cardId: record.card.id, session: mapId(original.session), ...(original.undoes ? { undoes: mapId(original.undoes) } : {}) };
                    // 路径仍由适配器维护，业务界面不依赖此布局。
                    const relative = `LinguaLeafData/review/events/${record.card.id}/${String(event.after.revision).padStart(10, "0")}.json`;
                    // 上次确认丢失时只接受完全一致的内容，拒绝覆盖其他历史。
                    const existing = await target.port.read(relative);
                    if (existing && JSON.stringify(JSON.parse(existing)) !== JSON.stringify(event)) throw new Error("导入事件冲突，已停止追加");
                    if (!existing) await target.port.create!(relative, JSON.stringify(event, null, 2));
                }
                catalog.records.push(record);
            }
            catalog.imports = { ...imports, [snapshot.catalog.id]: { at: new Date().toISOString(), records: snapshot.catalog.records.length } };
            // 此次原子发布使资料、导入账本和已验证历史一起对读者生效。
            await target.publish(catalog);
            return { imported: snapshot.catalog.records.length, alreadyImported: false };
        });
    }
}
