import { createEmptyCard } from "ts-fsrs";
import { serialize, validateState } from "./engine";
import type { ReviewState } from "./engine";

export function importSchedule(raw: string, reset: boolean, now = new Date()): { state: ReviewState; description: string } {
    const initial: ReviewState = { revision: 0, suspended: false, card: serialize(createEmptyCard(now)) };
    if (reset || !raw.trim()) return { state: initial, description: reset ? "重新开始（保留原调度备份）" : "未复习的新卡片" };
    const full = /^<!--SR:!fsrs,([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+)-->$/.exec(raw.trim());
    if (full) {
        const [, due, interval, stability, difficulty, state, reps, lapses, steps, last] = full;
        initial.card = { due, scheduled_days: Number(interval), stability: Number(stability), difficulty: Number(difficulty), state: Number(state), reps: Number(reps), lapses: Number(lapses), learning_steps: Number(steps), elapsed_days: last === "-" ? 0 : Math.max(0, Math.floor((now.getTime() - Date.parse(last)) / 86400000)), ...(last === "-" ? {} : { last_review: last }) };
        validateState(initial);
        return { state: initial, description: "导入完整 FSRS 状态（不包含旧插件复习日志及自定义参数）" };
    }
    const match = /^<!--SR:!(\d{4}-\d{2}-\d{2}),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)-->$/.exec(raw.trim());
    if (!match) throw new Error("此调度格式暂不能可靠转换，可选择“重新开始”；原调度仍完整备份");
    const due = new Date(`${match[1]}T00:00:00`); const days = Number(match[2]); const ease = Number(match[3]);
    if (!Number.isFinite(due.getTime()) || days <= 0 || ease < 100 || ease > 1000) throw new Error("SR 调度数值无效");
    initial.card = { ...initial.card, due: due.toISOString(), stability: days, difficulty: Math.max(1, Math.min(10, 10 - (Math.max(130, Math.min(370, ease)) - 130) / 240 * 9)), scheduled_days: days, elapsed_days: Math.max(0, Math.floor((now.getTime() - (due.getTime() - days * 86400000)) / 86400000)), state: 2, reps: Math.max(1, Math.round(Math.log2(days + 1))), last_review: new Date(due.getTime() - days * 86400000).toISOString() };
    validateState(initial);
    return { state: initial, description: `近似转换旧算法进度 · 原间隔 ${days} 天（不是等价 FSRS 历史）` };
}
