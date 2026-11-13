import { LocalReviewRepository } from "./repository";
import type { ReviewRepository } from "./repository";
import { newId } from "../domain";
import type { LeafCard } from "../domain";
import type { FilePort } from "../storage";
import type { LearningRepository } from "../repository";
import { prepare, priority, studyDay } from "./engine";
import type { Prepared, ReviewEvent, ReviewState } from "./engine";

/** 复习服务需要的资料，来源字段由宿主适配器自行扩展 */
export interface ReviewItem { /** 卡片自身的身份和内容 */ card: LeafCard }
/** 所有客户端共用的学习日边界 */
export interface StudyCalendar { /** 固定 IANA 时区 */ timeZone: string; /** 每日切换小时 */ rolloverHour: number }
/** 无界面依赖的队列、评分、额度与冲突服务 */
export class ReviewService {
    /** 追加式事件仓库 */
    readonly store: ReviewRepository;
    /** 绑定仓储和可注入时钟，测试无需依赖系统时间 */
    constructor(port: FilePort | ReviewRepository, root: string, private repository?: LearningRepository, private clock: () => Date = () => new Date()) {
        this.store = "projection" in port ? port : new LocalReviewRepository(port, root, repository);
    }
    /** 获取共享规则，旧库首次使用时以固定时区解释学习日 */
    async rules() {
        // 无独立库的兼容适配器使用旧规则。
        const catalog = await this.repository?.catalog();
        return { newLimit: catalog?.review.newLimit ?? 100, retention: catalog?.review.retention ?? .9, calendar: catalog?.calendar ?? { timeZone: catalog ? "Asia/Shanghai" : Intl.DateTimeFormat().resolvedOptions().timeZone, rolloverHour: 4 } };
    }
    /** 日期按学习库时区计算，与设备系统时区无关 */
    day(date: Date, calendar: StudyCalendar): string { return studyDay(date, calendar); }
    /** 队列、额度和会话统计来自同一次历史读取 */
    async queue<T extends ReviewItem>(cards: T[], session: string, skipped: Set<string>, fallback?: { newLimit: number; retention: number }) {
        // 先冻结本轮时钟与全库规则。
        const now = this.clock();
        // 兼容模式保留用户原额度。
        const rules = this.repository ? await this.rules() : { ...fallback!, calendar: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, rolloverHour: 4 } };
        // 从可重建状态和每日统计索引读取，不重复重放整库历史。
        const projection = await this.store.projection(rules.calendar);
        // 缺少历史的新卡使用引擎初始状态。
        const rows = await Promise.all(cards.map(async item => ({ item, state: projection.states[item.card.id] || await this.store.state(item.card.id) })));
        // 全库额度不受当前文章筛选影响。
        const newToday = new Set(projection.days[this.day(now, rules.calendar)] || []);
        // 暂停和本轮跳过不进入队列。
        const eligible = rows.filter(row => !row.state.suspended && !skipped.has(row.item.card.id));
        // 先学习中、后到期复习，保持既有优先级。
        const due = eligible.filter(row => row.state.card.state !== 0 && Date.parse(row.state.card.due) <= now.getTime()).sort((a, b) => priority(a.state) - priority(b.state) || Date.parse(a.state.card.due) - Date.parse(b.state.card.due));
        // 新卡受每日剩余额度约束。
        const fresh = eligible.filter(row => row.state.card.state === 0);
        // 统计本轮有效评分过的不同卡片。
        const reviewed = new Set((projection.sessions[session] || []).filter(id => cards.some(item => item.card.id === id)));
        // 只有仍为当前卡最后一次操作的评分可撤销。
        const last = (projection.last[session] || []).filter(event => projection.states[event.cardId]?.revision === event.after.revision).sort((a,b) => Date.parse(b.at) - Date.parse(a.at))[0];
        return { now, rows, eligible, due, fresh, reviewed, last, newToday, selected: due[0] || (newToday.size < rules.newLimit ? fresh[0] : undefined), availableNew: Math.min(fresh.length, Math.max(0, rules.newLimit - newToday.size)), rules };
    }
    /** 四档 FSRS 结果预览 */
    preview(id: string, state: ReviewState, retention: number): Prepared { return prepare(id, state, this.clock(), retention); }
    /** 把用户评分冻结成可重复提交的请求 */
    grade(prepared: Prepared, rating: number, session: string): ReviewEvent {
        if (![1, 2, 3, 4].includes(rating)) throw new Error("未知评分");
        return { schema: 1, id: newId(), cardId: prepared.id, at: this.clock().toISOString(), scheduledAt: prepared.at.toISOString(), session, kind: "grade", before: prepared.before, after: { ...prepared.before, revision: prepared.before.revision + 1, card: prepared.choices[rating] }, rating, library: "ts-fsrs@5.4.1", retention: prepared.retention };
    }
    /** 提交时串行检查额度和资料，避免双窗口领取最后一个额度 */
    async commit(event: ReviewEvent): Promise<void> {
        // 幂等确认必须先于资料、设置和额度检查。
        const run = async (): Promise<void> => {
            if ((await this.store.events(event.cardId)).some(saved => saved.id === event.id)) return;
            if (this.repository) {
                // 新资料、删除和共享规则在同一把业务锁中读取。
                const catalog = await this.repository.catalog();
                if (!catalog.records.some(record => record.card.id === event.cardId && !record.deleted)) throw new Error("学习资料已删除");
                if (event.kind === "grade" && event.retention !== catalog.review.retention) throw new Error("共享复习规则已改变，请刷新后重试");
                if (event.kind === "grade" && event.before.card.state === 0) {
                    // 新卡额度在真正提交时再次校验，不能只依赖队列快照。
                    const rules = await this.rules();
                    // 事件按提交时学习日计入，跨日停留后需重新预览。
                    if (this.day(new Date(event.at), rules.calendar) !== this.day(this.clock(), rules.calendar)) throw new Error("学习日已切换，请刷新评分");
                    // 提交时读取最新每日索引，和事件写入处于同一业务锁中。
                    const projection = await this.store.projection(rules.calendar);
                    // 同一卡重复学习只占一个额度。
                    const used = new Set(projection.days[this.day(this.clock(), rules.calendar)] || []);
                    if (!used.has(event.cardId) && used.size >= rules.newLimit) throw new Error("今日新卡额度已用完，请刷新复习队列");
                }
            }
            await this.store.append(event);
        };
        await this.store.transaction(run);
    }
    /** 按客户端会话键读取断点，陈旧学习日的断点自动失效 */
    async resume(key: string): Promise<{ id: string; skipped: string[] } | undefined> {
        // 会话键由宿主限定来源，内部不接受外部路径。
        const raw = await this.store.readSession(key);
        if (!raw) return undefined;
        // 只有当前学习日才能复用跳过集合。
        const value = JSON.parse(raw);
        // 使用学习库时区，与评分额度共享同一学习日。
        const rules = await this.rules();
        return value.schema === 1 && typeof value.id === "string" && value.day === this.day(this.clock(), rules.calendar) ? { id: value.id, skipped: Array.isArray(value.skipped) ? value.skipped.filter((id: unknown) => typeof id === "string") : [] } : undefined;
    }
    /** 会话持久化失败不回滚已经确认的评分 */
    async checkpoint(key: string, id: string, skipped: Set<string>): Promise<void> {
        // 学习日由统一配置计算，跨设备可恢复同一会话边界。
        const rules = await this.rules();
        await this.store.saveSession(key, JSON.stringify({ schema: 1, id, day: this.day(this.clock(), rules.calendar), skipped: [...skipped] }));
    }
    /** 撤销保留完整审计链，不回退事件版本号 */
    async undo(last: ReviewEvent): Promise<void> {
        // 事件仓库在提交时再次校验基线，其他窗口已评分时明确冲突。
        const state = await this.store.state(last.cardId);
        if (state.revision !== last.after.revision) throw new Error("此卡已有后续操作，无法撤销");
        await this.commit({ ...last, id: newId(), at: this.clock().toISOString(), kind: "undo", before: state, after: { ...last.before, revision: state.revision + 1 }, undoes: last.id, rating: undefined });
    }
    /** 暂停和恢复也通过同一事务入口 */
    async suspend(id: string, before: ReviewState, suspended: boolean, session: string, retention: number): Promise<void> {
        await this.commit({ schema: 1, id: newId(), cardId: id, at: this.clock().toISOString(), session, kind: "suspend", before, after: { ...before, revision: before.revision + 1, suspended }, library: "ts-fsrs@5.4.1", retention });
    }
}
