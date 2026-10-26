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
function fixture() {
    const files = new Map<string, string>();
    let fail = false;
    const port = {
        read: async (path: string) => files.get(path) ?? null,
        write: async (path: string, text: string) => { files.set(path, text); },
        list: async (prefix: string) => Array.from(files.keys()).filter(path => path.startsWith(prefix)),
        create: async (path: string, text: string) => { if (fail) throw new Error("disk full"); if (files.has(path)) throw new Error("exists"); files.set(path, text); },
    };
    const cards = [{ path: "article.md", card: { id: "card-test", expressionId: "expression-test", owner: "builtin", text: "on the threshold", meaning: "在门槛处", sentence: "A traveler paused.", translation: "旅人停下了。", notes: "笔记", outline: "", kind: "phrase", language: "en", anchor: "" } }];
    const plugin: any = { app: {}, settings: { learning: { dataFolder: "Data" }, review: { newLimit: 10, retention: .9 }, review_auto_pron: false }, lingualeaf: { host: { port, settings: { dataFolder: "Data" }, scan: async () => cards } }, playReviewCardWord: vi.fn() };
    const modal = new ReviewModal(plugin); plugin.reviewModal = modal;
    return { modal, plugin, files, cards, store: new ReviewStore(port, "Data"), fail: (value: boolean) => { fail = value; } };
}
async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 25)); }
function button(modal: ReviewModal, text: string): HTMLButtonElement { return Array.from(modal.contentEl.querySelectorAll("button")).find(element => element.textContent?.includes(text))!; }
describe("真实复习弹窗 DOM 行为", () => {
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
        expect(reopened.contentEl.textContent).toContain("今日新词 1/10"); expect(reopened.contentEl.textContent).toContain("撤销上次评分"); reopened.close();
    });
    it("来源被修改时阻止使用旧题面评分", async () => {
        const setup = fixture(); setup.modal.open(); await settle(); button(setup.modal, "显示答案").click();
        setup.cards[0] = { ...setup.cards[0], card: { ...setup.cards[0].card, meaning: "其他窗口已修改" } };
        button(setup.modal, "简单").click(); await settle(); expect((await setup.store.state("card-test")).revision).toBe(0); setup.modal.close();
    });
});
