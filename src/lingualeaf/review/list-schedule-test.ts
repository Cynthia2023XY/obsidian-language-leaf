import { describe, expect, it } from "vitest";
import { createEmptyCard } from "ts-fsrs";
import { prepare, serialize } from "./engine";
import type { ReviewState } from "./engine";
import { externalSchedule, listSchedule } from "./list-schedule";

/** 固定本地时间以验证列表日期与评分排期一致 */
const now = new Date(2026, 10, 8, 12, 0);
/** 未首次评分的新词尚无真实的下次复习日期 */
function fresh(): ReviewState { return { revision: 0, suspended: false, card: serialize(createEmptyCard(new Date(0))) }; }

describe("单词列表复习时间", () => {
    it("未学习和暂停卡片不显示内部占位日期", () => {
        expect(listSchedule(fresh(), now)).toContain("待首次学习");
        expect(listSchedule({ ...fresh(), suspended: true }, now)).toBe("已暂停");
    });
    it("新卡记得后两天到期，简单后八天到期，第二天不会误标已到期", () => {
        // 使用实际评分算法，验证列表读取真实结果而非按收录日期猜测。
        const prepared = prepare("card-test", fresh(), now, .9);
        // 第二天复习时，两种评分结果都仍未到期。
        const tomorrow = new Date(2026, 10, 9, 12, 0);
        expect(new Date(prepared.choices[3].due).getTime() - now.getTime()).toBe(2 * 86400000);
        expect(new Date(prepared.choices[4].due).getTime() - now.getTime()).toBe(8 * 86400000);
        for (const rating of [3, 4]) {
            // 模拟首次评分后已经落盘的状态。
            const state = { revision: 1, suspended: false, card: prepared.choices[rating] };
            expect(listSchedule(state, tomorrow)).not.toContain("已到期");
            expect(listSchedule(state, new Date(state.card.due))).toContain("已到期");
            expect(listSchedule(state, tomorrow)).not.toContain("待首次学习");
        }
    });
    it("SR 卡片显示原调度日期，不支持的格式不伪造成新词", () => {
        expect(externalSchedule("", now)).toBe("SR · 待首次学习");
        expect(externalSchedule("<!--SR:!2026-11-07,3,250-->", now)).toContain("已到期");
        expect(externalSchedule("<!--SR:unknown-->", now)).toContain("暂不支持");
    });
});
