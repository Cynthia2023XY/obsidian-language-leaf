import { describe, expect, it } from "vitest";
import { importSchedule } from "./import-schedule";
const now = new Date("2026-10-26T12:00:00Z");
describe("旧卡片调度导入", () => {
    it("完整 FSRS 状态保持到期时间、步骤与记忆参数", () => {
        const result = importSchedule("<!--SR:!fsrs,2026-10-27T10:00:00.000Z,2,3.5,5.2,2,7,1,0,2026-10-25T10:00:00.000Z-->", false, now);
        expect(result.state.card).toMatchObject({ due: "2026-10-27T10:00:00.000Z", stability: 3.5, difficulty: 5.2, reps: 7, lapses: 1, learning_steps: 0, last_review: "2026-10-25T10:00:00.000Z" });
        expect(result.description).toContain("完整 FSRS");
    });
    it("旧算法仅近似转换且保留原本地到期日", () => {
        const result = importSchedule("<!--SR:!2026-10-27,7,250-->", false, now);
        expect(result.description).toContain("近似"); expect(result.state.card.difficulty).toBe(5.5);
        expect(new Date(result.state.card.due).getDate()).toBe(27); expect(result.state.card.state).toBe(2);
    });
    it("未复习卡和主动重置保持新卡状态", () => {
        expect(importSchedule("", false, now).state.card.state).toBe(0);
        expect(importSchedule("<!--SR:unknown-->", true, now).state.card.state).toBe(0);
    });
    it("多张 SR 调度及未知格式不能被悄悄丢弃", () => {
        for (const raw of ["<!--SR:!2026-10-27,7,250-->\n<!--SR:!2026-10-28,8,250-->", "<!--SR:bad-->", "<!--SR:!fsrs,bad,2,3,5,2,7,1,0,---->"]) expect(() => importSchedule(raw, false, now)).toThrow();
    });
    it("非法状态和负值不能进入算法", () => {
        expect(() => importSchedule("<!--SR:!fsrs,2026-10-27T10:00:00Z,2,-3,5,2,7,1,0,2026-10-25T10:00:00Z-->", false, now)).toThrow();
    });
});
