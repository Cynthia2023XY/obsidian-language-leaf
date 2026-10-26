import { describe, expect, it } from "vitest";
import { createEmptyCard, fsrs } from "ts-fsrs";
import { GRADES, hydrate, interval, prepare, priority, ReviewStore, reviewKey, serialize, studyDay } from "./engine";
import type { ReviewEvent, ReviewState } from "./engine";
import type { FilePort } from "../storage";
const now = new Date("2026-10-26T12:00:00Z");
class Memory implements FilePort {
    files = new Map<string, string>(); fail = false; afterWrite = false;
    async read(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
    async write(path: string, text: string): Promise<void> { this.files.set(path, text); }
    async create(path: string, text: string): Promise<void> {
        if (this.files.has(path)) throw new Error("exists");
        if (this.fail) throw new Error("disk full");
        this.files.set(path, text); if (this.afterWrite) throw new Error("uncertain response");
    }
    async list(prefix: string): Promise<string[]> { return Array.from(this.files.keys()).filter(path => path.startsWith(prefix)); }
}
async function event(store: ReviewStore, id = "op-1"): Promise<ReviewEvent> {
    const before = await store.state("card-1"); const prepared = prepare("card-1", before, now, .9);
    return { schema: 1, id, cardId: "card-1", at: now.toISOString(), session: "test", kind: "grade", before, after: { ...before, revision: before.revision + 1, card: prepared.choices[3] }, rating: 3, library: "ts-fsrs@5.4.1", retention: .9 };
}
describe("FSRS 适配与方向键", () => {
    it("四档预览与固定版本库计算一致", () => {
        const state: ReviewState = { revision: 0, suspended: false, card: serialize(createEmptyCard(now)) };
        const prepared = prepare("x", state, now, .9);
        const expected = fsrs({ request_retention: .9, enable_fuzz: false, learning_steps: ["1m", "10m"], relearning_steps: ["10m"] }).repeat(hydrate(state.card), now);
        for (const grade of GRADES) expect(prepared.choices[grade.rating]).toEqual(serialize(expected[grade.rating].card));
        expect(interval(prepared.choices[1], now)).toBe("1 分钟");
    });
    it("未揭晓时方向键不能评分，空格只负责揭晓", () => {
        expect(reviewKey(new KeyboardEvent("keydown", { key: "ArrowLeft" }), false)).toBeUndefined();
        expect(reviewKey(new KeyboardEvent("keydown", { code: "Space" }), false)).toBe("reveal");
        expect(reviewKey(new KeyboardEvent("keydown", { code: "Space" }), true)).toBeUndefined();
    });
    it("左下上右对应不记得、不确定、记得、简单", () => {
        expect(GRADES.map(grade => grade.label)).toEqual(["不记得", "不确定", "记得", "简单"]);
        for (const grade of GRADES) expect(reviewKey(new KeyboardEvent("keydown", { key: grade.key }), true)).toBe(grade.rating);
    });
    it("忽略长按、组合输入和修饰键", () => {
        for (const flags of [{ repeat: true }, { isComposing: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) expect(reviewKey(new KeyboardEvent("keydown", { key: "ArrowRight", ...flags }), true)).toBeUndefined();
    });
    it("编辑输入框内的方向键保持原用途", () => {
        const input = document.createElement("textarea"); const key = new KeyboardEvent("keydown", { key: "ArrowDown" }); input.dispatchEvent(key);
        expect(reviewKey(key, true)).toBeUndefined();
    });
    it("学习与重学排在到期复习和新卡前", () => {
        const state: ReviewState = { revision: 0, suspended: false, card: serialize(createEmptyCard(now)) };
        expect(priority(state)).toBe(2); state.card.state = 2; expect(priority(state)).toBe(1); state.card.state = 3; expect(priority(state)).toBe(0);
    });
    it("本地凌晨四点为学习日边界", () => {
        expect(studyDay(new Date(2026, 9, 26, 3, 59))).toBe("2026-10-25");
        expect(studyDay(new Date(2026, 9, 26, 4, 0))).toBe("2026-10-26");
    });
});
describe("不可覆盖复习日志", () => {
    it("重启后从事件恢复并保留确切预览结果", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); const score = await event(store);
        await store.append(score); expect(await new ReviewStore(port, "Data").state("card-1")).toEqual(score.after);
    });
    it("同一评分重试只写一笔", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); const score = await event(store);
        await store.append(score); await store.append(score); expect((await store.events("card-1")).length).toBe(1);
    });
    it("写入失败不改变进度，允许同一操作重试", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); const score = await event(store); port.fail = true;
        await expect(store.append(score)).rejects.toThrow("disk full"); expect((await store.state("card-1")).revision).toBe(0);
        port.fail = false; await store.append(score); expect((await store.state("card-1")).revision).toBe(1);
    });
    it("文件已落盘而响应失败时不重复提交", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); const score = await event(store); port.afterWrite = true;
        await store.append(score); expect((await store.events("card-1")).length).toBe(1);
    });
    it("并发评分只能有一个占用同一版本", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); const a = await event(store, "a"); const b = await event(store, "b");
        const result = await Promise.allSettled([store.append(a), store.append(b)]);
        expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1); expect((await store.events("card-1"))).toHaveLength(1);
    });
    it("撤销是补偿事件，原记录仍可审计", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); const score = await event(store); await store.append(score);
        await store.append({ ...score, id: "undo", kind: "undo", undoes: score.id, before: score.after, after: { ...score.before, revision: 2 } });
        expect((await store.events("card-1"))).toHaveLength(2); expect((await store.state("card-1")).card).toEqual(score.before.card);
    });
    it("同步产生的额外副本阻止继续评分", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); const score = await event(store); await store.append(score);
        port.files.set("Data/review/events/card-1/conflicted-copy.json", JSON.stringify(score));
        await expect(store.state("card-1")).rejects.toThrow("冲突");
    });
    it("拒绝目录穿越和无效状态", async () => {
        const port = new Memory(); const store = new ReviewStore(port, "Data"); await expect(store.state("../outside")).rejects.toThrow("非法");
        const score = await event(store); score.after.card.difficulty = 20; await expect(store.append(score)).rejects.toThrow("难度");
    });
});
