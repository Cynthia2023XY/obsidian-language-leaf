import type { ReviewRepository } from "./repository";
import { Modal, Notice, TFile } from "obsidian";
import type LinguaLeaf from "../../plugin";
import type { IndexedCard } from "../host";
import { newId } from "../domain";
import { animateReveal } from "./reveal-motion";
import { onPronunciation, stopPronunciation } from "../../utils/helpers";
import { MigrationService } from "./migration";
import { GRADES, interval, reviewKey } from "./engine";
import type { Prepared, ReviewEvent, ReviewState } from "./engine";
import { ReviewService } from "./service";
import { renderNoteMarkdown } from "../note-markdown";

/** The host owns the close button; answer content scrolls independently of grading. */
export class ReviewModal extends Modal {
    /** 换卡、编辑或关闭时清理笔记 Markdown 渲染资源 */
    private disposeNote?: () => void;
    private store: ReviewRepository;
    /** 展示层只消费统一复习服务的队列和操作结果 */
    private service: ReviewService;
    private audioUnsubscribe?: () => void;
    private cancelRevealMotion?: () => void;
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
    /** 宿主只提供会话归属，路径和学习日持久化由服务管理 */
    private sessionKey(): string { return `${this.plugin.lingualeaf.host.library ? this.plugin.settings.learning.vaultId + "-" : ""}${this.source || "all"}`; }
    /** 界面状态变更后保存会话断点 */
    private async checkpoint(): Promise<void> { await this.service.checkpoint(this.sessionKey(), this.session, this.skipped); }
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
        this.service = new ReviewService(plugin.lingualeaf.host.port, plugin.settings.learning.dataFolder, plugin.lingualeaf.host.library);
        this.store = this.service.store;
    }
    onOpen(): void {
        this.modalEl.addClass("ll-review-modal");
        if (this.layout === "context") this.modalEl.addClass("ll-review-context");
        this.titleEl.addClass("ll-review-header");
        this.titleEl.setText(this.layout === "context" ? "语叶 · 语境对照" : "语叶 · 词句复习");
        this.contentEl.createDiv({ text: "正在准备复习卡片…", cls: "ll-review-state ll-review-loading", attr: { role: "status" } });
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
        this.disposeNote?.();
        this.cancelRevealMotion?.();
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
        this.disposeNote?.(); this.disposeNote = undefined;
        this.cancelRevealMotion?.();
        stopPronunciation("review");
        const token = ++this.turn; this.busy = true;
        if (!this.initialized) {
            // 服务只恢复同一学习日的有效会话。
            const saved = await this.service.resume(this.sessionKey());
            if (saved) { this.session = saved.id; this.skipped = new Set(saved.skipped); }
            this.initialized = true;
            await this.checkpoint();
        }
        if (this.plugin.lingualeaf.host.library) {
            // 每轮使用数据源的统一规则，避免不同窗口调度参数分叉。
            const catalog = await this.plugin.lingualeaf.host.library.catalog();
            Object.assign(this.plugin.settings.review, catalog.review);
        }
        if (this.timer) window.clearTimeout(this.timer);
        const blocked = new Set((this.plugin.lingualeaf.host.library ? [] : await new MigrationService(this.plugin.lingualeaf.host).journals()).filter(journal => journal.phase !== "done").map(journal => journal.cardId));
        const cards = (await this.plugin.lingualeaf.host.scan()).filter(item => (this.plugin.lingualeaf.host.library || item.path) && item.card.owner === "builtin" && !blocked.has(item.card.id) && (!this.source || (item.path === this.source && (!this.plugin.lingualeaf.host.library || item.sources?.some(source => source.vaultId === this.plugin.settings.learning.vaultId && source.path === this.source)))));
        // 队列、额度、会话统计由可复用服务统一计算。
        const { rows, now, due, fresh, eligible, selected, availableNew, reviewed, last } = await this.service.queue(cards, this.session, this.skipped, this.plugin.settings.review);
        if (this.closed || token !== this.turn) return;
        this.last = last;
        this.busy = false; this.revealed = false; this.pending = undefined;
        this.contentEl.empty(); this.current = selected?.item; this.prepared = undefined;
        // 进度与宿主标题同行，刷新时只替换进度而不重复追加。
        this.titleEl.querySelector(".ll-review-progress")?.remove();
        this.titleEl.createSpan({ text: `待复习 ${due.length + availableNew} · 本轮已复习 ${reviewed.size}`, cls: "ll-review-progress", attr: { "aria-live": "polite", title: "待复习包含当前卡片和今日额度内的新卡，不含已暂停、跳过或尚未到复习时间的卡片。本轮已复习按已评分的不同卡片计算，撤销后不计入。" } });
        if (!selected) {
            const next = eligible.filter(row => row.state.card.state !== 0).sort((a,b) => Date.parse(a.state.card.due) - Date.parse(b.state.card.due))[0];
            // 等待和完成状态占据正文空间，避免弹窗在复习结束时收缩。
            const state = this.contentEl.createDiv({ cls: "ll-review-state", attr: { role: "status" } });
            state.createEl("h2", { text: next ? "休息一下，等待下次回忆" : "本轮复习完成" });
            const message = state.createEl("p", { text: !cards.length ? "还没有内置复习卡片。收录词句后即可开始，已有 SR 卡片可通过迁移命令导入。" : "可以关闭窗口，进度已保存。" });
            if (next) {
                const tick = (): void => {
                    if (this.closed || token !== this.turn) return;
                    const seconds = Math.ceil((Date.parse(next.state.card.due) - Date.now()) / 1000);
                    if (seconds <= 0) { void this.refresh().catch(error => this.fail(error)); return; }
                    message.textContent = `下一张将在 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后到期。`;
                    this.timer = window.setTimeout(tick, 1000);
                }; tick();
            }
            // 操作集中在底部并允许窄窗口自动换行。
            const actions = this.contentEl.createDiv({ cls: "ll-review-state-actions" });
            this.button(actions, "重新检查", () => { this.skipped.clear(); void this.refresh().catch(error => this.fail(error)); }, "mod-cta");
            // 完成或等待页面保留恢复入口，不打断正常的逐卡复习。
            if (this.last) this.button(actions, "撤销上次评分", () => { void this.undo(); });
            if (rows.some(row => row.state.suspended)) this.button(actions, "查看已暂停", () => this.showSuspended(rows));
            return;
        }
        this.prepared = this.service.preview(selected.item.card.id, selected.state, this.plugin.settings.review.retention);
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
            const sourceName = selected.item.path.split("/").pop()!.replace(/\.md$/i, "") || "未记录出处";
            const sourceLink = this.button(source, sourceName, () => {
                void (this.plugin.lingualeaf.host.library ? this.plugin.lingualeaf.host.openSource(selected.item) : this.app.workspace.openLinkText(selected.item.path, "", true)).catch(error => new Notice(`无法打开出处：${String(error)}`));
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
        this.cancelRevealMotion?.();
        const body = this.contentEl.querySelector<HTMLElement>(".ll-review-body");
        const previousHeight = this.layout === "context" ? body.getBoundingClientRect().height : 0;
        this.prepared = this.service.preview(this.prepared.id, this.prepared.before, this.plugin.settings.review.retention);
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
            if (label === "笔记") this.disposeNote = renderNoteMarkdown(this.app, text, details, this.current.path);
            else details.createEl("p", { text });
        }
        for (const entry of (card.sentences || []).slice(1)) { const detail = extras.createEl("details"); detail.createEl("summary", { text: "补充例句" }); detail.createEl("p", { text: entry.text }); detail.createEl("p", { text: entry.trans }); }
        const footer = this.contentEl.querySelector<HTMLElement>(".ll-review-footer"); footer.empty(); footer.addClass("ll-review-grades");
        for (const grade of GRADES) {
            const button = this.button(footer, "", () => { void this.grade(grade.rating); }, grade.rating === 3 ? "mod-cta" : "");
            button.createSpan({ text: `${grade.arrow} ${grade.label}` });
            button.createEl("small", { text: interval(this.prepared.choices[grade.rating], this.prepared.at) });
            button.setAttribute("aria-keyshortcuts", grade.key);
        }
        if (this.layout === "context") this.cancelRevealMotion = animateReveal(body, previousHeight, [answer, extras]);
    }
    private async grade(rating: number): Promise<void> {
        if (!this.current || !this.prepared || !this.revealed || this.busy || this.pending) return;
        if (Date.now() - this.prepared.at.getTime() > 60000) {
            this.revealed = false;
            this.reveal(); new Notice("停留时间较长，复习间隔已更新，请重新选择评分"); return;
        }
        const prepared = this.prepared;
        this.pending = this.service.grade(prepared, rating, this.session);
        await this.commitPending();
    }
    private async commitPending(): Promise<void> {
        if (!this.pending || this.busy) return;
        this.busy = true;
        this.contentEl.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
        try {
            const cards = await this.plugin.lingualeaf.host.scan();
            const current = cards.find(item => (this.plugin.lingualeaf.host.library || item.path) && item.card.id === this.pending.cardId && item.card.owner === "builtin");
            if (!current || JSON.stringify(current.card) !== JSON.stringify(this.current.card)) throw new Error("来源卡片已更改，请关闭后重新复习");
            await this.service.commit(this.pending); this.last = this.pending; this.pending = undefined;
            try { await this.checkpoint(); } catch { new Notice("评分已保存，会话位置未能保存；可重新打开窗口继续"); }
            if (!this.closed) await this.refresh();
        } catch (error) { this.fail(error); }
    }
    private async undo(): Promise<void> {
        if (!this.last || this.busy || this.pending) return;
        this.busy = true;
        try {
            await this.service.undo(this.last);
            this.last = undefined; this.skipped.clear(); await this.checkpoint(); if (!this.closed) await this.refresh();
        } catch (error) { this.fail(error); }
    }
    private async suspend(id: string, before: ReviewState, suspended: boolean): Promise<void> {
        if (this.pending) return;
        this.busy = true;
        try {
            await this.service.suspend(id, before, suspended, this.session, this.plugin.settings.review.retention);
            if (!this.closed) await this.refresh();
        } catch (error) { this.fail(error); }
    }
    private showSuspended(rows: Array<{ item: IndexedCard; state: ReviewState }>): void {
        if (this.pending) return;
        stopPronunciation("review");
        this.cancelRevealMotion?.();
        this.prepared = undefined; this.current = undefined; this.contentEl.empty();
        this.contentEl.createEl("h3", { text: "已暂停的卡片" });
        for (const row of rows.filter(row => row.state.suspended)) this.button(this.contentEl, `恢复：${row.item.card.text}`, () => { void this.suspend(row.item.card.id, row.state, false); });
        this.button(this.contentEl, "返回复习", () => { void this.refresh().catch(error => this.fail(error)); });
    }
    private edit(): void {
        if (!this.current || this.pending) return;
        this.disposeNote?.(); this.disposeNote = undefined;
        const selected = this.current;
        this.cancelRevealMotion?.();
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
                const file = this.plugin.lingualeaf.host.library ? undefined : this.app.vault.getAbstractFileByPath(selected.path);
                if (!this.plugin.lingualeaf.host.library && !(file instanceof TFile)) throw new Error("来源已删除");
                const current = (await this.plugin.lingualeaf.host.scan()).find(item => item.card.id === selected.card.id && item.path === selected.path);
                if (!current || JSON.stringify(current.card) !== JSON.stringify(selected.card)) throw new Error("卡片已被修改，请重新打开");
                if (!changes.meaning.trim()) throw new Error("释义不能为空");
                changes.meaning = changes.meaning.replace(/\s*\n\s*/g, " ");
                if (changes.noteEntries) changes.noteEntries = changes.notes ? [changes.notes] : [];
                // 主例句同步到学习资料自身的例句列表，避免编辑后仍显示旧内容。
                if (changes.sentences?.length) changes.sentences = [{ ...changes.sentences[0], text: changes.sentence, trans: changes.translation }, ...changes.sentences.slice(1)];
                await this.plugin.lingualeaf.host.save(file as TFile | undefined, changes, undefined, selected.revision); if (!this.closed) await this.refresh();
            } catch (error) { this.fail(error); }
        })(); }, "mod-cta");
        this.button(this.contentEl, "取消", () => { void this.refresh().catch(error => this.fail(error)); });
    }
}
