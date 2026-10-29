import { beforeAll, describe, expect, it, vi } from "vitest";
import { ReviewModal } from "./modal";
import { ReviewStore } from "./engine";
vi.mock("obsidian", () => ({
    Modal: class {
        app: any; modalEl = document.createElement("div"); contentEl = document.createElement("div"); titleEl = document.createElement("h1");
        constructor(app: any) { this.app = app; this.modalEl.append(this.titleEl, this.contentEl); }
        open() { document.body.append(this.modalEl); (this as any).onOpen(); }
        close() { (this as any).onClose(); this.modalEl.remove(); }
    },
    Notice: class {}, TFile: class {},
}));
beforeAll(() => {
    const prototype = HTMLElement.prototype as any;
    prototype.empty = function() { this.replaceChildren(); };
    prototype.addClass = function(value: string) { this.classList.add(value); };
    prototype.setText = function(value: string) { this.textContent = value; };
    prototype.appendText = function(value: string) { this.append(value); };
    prototype.createEl = function(tag: string, options: any = {}) {
        const element = document.createElement(tag);
        if (options.text) element.textContent = options.text;
        if (options.cls) element.className = options.cls;
        if (options.type) element.setAttribute("type", options.type);
        for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, String(value));
        this.append(element); return element;
    };
    prototype.createDiv = function(options: any) { return this.createEl("div", options); };
    prototype.createSpan = function(options: any) { return this.createEl("span", options); };
});
function fixture(layout: "focus" | "context" = "focus") {
    const files = new Map<string, string>();
    let fail = false;
    const port = {
        read: async (path: string) => files.get(path) ?? null,
        write: async (path: string, text: string) => { files.set(path, text); },
        list: async (prefix: string) => Array.from(files.keys()).filter(path => path.startsWith(prefix)),
        create: async (path: string, text: string) => { if (fail) throw new Error("disk full"); if (files.has(path)) throw new Error("exists"); files.set(path, text); },
    };
    const cards = [{ path: "article.md", card: { id: "card-test", expressionId: "expression-test", owner: "builtin", text: "on the threshold", meaning: "在门槛处", sentence: "A traveler paused.", translation: "旅人停下了。", notes: "笔记", outline: "", kind: "phrase", language: "en", anchor: "" } }];
    const plugin: any = { app: { workspace: { openLinkText: vi.fn().mockResolvedValue(undefined) } }, settings: { learning: { dataFolder: "Data" }, review: { newLimit: 10, retention: .9, layout }, review_auto_pron: false }, lingualeaf: { host: { port, settings: { dataFolder: "Data" }, scan: async () => cards } }, playReviewCardWord: vi.fn() };
    const modal = new ReviewModal(plugin); plugin.reviewModal = modal;
    return { modal, plugin, files, cards, store: new ReviewStore(port, "Data"), fail: (value: boolean) => { fail = value; } };
}
async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 25)); }
function button(modal: ReviewModal, text: string): HTMLButtonElement { return Array.from(modal.contentEl.querySelectorAll("button")).find(element => element.textContent?.includes(text))!; }
describe("真实复习弹窗 DOM 行为", () => {
    it("剩余数量包含当前新卡，并随评分和撤销更新", async () => {
        // 新卡按今日额度计入剩余数量，当前卡也包含在内。
        const setup = fixture(); setup.modal.open(); await settle();
        expect(setup.modal.titleEl.textContent).toContain("待复习 1 · 本轮已复习 0");
        button(setup.modal, "显示答案").click(); button(setup.modal, "简单").click(); await settle();
        expect(setup.modal.titleEl.textContent).toContain("待复习 0 · 本轮已复习 1");
        button(setup.modal, "撤销上次评分").click(); await settle();
        expect(setup.modal.titleEl.textContent).toContain("待复习 1 · 本轮已复习 0"); setup.modal.close();
    });
    it("新词额度限制可学数量，跳过的卡片不再计入", async () => {
        // 两张未学卡只允许先开始一张，跳过后仍可学习另一张。
        const setup = fixture();
        setup.cards.push({ ...setup.cards[0], card: { ...setup.cards[0].card, id: "card-second" } });
        setup.plugin.settings.review.newLimit = 1;
        setup.modal.open(); await settle();
        expect(setup.modal.titleEl.textContent).toContain("待复习 1 · 本轮已复习 0");
        button(setup.modal, "本轮跳过").click(); await settle();
        expect(setup.modal.titleEl.textContent).toContain("待复习 1 · 本轮已复习 0");
        button(setup.modal, "显示答案").click(); button(setup.modal, "简单").click(); await settle();
        expect(setup.modal.titleEl.textContent).toContain("待复习 0 · 本轮已复习 1"); setup.modal.close();
    });
    it("先回忆后揭晓，四档文案正确，方向键评分并可撤销", async () => {
        const setup = fixture(); setup.modal.open(); await settle();
        expect(setup.modal.contentEl.textContent).not.toContain("在门槛处");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); await settle();
        expect((await setup.store.state("card-test")).revision).toBe(0);
        document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
        expect(setup.modal.contentEl.textContent).toContain("在门槛处");
        for (const label of ["不记得", "不确定", "记得", "简单"]) expect(button(setup.modal, label)).toBeTruthy();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); await settle();
        expect((await setup.store.state("card-test")).card.state).toBe(2);
        button(setup.modal, "撤销上次评分").click(); await settle();
        expect((await setup.store.state("card-test")).card.state).toBe(0);
        expect(setup.modal.contentEl.textContent).toContain("on the threshold"); setup.modal.close();
    });
    it("保存失败保持本卡，只允许重试且最终只写一笔", async () => {
        const setup = fixture(); setup.modal.open(); await settle(); button(setup.modal, "显示答案").click(); setup.fail(true);
        button(setup.modal, "简单").click(); await settle();
        expect(setup.modal.contentEl.textContent).toContain("本次评分尚未确认保存");
        expect(button(setup.modal, "本轮跳过").disabled).toBe(true);
        expect((await setup.store.state("card-test")).revision).toBe(0);
        setup.fail(false); button(setup.modal, "重试保存").click(); await settle();
        expect(await setup.store.events("card-test")).toHaveLength(1); setup.modal.close();
    });
    it("输入框方向键不会评分，关闭后移除快捷键", async () => {
        const setup = fixture(); setup.modal.open(); await settle(); button(setup.modal, "编辑").click();
        const input = setup.modal.contentEl.querySelector("textarea")!;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await settle();
        expect((await setup.store.state("card-test")).revision).toBe(0); setup.modal.close();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); await settle();
        expect((await setup.store.state("card-test")).revision).toBe(0); expect(setup.plugin.reviewModal).toBeUndefined();
    });
    it("暂停后可恢复，关闭重开保留进度", async () => {
        const setup = fixture(); setup.modal.open(); await settle(); button(setup.modal, "暂停此卡").click(); await settle();
        expect((await setup.store.state("card-test")).suspended).toBe(true);
        button(setup.modal, "查看已暂停").click(); button(setup.modal, "恢复：").click(); await settle();
        expect((await setup.store.state("card-test")).suspended).toBe(false);
        button(setup.modal, "显示答案").click(); button(setup.modal, "简单").click(); await settle(); setup.modal.close();
        const reopened = new ReviewModal(setup.plugin); reopened.open(); await settle();
        expect(reopened.titleEl.textContent).toContain("本轮已复习 1"); expect(reopened.contentEl.textContent).toContain("撤销上次评分"); reopened.close();
    });
    it("来源被修改时阻止使用旧题面评分", async () => {
        const setup = fixture(); setup.modal.open(); await settle(); button(setup.modal, "显示答案").click();
        setup.cards[0] = { ...setup.cards[0], card: { ...setup.cards[0].card, meaning: "其他窗口已修改" } };
        button(setup.modal, "简单").click(); await settle(); expect((await setup.store.state("card-test")).revision).toBe(0); setup.modal.close();
    });
});


describe("复习样式", () => {
    it("语境对照先显示原句，揭晓后显示释义和译文", async () => {
        const setup = fixture("context"); setup.modal.open(); await settle();
        expect(setup.modal.modalEl.classList.contains("ll-review-context")).toBe(true);
        expect(setup.modal.titleEl.querySelector(".ll-review-progress")?.textContent).toContain("待复习 1");
        expect(setup.modal.contentEl.textContent).not.toContain("撤销上次评分");
        expect(setup.modal.contentEl.textContent).not.toContain("查看已暂停");
        const original = setup.modal.contentEl.querySelector(".ll-review-original")!;
        expect(original.textContent).toContain("A traveler paused.");
        const sourceLink = original.querySelector<HTMLButtonElement>(".ll-review-source-link")!;
        expect(sourceLink.textContent).toBe("article");
        expect(sourceLink.getAttribute("title")).toBe("article.md");
        sourceLink.click();
        expect(setup.plugin.app.workspace.openLinkText).toHaveBeenCalledWith("article.md", "", true);
        expect(setup.modal.contentEl.textContent).not.toContain("在门槛处");
        expect(setup.modal.contentEl.textContent).not.toContain("旅人停下了。");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); await settle();
        expect((await setup.store.state("card-test")).revision).toBe(0);
        button(setup.modal, "显示答案").click();
        const answer = setup.modal.contentEl.querySelector(".ll-review-answer")!;
        expect(answer.textContent).toContain("在门槛处");
        expect(answer.querySelector(".ll-review-translation")?.textContent).toBe("旅人停下了。");
        expect(answer.querySelector("details")).toBeNull();
        const notes = setup.modal.contentEl.querySelector<HTMLDetailsElement>(".ll-review-supplemental details")!;
        expect(notes.querySelector("summary")?.textContent).toBe("笔记");
        expect(notes.open).toBe(true);
        expect(setup.modal.contentEl.querySelectorAll(".ll-review-sentence")).toHaveLength(1);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); await settle();
        expect((await setup.store.state("card-test")).card.state).toBe(2); setup.modal.close();
    });
    it("专注回忆保留先回想词义、揭晓后显示原句的行为", async () => {
        const setup = fixture("focus"); setup.modal.open(); await settle();
        expect(setup.modal.modalEl.classList.contains("ll-review-context")).toBe(false);
        expect(setup.modal.contentEl.textContent).not.toContain("A traveler paused.");
        button(setup.modal, "显示答案").click();
        expect(setup.modal.contentEl.textContent).toContain("A traveler paused.");
        const details = Array.from(setup.modal.contentEl.querySelectorAll<HTMLDetailsElement>(".ll-review-answer details"));
        expect(details[0].querySelector("summary")?.textContent).toBe("译文");
        expect(details[0].open).toBe(false);
        expect(details.find(item => item.querySelector("summary")?.textContent === "笔记")?.open).toBe(true);
        setup.modal.close();
    });
    it("切换布局后重开窗口，评分和撤销沿用相同进度", async () => {
        const setup = fixture("focus"); setup.modal.open(); await settle();
        button(setup.modal, "显示答案").click(); button(setup.modal, "简单").click(); await settle();
        const state = await setup.store.state("card-test"); setup.modal.close();
        setup.plugin.settings.review.layout = "context";
        const reopened = new ReviewModal(setup.plugin); reopened.open(); await settle();
        expect(reopened.modalEl.classList.contains("ll-review-context")).toBe(true);
        expect(await setup.store.state("card-test")).toEqual(state);
        button(reopened, "撤销上次评分").click(); await settle();
        expect((await setup.store.state("card-test")).card.state).toBe(0);
        expect(reopened.contentEl.querySelector(".ll-review-original")?.textContent).toContain("A traveler paused."); reopened.close();
    });
    it("缺少原句译文时仍可揭晓评分，不显示空译文块", async () => {
        const setup = fixture("context"); setup.cards[0].card.sentence = ""; setup.cards[0].card.translation = "";
        setup.modal.open(); await settle();
        expect(setup.modal.contentEl.textContent).toContain("此卡片暂无原句");
        button(setup.modal, "显示答案").click();
        expect(setup.modal.contentEl.querySelector(".ll-review-translation")).toBeNull();
        button(setup.modal, "简单").click(); await settle();
        expect((await setup.store.state("card-test")).revision).toBe(1); setup.modal.close();
    });
});
