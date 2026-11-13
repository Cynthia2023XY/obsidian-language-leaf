import { decodeCatalog, encodeCatalog } from "./library-schema";
import { expressionKey, newId } from "./domain";
import type { LeafCard } from "./domain";
import { validateCard } from "./article";
import type { LibraryRepositoryPort } from "./repository";

/** 出处仅供跳转，不决定学习资料是否存在 */
export interface LibrarySource {
    /** 来源库的稳定身份 */
    vaultId?: string;
    /** 通用来源类别，旧数据默认为 Obsidian */
    kind?: "obsidian" | "web" | "ebook" | "manual";
    /** 非笔记来源的可选地址 */
    uri?: string;
    /** Obsidian 跳转使用的库名称 */
    vaultName?: string;
    /** 收录时的文章相对路径 */
    path?: string;
}
/** 来源引用只按类别和地址去重，不参与学习资料身份判定 */
function sourceKey(source: LibrarySource): string {
    return source.kind && source.kind !== "obsidian" ? `${source.kind}:${source.uri || ""}` : `obsidian:${source.vaultId}:${source.path}`;
}
/** 独立卡片完整保留所有语境和主动收录历史 */
export interface LibraryRecord {
    /** 原卡片身份和完整学习内容 */
    card: LeafCard;
    /** 可选的文章来源，不随文章内容同步 */
    sources: LibrarySource[];
    /** 已迁移的累计收录基数 */
    baseline: number;
    /** 新版主动收录请求，重复保存只计算一次 */
    captures: string[];
    /** 卡片内容版本，阻止旧表单覆盖最新内容 */
    revision: number;
    /** 学习资料自身更新时间 */
    updatedAt: string;
    /** 删除只影响学习库，不修改原文章或评分历史 */
    deleted?: boolean;
}
/** 一份原子提交的学习库目录，评分历史仍使用独立事件 */
export interface LibraryCatalog {
    /** 新数据格式版本 */
    schema: 2;
    /** 学习库身份 */
    id: string;
    /** 防止不同客户端用不同算法规则操作同一库 */
    review: { newLimit: number; retention: number };
    /** 每张卡片完整独立于原笔记 */
    records: LibraryRecord[];
    /** 共享规则的独立版本，不受资料编辑影响 */
    reviewRevision?: number;
    /** 已提交的追加导入账本 */
    imports?: Record<string, { at: string; records: number }>;
    /** 已提交请求的原始响应，用于确认丢失后的安全重试 */
    receipts?: Record<string, LibraryRecord>;
    /** 所有窗口统一使用的学习日配置 */
    calendar?: { timeZone: string; rolloverHour: number };
}
/** 独立学习库读写服务，运行期从不扫描来源文章 */
export class LearningCore {
    /** 磁盘文件与评分事件共用的安全端口 */
    readonly port: LibraryRepositoryPort;
    /** 同一版本目录的只读缓存，返回时克隆避免表单污染 */
    private cached?: { version: string; catalog: LibraryCatalog };
    /** 连接现有数据源，连接失败不自动创建替代库 */
    constructor(port: LibraryRepositoryPort, private expectedId?: string) { this.port = port; }
    /** 校验目录及全部卡片，避免损坏数据被覆盖 */
    async catalog(): Promise<LibraryCatalog> {
        // 目录原子替换后文件身份变化，只需廉价 stat 即可判断是否需要重读。
        const version = await this.port.version?.("catalog.json");
        if (version && this.cached?.version === version) return structuredClone(this.cached.catalog);
        // 未选择有效学习库时必须显式报错。
        const value = decodeCatalog(await this.port.read("catalog.json") || "null");
        if (!value || value.schema !== 2 || typeof value.id !== "string" || !Array.isArray(value.records) || !Number.isInteger(value.review?.newLimit) || value.review.newLimit < 10 || value.review.newLimit > 200 || !(value.review.retention >= .7 && value.review.retention <= .97)) throw new Error("独立学习库不存在或格式无效，请检查数据源路径");
        if (this.expectedId && value.id !== this.expectedId) throw new Error("学习库身份不匹配，请重新连接正确的数据源");
        if (value.calendar) {
            if (!Number.isInteger(value.calendar.rolloverHour) || value.calendar.rolloverHour < 0 || value.calendar.rolloverHour > 23) throw new Error("学习日切换时间无效");
            new Intl.DateTimeFormat("en", { timeZone: value.calendar.timeZone }).format();
        }
        // 重复身份会让评分错绑，不能仅跳过损坏项。
        const ids = new Set<string>();
        for (const record of value.records) {
            validateCard(record.card);
            if (record.card.owner !== "builtin" || ids.has(record.card.id) || !Array.isArray(record.sources) || !Array.isArray(record.captures) || record.captures.some(id => typeof id !== "string") || !Number.isSafeInteger(record.baseline) || record.baseline < 0 || !Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error("独立学习库卡片记录损坏");
            for (const source of record.sources) if (!source || ((!source.kind || source.kind === "obsidian") ? typeof source.vaultId !== "string" || typeof source.vaultName !== "string" || typeof source.path !== "string" : source.kind !== "manual" && typeof source.uri !== "string")) throw new Error("独立学习库来源记录损坏");
            ids.add(record.card.id);
        }
        this.expectedId ||= value.id;
        if (version) this.cached = { version, catalog: structuredClone(value) };
        return value;
    }
    /** 首次升级保留旧格式原始备份，新格式原子发布失败时原库仍可用 */
    async publish(catalog: LibraryCatalog): Promise<void> {
        // 格式升级备份只写一次，绝不覆盖最初的旧版数据。
        const raw = await this.port.read("catalog.json");
        if (raw && JSON.parse(raw).schema === 2) {
            // 备份存在表示先前发布曾中断，可安全继续原子提交。
            const backup = `backups/schema-2-${catalog.id}.json`;
            if (!await this.port.read(backup)) await this.port.create!(backup, raw);
        }
        catalog.calendar ||= { timeZone: "Asia/Shanghai", rolloverHour: 4 };
        await this.port.write("catalog.json", encodeCatalog(catalog));
        this.cached = undefined;
    }
    /** 新卡片和编辑都只提交学习库，来源不存在也允许保存 */
    async save(card: LeafCard, source?: LibrarySource, captureId?: string, expectedRevision?: number): Promise<LibraryRecord> {
        return this.port.exclusive(async () => {
            // 锁内重新读取，防止不同窗口覆盖彼此的新收录。
            const catalog = await this.catalog();
            // 已完成请求即使后来被编辑或删除，也返回原始确认，不重新执行写入。
            if (captureId && Object.prototype.hasOwnProperty.call(catalog.receipts || {}, captureId)) return catalog.receipts[captureId];
            // 资料只按自身身份定位；是否再次使用旧资料由收录业务明确选择。
            const previous = catalog.records.find(record => record.card.id === card.id);
            if (previous?.deleted) throw new Error("卡片已删除，请重新打开收录面板");
            // 请求已落盘时先返回原始响应，不能被后续编辑版本误报为冲突。
            if (captureId && previous?.captures.includes(captureId)) return previous;
            if (expectedRevision !== undefined && (!previous || previous.revision !== expectedRevision)) throw new Error("卡片已被其他窗口修改，请重新打开编辑面板");
            // 重复提交相同请求不得覆盖这次收录之后的人工修改。
            if (captureId && previous?.captures.includes(captureId)) return previous;
            // 同词条复用管理身份，各语境卡及复习历史保持独立。
            const shared = catalog.records.find(record => expressionKey(record.card.language, record.card.text) === expressionKey(card.language, card.text));
            // 每次保存都复制表单对象，避免异步后继续编辑改变已提交内容。
            const changed = previous && expressionKey(previous.card.language, previous.card.text) !== expressionKey(card.language, card.text);
            // 改词保留此卡进度，但词条身份必须重绑；不能污染原词其他语境。
            const saved = validateCard({ ...card, id: previous?.card.id || card.id, expressionId: shared?.card.expressionId || (changed ? newId() : card.expressionId), owner: "builtin" });
            // 来源只追加引用，从不通过出处读取或修改正文。
            const sources = [...(previous?.sources || [])];
            if (source && !sources.some(item => sourceKey(item) === sourceKey(source))) sources.push(source);
            // 单个目录文件原子提交，卡片、次数和内容版本一起生效。
            const record: LibraryRecord = { card: saved, sources, baseline: previous?.baseline ?? (captureId ? 0 : 1), captures: [...(previous?.captures || []), ...(captureId ? [captureId] : [])], revision: (previous?.revision || 0) + 1, updatedAt: new Date().toISOString() };
            if (previous) catalog.records[catalog.records.indexOf(previous)] = record;
            else catalog.records.push(record);
            if (captureId) { catalog.receipts = { ...catalog.receipts, [captureId]: structuredClone(record) }; }
            await this.publish(catalog);
            return record;
        });
    }
    /** 软删除保留历史，旧文章和旧导入都不能自动复活资料 */
    async remove(id: string, expectedRevision?: number): Promise<void> {
        await this.port.exclusive(async () => {
            // 读取当前状态后再次确认删除目标。
            const catalog = await this.catalog();
            // 删除不存在目标不误操作其他卡片。
            const record = catalog.records.find(item => item.card.id === id);
            if (!record) throw new Error("学习卡片不存在");
            if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new Error("卡片已变化，请刷新后重试");
            record.deleted = true; record.revision++; record.updatedAt = new Date().toISOString();
            await this.publish(catalog);
        });
    }
    /** 全库使用相同的复习规则，界面偏好继续由各插件保存 */
    async configure(review: Partial<LibraryCatalog["review"]>, expected?: Partial<LibraryCatalog["review"]>): Promise<void> {
        await this.port.exclusive(async () => {
            // 合并规则时保留其他窗口刚写入的卡片。
            const catalog = await this.catalog();
            for (const key of Object.keys(review) as Array<keyof LibraryCatalog["review"]>) {
                if (expected && expected[key] !== catalog.review[key]) throw new Error("复习设置已被其他窗口修改，请重新加载设置");
            }
            // 不同字段独立合并，同字段的过期修改明确拒绝。
            catalog.review = { ...catalog.review, ...review };
            if (!Number.isInteger(catalog.review.newLimit) || catalog.review.newLimit < 10 || catalog.review.newLimit > 200 || !(catalog.review.retention >= .7 && catalog.review.retention <= .97)) throw new Error("复习设置无效");
            catalog.reviewRevision = (catalog.reviewRevision || 0) + 1;
            await this.publish(catalog);
        });
    }
    /** 学习日规则是共享配置，修改时必须确认其版本基线 */
    async configureCalendar(calendar: NonNullable<LibraryCatalog["calendar"]>, expectedRevision: number): Promise<void> {
        if (!Number.isInteger(calendar.rolloverHour) || calendar.rolloverHour < 0 || calendar.rolloverHour > 23) throw new Error("切日小时必须为 0—23");
        new Intl.DateTimeFormat("en", { timeZone: calendar.timeZone }).format();
        await this.port.exclusive(async () => {
            // 配置版本与资料版本分别维护。
            const catalog = await this.catalog();
            if ((catalog.reviewRevision || 0) !== expectedRevision) throw new Error("共享学习日设置已变化，请刷新后重试");
            catalog.calendar = { ...calendar }; catalog.reviewRevision = expectedRevision + 1;
            await this.publish(catalog);
        });
    }

}
