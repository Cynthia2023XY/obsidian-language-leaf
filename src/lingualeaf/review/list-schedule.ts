import type { ReviewState } from "./engine";
import { importSchedule } from "./import-schedule";

/** 单词列表展示真实调度时间，未学习状态不显示内部占位日期 */
export function listSchedule(state: ReviewState, now = new Date()): string {
    if (state.suspended) return "已暂停";
    if (state.card.state === 0) return "待首次学习（受每日新词额度限制）";
    return `${new Date(state.card.due).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}${Date.parse(state.card.due) <= now.getTime() ? "（已到期）" : ""}`;
}

/** 外部 SR 卡片只读取原文调度，不创建或修改内置复习进度 */
export function externalSchedule(raw: string, now = new Date()): string {
    if (!raw.trim()) return "SR · 待首次学习";
    try { return `SR · ${listSchedule(importSchedule(raw, false, now).state, now)}`; }
    catch { return "SR · 调度格式暂不支持显示"; }
}
