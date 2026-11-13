import { createEmptyCard, fsrs, State } from "ts-fsrs";
import type { Card, Grade } from "ts-fsrs";
import type { FilePort } from "../storage";

export const GRADES = [
    { rating: 1, label: "不记得", key: "ArrowLeft", arrow: "←" },
    { rating: 2, label: "不确定", key: "ArrowDown", arrow: "↓" },
    { rating: 3, label: "记得", key: "ArrowUp", arrow: "↑" },
    { rating: 4, label: "简单", key: "ArrowRight", arrow: "→" },
] as const;
export type SavedCard = Omit<Card, "due" | "last_review"> & { due: string; last_review?: string };
export interface ReviewState { revision: number; card: SavedCard; suspended: boolean }
export interface ReviewEvent { schema: 1; id: string; cardId: string; at: string; scheduledAt?: string; algorithm?: "FSRS-6"; parameterVersion?: "leaf-1"; session: string; kind: "grade" | "undo" | "suspend" | "import"; before: ReviewState; after: ReviewState; rating?: number; undoes?: string; library: "ts-fsrs@5.4.1"; retention: number }
export interface Prepared { id: string; before: ReviewState; at: Date; choices: Record<number, SavedCard>; retention: number }
export function serialize(card: Card): SavedCard { return { ...card, due: card.due.toISOString(), last_review: card.last_review?.toISOString() }; }
export function hydrate(card: SavedCard): Card { return { ...card, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined }; }
export function validateState(value: ReviewState): void {
    if (!value || !Number.isInteger(value.revision) || value.revision < 0 || typeof value.suspended !== "boolean" || !value.card || !Number.isFinite(Date.parse(value.card.due)) || (value.card.last_review && !Number.isFinite(Date.parse(value.card.last_review)))) throw new Error("复习状态损坏，已停止写入");
    for (const key of ["stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses", "state"] as const) if (!Number.isFinite(value.card[key]) || value.card[key] < 0) throw new Error("复习状态数值损坏");
    for (const key of ["learning_steps", "reps", "lapses", "state"] as const) if (!Number.isInteger(value.card[key])) throw new Error("复习次数和状态必须为整数");
    if (value.card.difficulty > 10 || (value.card.state !== 0 && value.card.difficulty < 1)) throw new Error("复习难度超出范围");
    if (![0, 1, 2, 3].includes(value.card.state)) throw new Error("未知复习状态");
}
export function prepare(id: string, before: ReviewState, now: Date, retention: number): Prepared {
    validateState(before);
    const algorithm = fsrs({ request_retention: retention, enable_fuzz: false, learning_steps: ["10m"], relearning_steps: ["10m"] });
    const results = algorithm.repeat(hydrate(before.card), now);
    const choices: Record<number, SavedCard> = {};
    for (const grade of GRADES) choices[grade.rating] = serialize(results[grade.rating as Grade].card);
    return { id, before, at: now, choices, retention };
}
/** 所有设备使用学习库指定时区和切换点计算学习日 */
export function studyDay(date: Date, calendar?: { timeZone: string; rolloverHour: number }): string {
    // 兼容旧模式的本地学习日，独立库始终显式传入配置。
    if (!calendar) {
        // 旧版四点切日规则保持不变。
        const local = new Date(date); local.setHours(local.getHours() - 4);
        return `${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()}`;
    }
    if (!Number.isInteger(calendar.rolloverHour) || calendar.rolloverHour < 0 || calendar.rolloverHour > 23) throw new Error("学习日切换时间无效");
    // 先读取指定时区的墙上时间，避免夏令时跨日偏移。
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: calendar.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
    // 以 UTC 表达墙上日期，仅用于日期运算。
    const value = (type: string): number => Number(parts.find(part => part.type === type)?.value);
    // 四点之前归属前一个学习日。
    const day = new Date(Date.UTC(value("year"), value("month") - 1, value("day") - (value("hour") < calendar.rolloverHour ? 1 : 0)));
    return `${day.getUTCFullYear()}-${day.getUTCMonth() + 1}-${day.getUTCDate()}`;
}
export function reviewKey(event: KeyboardEvent, revealed: boolean): number | "reveal" | undefined {
    const target = event.target as HTMLElement;
    if (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || target?.closest?.("input,textarea,select,button,[contenteditable='true']")) return;
    if (event.code === "Space" && !revealed) return "reveal";
    return revealed ? GRADES.find(grade => grade.key === event.key)?.rating : undefined;
}
export function interval(card: SavedCard, now: Date): string {
    const minutes = Math.max(1, Math.round((Date.parse(card.due) - now.getTime()) / 60000));
    return minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
}
/** Revision filenames are create-only: two writers cannot overwrite the same review. */
export class ReviewStore {
    /** 已验证的不可变事件前缀，同版本不会重复读取全部旧历史 */
    private histories = new Map<string, { paths: string[]; events: ReviewEvent[] }>();
    constructor(private port: FilePort, readonly root: string) {}
    private path(id: string, revision: number): string {
        if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("非法卡片身份");
        return `${this.root}/review/events/${id}/${String(revision).padStart(10, "0")}.json`;
    }
    async events(id: string): Promise<ReviewEvent[]> {
        const prefix = this.path(id, 0).replace(/[^/]+$/, "");
        const paths = (await this.port.list(prefix)).filter(path => path.endsWith(".json")).sort();
        // 本地事件只追加不覆盖，路径前缀不变时复用已验证历史。
        const cached = this.histories.get(id);
        // 发现路径被删改时回到完整重建，避免复用失效链。
        const reusable = cached && cached.paths.every((path, index) => paths[index] === path);
        // 返回克隆，调用者不能修改缓存中的调度基线。
        const events: ReviewEvent[] = reusable ? structuredClone(cached.events) : [];
        for (const path of paths.slice(events.length)) {
            const event = JSON.parse((await this.port.read(path)) || "null") as ReviewEvent;
            if (!event || event.schema !== 1 || event.cardId !== id || event.before.revision !== events.length || event.after.revision !== events.length + 1 || path !== this.path(id, events.length + 1)) throw new Error("复习记录冲突或损坏，请先处理同步冲突");
            validateState(event.before); validateState(event.after);
            if (events.length && JSON.stringify(events[events.length - 1].after) !== JSON.stringify(event.before)) throw new Error("复习记录链不连续");
            events.push(event);
        }
        this.histories.set(id, { paths, events: structuredClone(events) });
        return events;
    }
    async state(id: string): Promise<ReviewState> {
        const events = await this.events(id);
        return events.length ? events[events.length - 1].after : { revision: 0, card: serialize(createEmptyCard(new Date(0))), suspended: false };
    }
    async append(event: ReviewEvent): Promise<void> {
        validateState(event.before); validateState(event.after);
        if (event.schema !== 1 || event.after.revision !== event.before.revision + 1 || !Number.isFinite(Date.parse(event.at))) throw new Error("无效复习事件");
        if (!this.port.create) throw new Error("存储不支持安全创建复习记录");
        const path = this.path(event.cardId, event.after.revision);
        const existing = await this.port.read(path);
        if (existing) { if ((JSON.parse(existing) as ReviewEvent).id === event.id) return; throw new Error("复习进度已变化，请刷新后重试"); }
        const state = await this.state(event.cardId);
        if (JSON.stringify(state) !== JSON.stringify(event.before)) throw new Error("复习进度已变化，请刷新后重试");
        try { await this.port.create(path, JSON.stringify({ ...event, algorithm: "FSRS-6", parameterVersion: "leaf-1" }, null, 2)); }
        catch (error) { const saved = await this.port.read(path); if (!saved || JSON.parse(saved).id !== event.id) throw error; }
    }
}
export function priority(state: ReviewState): number { return state.card.state === State.New ? 2 : state.card.state === State.Review ? 1 : 0; }
