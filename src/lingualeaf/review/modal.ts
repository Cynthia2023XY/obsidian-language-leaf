import { Modal, Notice, TFile } from "obsidian";
import type LinguaLeaf from "../../plugin";
import type { IndexedCard } from "../host";
import { newId } from "../domain";
import { onPronunciation, stopPronunciation } from "../../utils/helpers";
import { MigrationService } from "./migration";
import { GRADES, interval, prepare, priority, ReviewStore, reviewKey, studyDay } from "./engine";
import type { Prepared, ReviewEvent, ReviewState } from "./engine";

/** The host owns the close button; answer content scrolls independently of grading. */
export class ReviewModal extends Modal {
    private store: ReviewStore;
    private audioUnsubscribe?: () => void;
    private readonly layout: "focus" | "context";
    private session = newId();
    private skipped = new Set<string>();
    private revealed = false;
    private busy = false;
    private closed = false;
    private current?: IndexedCard;
    private prepared?: Prepared;
    private pending?: ReviewEvent;
    private last?: ReviewEvent;
    private timer?: number;
    private turn = 0;
    private initialized = false;
    private sessionPath(): string { return `${this.store.root}/review/sessions/${this.source ? encodeURIComponent(this.source).replace(/%/g, "_") : "all"}.json`; }
    private async checkpoint(): Promise<void> { await this.plugin.lingualeaf.host.port.write(this.sessionPath(), JSON.stringify({ schema: 1, id: this.session, day: studyDay(new Date()), skipped: Array.from(this.skipped), last: this.last })); }
    private key = (event: KeyboardEvent): void => {
        if (this.busy || this.closed || this.pending) return;
        const action = reviewKey(event, this.revealed);
        if (action === undefined) return;
        event.preventDefault(); event.stopPropagation();
        if (action === "reveal") this.reveal(); else void this.grade(action);
    };
    constructor(private plugin: LinguaLeaf, private source?: string) {
        super(plugin.app);
        this.layout = plugin.settings.review.layout === "context" ? "context" : "focus";
        this.store = new ReviewStore(plugin.lingualeaf.host.port, plugin.settings.learning.dataFolder);
    }
    onOpen(): void {
        this.modalEl.addClass("ll-review-modal");
        if (this.layout === "context") this.modalEl.addClass("ll-review-context");
        this.titleEl.setText(this.layout === "context" ? "语叶 · 语境对照" : "语叶 · 词句复习");
        document.addEventListener("keydown", this.key, true);
        this.audioUnsubscribe = onPronunciation(state => {
            if (state.owner !== "review" || this.closed) return;
            const status = this.contentEl.querySelector<HTMLElement>(".ll-pronunciation-status");
            if (!status) return;
            status.empty(); status.setAttribute("title", state.message); status.createSpan({ text: state.message });
            if (state.phase === "error" && this.current) this.button(status, "重试发音", () => this.plugin.playReviewCardWord(this.current.card.text, "manual", this.current.card.language));
        });
        void this.refresh().catch(error => this.fail(error));
    }
    onClose(): void {
        this.closed = true; this.turn++;
        this.audioUnsubscribe?.(); stopPronunciation("review");
        document.removeEventListener("keydown", this.key, true);
        if (this.timer) window.clearTimeout(this.timer);
        this.plugin.reviewModal = undefined;
        this.contentEl.empty();
    }
    private fail(error: unknown): void {
        this.busy = false;
        if (this.closed) return;
        new Notice(`复习未保存：${error instanceof Error ? error.message : String(error)}`);
        this.contentEl.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = !!this.pending);
        if (this.pending) {
            this.contentEl.createEl("p", { text: "本次评分尚未确认保存，请重试；确认前不会进入下一张。", cls: "ll-review-error", attr: { role: "alert" } });
            this.button(this.contentEl, "重试保存", () => { void this.commitPending(); });
        } else this.button(this.contentEl, "重新加载", () => { void this.refresh().catch(error => this.fail(error)); });
    }
    private button(parent: HTMLElement, text: string, run: () => void, cls?: string): HTMLButtonElement {
        const button = parent.createEl("button", { text, cls });
        button.addEventListener("click", () => { button.blur(); if (!this.busy) run(); }); return button;
    }
    private async refresh(): Promise<void> {
        stopPronunciation("review");
        const token = ++this.turn; this.busy = true;
        if (!this.initialized) {
            const raw = await this.plugin.lingualeaf.host.port.read(this.sessionPath());
            if (raw) {
                const saved = JSON.parse(raw);
                if (saved.schema === 1 && saved.day === studyDay(new Date()) && typeof saved.id === "string") {
                    this.session = saved.id; this.skipped = new Set(Array.isArray(saved.skipped) ? saved.skipped.filter((id: unknown) => typeof id === "string") : []);
                }
            }
            this.initialized = true;
            await this.checkpoint();
        }
        if (this.timer) window.clearTimeout(this.timer);
        const blocked = new Set((await new MigrationService(this.plugin.lingualeaf.host).journals()).filter(journal => journal.phase !== "done").map(journal => journal.cardId));
        const cards = (await this.plugin.lingualeaf.host.scan()).filter(item => item.path && item.card.owner === "builtin" && !blocked.has(item.card.id) && (!this.source || item.path === this.source));
        const rows = await Promise.all(cards.map(async item => ({ item, state: await this.store.state(item.card.id), events: await this.store.events(item.card.id) })));
        if (this.closed || token !== this.turn) return;
        const now = new Date(); const day = studyDay(now);
        const active = rows.flatMap(row => {
            const undone = new Set(row.events.filter(event => event.kind === "undo").map(event => event.undoes));
            return row.events.filter(event => event.kind === "grade" && !undone.has(event.id));
        });
        // Quota is vault-wide, including cards outside the current article.
        const allPaths = await this.plugin.lingualeaf.host.port.list(`${this.store.root}/review/events/`);
        const newToday = new Set<string>();
        const allEvents: ReviewEvent[] = [];
        for (const path of allPaths.filter(path => path.endsWith(".json"))) {
            const raw = await this.plugin.lingualeaf.host.port.read(path); if (raw) allEvents.push(JSON.parse(raw));
        }
        const sessionGrades = allEvents.filter(event => event.kind === "grade" && event.session === this.session);
        const lastGrade = sessionGrades.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
        if (lastGrade && !allEvents.some(event => event.cardId === lastGrade.cardId && event.after.revision > lastGrade.after.revision)) this.last = lastGrade;
        else this.last = undefined;
        const undone = new Set(allEvents.filter(event => event.kind === "undo").map(event => event.undoes));
        for (const event of allEvents) if (event.kind === "grade" && !undone.has(event.id) && event.before.card.state === 0 && studyDay(new Date(event.at)) === day) newToday.add(event.cardId);
        if (this.closed || token !== this.turn) return;
        const eligible = rows.filter(row => !row.state.suspended && !this.skipped.has(row.item.card.id));
        const due = eligible.filter(row => row.state.card.state !== 0 && Date.parse(row.state.card.due) <= now.getTime()).sort((a, b) => priority(a.state) - priority(b.state) || Date.parse(a.state.card.due) - Date.parse(b.state.card.due));
        const fresh = eligible.filter(row => row.state.card.state === 0);
        const selected = due[0] || (newToday.size < this.plugin.settings.review.newLimit ? fresh[0] : undefined);
        this.busy = false; this.revealed = false; this.pending = undefined;
        this.contentEl.empty(); this.current = selected?.item; this.prepared = undefined;
        const completed = new Set(active.filter(event => event.session === this.session && event.after.card.state === 2).map(event => event.cardId));
        const learning = rows.filter(row => [1, 3].includes(row.state.card.state) && !row.state.suspended).length;
        this.contentEl.createDiv({ text: `已完成 ${completed.size} · 学习中 ${learning} · 待复习 ${due.length} · 今日新词 ${newToday.size}/${this.plugin.settings.review.newLimit}`, cls: "ll-review-progress" });
        const tools = this.contentEl.createDiv({ cls: "ll-review-tools" });
        if (this.last) this.button(tools, "撤销上次评分", () => { void this.undo(); });
        this.button(tools, "查看已暂停", () => this.showSuspended(rows));
        if (!selected) {
            const next = eligible.filter(row => row.state.card.state !== 0).sort((a,b) => Date.parse(a.state.card.due) - Date.parse(b.state.card.due))[0];
            this.contentEl.createEl("h2", { text: next ? "休息一下，等待下次回忆" : "本轮复习完成" });
            const message = this.contentEl.createEl("p", { text: !cards.length ? "还没有内置复习卡片。可在设置中选择内置复习，或通过迁移命令导入已有卡片。" : "可以关闭窗口，进度已保存。" });
            if (next) {
                const tick = (): void => {
                    if (this.closed || token !== this.turn) return;
                    const seconds = Math.ceil((Date.parse(next.state.card.due) - Date.now()) / 1000);
                    if (seconds <= 0) { void this.refresh().catch(error => this.fail(error)); return; }
                    message.textContent = `下一张将在 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后到期。`;
                    this.timer = window.setTimeout(tick, 1000);
                }; tick();
            }
            this.button(this.contentEl, "重新检查", () => { this.skipped.clear(); void this.refresh().catch(error => this.fail(error)); });
            return;
        }
        this.prepared = prepare(selected.item.card.id, selected.state, now, this.plugin.settings.review.retention);
        const body = this.contentEl.createDiv({ cls: "ll-review-body" });
        body.createDiv({ text: selected.item.card.kind === "phrase" ? "短语 · 回想它在原文中的含义" : "单词 · 回想它在原文中的含义", cls: "ll-review-eyebrow" });
        const title = body.createEl("h2", { text: selected.item.card.text, cls: "ll-review-expression" });
        title.addEventListener("click", () => this.plugin.playReviewCardWord(selected.item.card.text, "manual", selected.item.card.language));
        const audioRow = body.createDiv({ cls: "ll-review-audio" });
        this.button(audioRow, "播放发音", () => this.plugin.playReviewCardWord(selected.item.card.text, "manual", selected.item.card.language));
        audioRow.createDiv({ cls: "ll-pronunciation-status", attr: { role: "status" } });
        if (this.layout === "context") {
            const columns = body.createDiv({ cls: "ll-review-columns" });
            const original = columns.createEl("section", { cls: "ll-review-original", attr: { "aria-label": "原句" } });
            original.createDiv({ text: "在这段话中，它是什么意思？", cls: "ll-review-eyebrow" });
            original.createEl("p", { text: selected.item.card.sentence || "此卡片暂无原句，可先回想词句含义。", cls: "ll-review-sentence" });
            const source = original.createDiv({ cls: "ll-review-source" });
            source.createSpan({ text: "出处", cls: "ll-review-eyebrow" });
            const sourceName = selected.item.path.split("/").pop()!.replace(/\.md$/i, "");
            const sourceLink = this.button(source, sourceName, () => {
                void this.app.workspace.openLinkText(selected.item.path, "", true).catch(error => new Notice(`无法打开出处：${String(error)}`));
            }, "ll-review-source-link");
            sourceLink.setAttribute("title", selected.item.path);
            sourceLink.setAttribute("aria-label", `打开来源文章：${sourceName}`);
            const answer = columns.createEl("section", { cls: "ll-review-answer", attr: { "aria-label": "释义与译文", "aria-live": "polite" } });
            answer.createEl("p", { text: "先想一想，再揭晓答案。", cls: "ll-review-recall" });
        } else body.createDiv({ cls: "ll-review-answer" });
        const footer = this.contentEl.createDiv({ cls: "ll-review-footer" });
        this.button(footer, "显示答案 · 空格", () => this.reveal(), "mod-cta ll-review-reveal");
        const actions = this.contentEl.createDiv({ cls: "ll-review-tools" });
        this.button(actions, "本轮跳过", () => { this.skipped.add(selected.item.card.id); void this.checkpoint().then(() => this.refresh()).catch(error => this.fail(error)); });
        this.button(actions, "暂停此卡", () => { void this.suspend(selected.item.card.id, selected.state, true); });
        this.button(actions, "编辑", () => this.edit());
        this.button(actions, "打开出处", () => { void this.app.workspace.openLinkText(selected.item.path, "", true); });
        if (this.plugin.settings.review_auto_pron) this.plugin.playReviewCardWord(selected.item.card.text, "auto", selected.item.card.language);
    }
    private reveal(): void {
        if (!this.current || !this.prepared || this.revealed || this.busy) return;
        this.prepared = prepare(this.prepared.id, this.prepared.before, new Date(), this.plugin.settings.review.retention);
        this.revealed = true;
        const card = this.current.card;
        const answer = this.contentEl.querySelector<HTMLElement>(".ll-review-answer");
        answer.empty();
        if (this.layout === "context") answer.createDiv({ text: "语境释义", cls: "ll-review-eyebrow" });
        answer.createEl("p", { text: card.meaning, cls: "ll-review-meaning" });
        if (this.layout !== "context" && card.sentence) { answer.createDiv({ text: "原句", cls: "ll-review-eyebrow" }); answer.createEl("p", { text: card.sentence, cls: "ll-review-sentence" }); }
        if (this.layout === "context" && card.translation) {
            answer.createDiv({ text: "译文", cls: "ll-review-eyebrow" });
            answer.createEl("p", { text: card.translation, cls: "ll-review-translation" });
        }
        const supplemental = this.layout === "context" ? this.contentEl.querySelector<HTMLElement>(".ll-review-body") : answer;
        supplemental.querySelector(".ll-review-supplemental")?.remove();
        const extras = supplemental.createDiv({ cls: "ll-review-supplemental" });
        for (const [label, text] of [["译文", this.layout === "context" ? "" : card.translation], ["笔记", card.notes], ["概览", card.outline]]) if (text) {
            const details = extras.createEl("details");
            details.open = label === "笔记";
            details.createEl("summary", { text: label });
            details.createEl("p", { text });
        }
        for (const entry of (card.sentences || []).slice(1)) { const detail = extras.createEl("details"); detail.createEl("summary", { text: "补充例句" }); detail.createEl("p", { text: entry.text }); detail.createEl("p", { text: entry.trans }); }
        const footer = this.contentEl.querySelector<HTMLElement>(".ll-review-footer"); footer.empty(); footer.addClass("ll-review-grades");
        for (const grade of GRADES) {
            const button = this.button(footer, "", () => { void this.grade(grade.rating); }, grade.rating === 3 ? "mod-cta" : "");
            button.createSpan({ text: `${grade.arrow} ${grade.label}` });
            button.createEl("small", { text: interval(this.prepared.choices[grade.rating], this.prepared.at) });
            button.setAttribute("aria-keyshortcuts", grade.key);
        }
    }
    private async grade(rating: number): Promise<void> {
        if (!this.current || !this.prepared || !this.revealed || this.busy || this.pending) return;
        if (Date.now() - this.prepared.at.getTime() > 60000) {
            this.revealed = false;
            this.contentEl.querySelector<HTMLElement>(".ll-review-answer").empty();
            this.reveal(); new Notice("停留时间较长，复习间隔已更新，请重新选择评分"); return;
        }
        const prepared = this.prepared;
        this.pending = { schema: 1, id: newId(), cardId: prepared.id, at: new Date().toISOString(), scheduledAt: prepared.at.toISOString(), session: this.session, kind: "grade", before: prepared.before, after: { ...prepared.before, revision: prepared.before.revision + 1, card: prepared.choices[rating] }, rating, library: "ts-fsrs@5.4.1", retention: prepared.retention };
        await this.commitPending();
    }
    private async commitPending(): Promise<void> {
        if (!this.pending || this.busy) return;
        this.busy = true;
        this.contentEl.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
        try {
            const cards = await this.plugin.lingualeaf.host.scan();
            const current = cards.find(item => item.path && item.card.id === this.pending.cardId && item.card.owner === "builtin");
            if (!current || JSON.stringify(current.card) !== JSON.stringify(this.current.card)) throw new Error("来源卡片已更改，请关闭后重新复习");
            await this.store.append(this.pending); this.last = this.pending; this.pending = undefined;
            try { await this.checkpoint(); } catch { new Notice("评分已保存，会话位置未能保存；可重新打开窗口继续"); }
            if (!this.closed) await this.refresh();
        } catch (error) { this.fail(error); }
    }
    private async undo(): Promise<void> {
        if (!this.last || this.busy || this.pending) return;
        this.busy = true;
        try {
            const state = await this.store.state(this.last.cardId);
            if (state.revision !== this.last.after.revision) throw new Error("此卡已有后续操作，无法撤销");
            await this.store.append({ ...this.last, id: newId(), at: new Date().toISOString(), kind: "undo", before: state, after: { ...this.last.before, revision: state.revision + 1 }, undoes: this.last.id, rating: undefined });
            this.last = undefined; this.skipped.clear(); await this.checkpoint(); if (!this.closed) await this.refresh();
        } catch (error) { this.fail(error); }
    }
    private async suspend(id: string, before: ReviewState, suspended: boolean): Promise<void> {
        if (this.pending) return;
        this.busy = true;
        try {
            await this.store.append({ schema: 1, id: newId(), cardId: id, at: new Date().toISOString(), session: this.session, kind: "suspend", before, after: { ...before, revision: before.revision + 1, suspended }, library: "ts-fsrs@5.4.1", retention: this.plugin.settings.review.retention });
            if (!this.closed) await this.refresh();
        } catch (error) { this.fail(error); }
    }
    private showSuspended(rows: Array<{ item: IndexedCard; state: ReviewState }>): void {
        if (this.pending) return;
        stopPronunciation("review");
        this.prepared = undefined; this.current = undefined; this.contentEl.empty();
        this.contentEl.createEl("h3", { text: "已暂停的卡片" });
        for (const row of rows.filter(row => row.state.suspended)) this.button(this.contentEl, `恢复：${row.item.card.text}`, () => { void this.suspend(row.item.card.id, row.state, false); });
        this.button(this.contentEl, "返回复习", () => { void this.refresh().catch(error => this.fail(error)); });
    }
    private edit(): void {
        if (!this.current || this.pending) return;
        const selected = this.current;
        stopPronunciation("review");
        this.prepared = undefined; this.revealed = false; this.contentEl.empty();
        this.contentEl.createEl("h3", { text: `编辑 · ${selected.card.text}` });
        const inputs = [ ["释义", "meaning"], ["原句", "sentence"], ["译文", "translation"], ["笔记", "notes"] ] as const;
        const changes = { ...selected.card };
        for (const [label, key] of inputs) {
            this.contentEl.createEl("label", { text: label });
            const input = this.contentEl.createEl("textarea"); input.value = changes[key];
            input.addEventListener("input", () => { changes[key] = input.value; });
        }
        this.button(this.contentEl, "保存并返回", () => { void (async () => {
            this.busy = true;
            try {
                const file = this.app.vault.getAbstractFileByPath(selected.path);
                if (!(file instanceof TFile)) throw new Error("来源已删除");
                const current = (await this.plugin.lingualeaf.host.scan()).find(item => item.card.id === selected.card.id && item.path === selected.path);
                if (!current || JSON.stringify(current.card) !== JSON.stringify(selected.card)) throw new Error("卡片已被修改，请重新打开");
                if (!changes.meaning.trim()) throw new Error("释义不能为空");
                changes.meaning = changes.meaning.replace(/\s*\n\s*/g, " ");
                if (changes.noteEntries) changes.noteEntries = changes.notes ? [changes.notes] : [];
                await this.plugin.lingualeaf.host.save(file, changes); if (!this.closed) await this.refresh();
            } catch (error) { this.fail(error); }
        })(); }, "mod-cta");
        this.button(this.contentEl, "取消", () => { void this.refresh().catch(error => this.fail(error)); });
    }
}
