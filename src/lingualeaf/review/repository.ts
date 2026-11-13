import type { FilePort } from "../storage";
import type { LearningRepository, LibraryRepositoryPort } from "../repository";
import { ReviewStore, studyDay } from "./engine";
import type { ReviewEvent, ReviewState } from "./engine";
import type { StudyCalendar } from "./service";

/** 可重建的复习状态、到期索引和学习日统计 */
export interface ReviewProjection {
    /** 每张卡片最新的完整状态 */
    states: Record<string, ReviewState>;
    /** 每个学习日已经启用的新卡 */
    days: Record<string, string[]>;
    /** 每个会话有效评分过的卡片 */
    sessions: Record<string, string[]>;
    /** 各会话各卡最近的有效评分，供撤销选择 */
    last: Record<string, ReviewEvent[]>;
    /** 按到期时间排列的卡片身份 */
    due: string[];
}
/** 复习业务只依赖此接口，远程客户端不需要知道事件文件名 */
export interface ReviewRepository {
    /** 获取可重建当前状态与统计 */
    projection(calendar: StudyCalendar): Promise<ReviewProjection>;
    /** 查询单卡事件链 */
    events(id: string): Promise<ReviewEvent[]>;
    /** 查询当前卡片状态 */
    state(id: string): Promise<ReviewState>;
    /** 原子追加事件并校验版本 */
    append(event: ReviewEvent): Promise<void>;
    /** 跨资料一致性业务事务 */
    transaction<T>(action: () => Promise<T>): Promise<T>;
    /** 获取会话快照 */
    readSession(key: string): Promise<string | null>;
    /** 保存会话断点 */
    saveSession(key: string, content: string): Promise<void>;
}
/** 本地文件实现隐藏事件布局，派生索引随时可删除重建 */
export class LocalReviewRepository implements ReviewRepository {
    /** 事件链校验和独占发布适配器 */
    private store: ReviewStore;
    /** 当前实例已验证的派生索引 */
    private cached?: { version: string; projection: ReviewProjection };
    /** 连接本地文件和可选的资料仓储 */
    constructor(private port: FilePort, private root: string, private learning?: LearningRepository) { this.store = new ReviewStore(port, root); }
    /** 业务只查询卡片身份，不暴露存储目录 */
    events(id: string): Promise<ReviewEvent[]> { return this.store.events(id); }
    /** 获取单卡调度状态 */
    state(id: string): Promise<ReviewState> { return this.store.state(id); }
    /** 原子创建事件后派生索引自然失效 */
    async append(event: ReviewEvent): Promise<void> { await this.store.append(event); this.cached = undefined; }
    /** 同一把锁保护配置、额度与事件发布 */
    async transaction<T>(action: () => Promise<T>): Promise<T> {
        // Vault 旧端口无跨资料锁，继续使用事件版本保护。
        const port = this.port as Partial<LibraryRepositoryPort>;
        return port.exclusive ? port.exclusive(action) : action();
    }
    /** 本地会话布局只存在于适配器 */
    readSession(key: string): Promise<string | null> { return this.port.read(`${this.root}/review/sessions/${encodeURIComponent(key)}.json`); }
    /** 外部输入必须编码为一个文件名，不能跳出会话目录 */
    saveSession(key: string, content: string): Promise<void> { return this.port.write(`${this.root}/review/sessions/${encodeURIComponent(key)}.json`, content); }
    /** 索引基线由全部已发布不可变事件路径组成，导入中断的孤立文件不参与 */
    async projection(calendar: StudyCalendar): Promise<ReviewProjection> {
        // 固定资料可见性，目录尚未提交的导入事件不可见。
        const visible = this.learning ? new Set((await this.learning.catalog()).records.map(record => record.card.id)) : undefined;
        // 这里只枚举事件路径，未变化的历史不会重新读取。
        const paths = (await this.port.list(`${this.root}/review/events/`)).filter(path => path.endsWith(".json") && (!visible || visible.has(path.split("/").slice(-2)[0]))).sort();
        // 学习日规则变更也必须重建每日统计。
        const version = JSON.stringify([calendar, paths]);
        if (this.cached?.version === version) return structuredClone(this.cached.projection);
        // 冷启动使用派生快照，无快照时从完整审计历史恢复。
        const raw = await this.port.read(`${this.root}/review/projection.json`);
        if (raw) {
            try {
                // 派生文件损坏不影响权威事件，直接重建。
                const saved = JSON.parse(raw);
                if (saved.schema === 1 && saved.version === version && JSON.stringify(saved.projection) === saved.validation) {
                    this.cached = { version, projection: saved.projection }; return structuredClone(saved.projection);
                }
            } catch { /* 继续从权威事件重建 */ }
        }
        // 先分组校验事件链，再构造所有当前状态。
        const ids = [...new Set(paths.map(path => path.split("/").slice(-2)[0]))];
        // 各卡事件不可跨时间简单拼接，逐卡保持修订链。
        const events = (await Promise.all(ids.map(id => this.store.events(id)))).flat();
        // 已撤销评分不计入每日额度和会话进度。
        const undone = new Set(events.filter(event => event.kind === "undo").map(event => event.undoes));
        // 当前状态快照和查询索引可以完全从事件恢复。
        const projection: ReviewProjection = { states: {}, days: {}, sessions: {}, last: {}, due: [] };
        for (const event of events) {
            projection.states[event.cardId] = event.after;
            if (event.kind !== "grade" || undone.has(event.id)) continue;
            // 同一卡在一个学习日只消耗一次新卡额度。
            const day = studyDay(new Date(event.at), calendar);
            if (event.before.card.state === 0) projection.days[day] = [...new Set([...(projection.days[day] || []), event.cardId])];
            projection.sessions[event.session] = [...new Set([...(projection.sessions[event.session] || []), event.cardId])];
            projection.last[event.session] = [...(projection.last[event.session] || []).filter(item => item.cardId !== event.cardId), event];
        }
        projection.due = Object.keys(projection.states).filter(id => !projection.states[id].suspended && projection.states[id].card.state !== 0).sort((a,b) => Date.parse(projection.states[a].card.due) - Date.parse(projection.states[b].card.due));
        this.cached = { version, projection: structuredClone(projection) };
        try {
            // 派生快照写失败不能回滚已成功提交的评分。
            await this.port.write(`${this.root}/review/projection.json`, JSON.stringify({ schema: 1, version, projection, validation: JSON.stringify(projection) }));
        } catch { /* 下次读取按权威事件重建 */ }
        return projection;
    }
}
