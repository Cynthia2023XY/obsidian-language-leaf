import { Modal, Notice, TFile } from "obsidian";
import type LinguaLeaf from "../../plugin";
import type { LeafHost, IndexedCard } from "../host";
import type { LeafCard } from "../domain";
import { newId } from "../domain";
import { parseCards, renderCard, validateCard } from "../article";
import { ReviewStore } from "./engine";
import { importSchedule } from "./import-schedule";
import type { ReviewState } from "./engine";

export interface Migration { schema: 1; id: string; path: string; cardId: string; before: string; after: string; backup: string; phase: "prepared" | "done" | "rolled-back"; initial: ReviewState }
export class MigrationService {
    constructor(private host: LeafHost) {}
    private journalPath(id: string): string { return `${this.host.settings.dataFolder}/review/migrations/${id}.json`; }
    async journals(): Promise<Migration[]> {
        const paths = await this.host.port.list(`${this.host.settings.dataFolder}/review/migrations/`);
        return Promise.all(paths.filter(path => path.endsWith(".json")).map(async path => {
            const journal = JSON.parse((await this.host.port.read(path)) || "null") as Migration;
            if (!journal || journal.schema !== 1 || !/^[a-zA-Z0-9-]+$/.test(journal.id) || !["prepared", "done", "rolled-back"].includes(journal.phase)) throw new Error("迁移记录损坏");
            return journal;
        }));
    }
    async migrate(item: IndexedCard, reset: boolean): Promise<void> {
        const source = await this.host.port.read(item.path);
        if (source === null) throw new Error("来源已删除");
        const located = parseCards(source, this.host.settings.separator).find(value => value.card.id === item.card.id);
        if (!located || located.card.owner !== "spaced-repetition" || JSON.stringify(located.card) !== JSON.stringify(validateCard(item.card))) throw new Error("卡片已变化，请重新预览");
        const old = (await this.journals()).find(journal => journal.cardId === item.card.id && journal.phase !== "rolled-back");
        if (old) throw new Error("此卡已有迁移记录，请先恢复或回退");
        if ((await new ReviewStore(this.host.port, this.host.settings.dataFolder).state(item.card.id)).revision > 0) throw new Error("此卡保留有内置复习历史，不能重复迁移；请先核对备份");
        const imported = importSchedule(located.schedule, reset);
        const card: LeafCard = { ...located.card, owner: "builtin" };
        const newline = source.includes("\r\n") ? "\r\n" : "\n";
        const journal: Migration = { schema: 1, id: newId(), path: item.path, cardId: card.id, before: source.slice(located.from, located.to), after: renderCard(card, this.host.settings.separator).replace(/\n/g, newline), backup: source, phase: "prepared", initial: imported.state };
        await this.host.port.create(this.journalPath(journal.id), JSON.stringify(journal, null, 2));
        await this.resume(journal);
    }
    async resume(journal: Migration): Promise<void> {
        if (journal.phase !== "prepared") return;
        const file = this.host.plugin.app.vault.getAbstractFileByPath(journal.path);
        if (!(file instanceof TFile)) throw new Error("迁移来源不存在");
        const source = await this.host.port.read(journal.path);
        const located = parseCards(source, this.host.settings.separator).find(value => value.card.id === journal.cardId);
        if (!located) throw new Error("找不到迁移卡片");
        const block = source.slice(located.from, located.to);
        if (block !== journal.before && block !== journal.after) throw new Error("迁移卡片已手工修改，已停止恢复，备份仍保留");
        if (block === journal.before) await this.host.replaceExact(file, source, source.slice(0, located.from) + journal.after + source.slice(located.to));
        const store = new ReviewStore(this.host.port, this.host.settings.dataFolder);
        const state = await store.state(journal.cardId);
        if (state.revision === 0) {
            // A revision-one import record makes recovery idempotent without a second mutable state file.
            await store.append({ schema: 1, id: journal.id, cardId: journal.cardId, at: new Date().toISOString(), session: "migration", kind: "import", before: state, after: { ...journal.initial, revision: 1 }, library: "ts-fsrs@5.4.1", retention: .9 });
        } else if ((await store.events(journal.cardId))[0]?.id !== journal.id) throw new Error("已有其他复习进度，停止迁移");
        journal.phase = "done";
        await this.host.port.write(this.journalPath(journal.id), JSON.stringify(journal, null, 2));
        await this.host.scan();
    }
    async rollback(journal: Migration): Promise<void> {
        const store = new ReviewStore(this.host.port, this.host.settings.dataFolder);
        const events = await store.events(journal.cardId);
        if (events.some(event => event.kind !== "import")) throw new Error("此卡已开始内置复习，不能恢复旧 SR 进度");
        const source = await this.host.port.read(journal.path);
        const file = this.host.plugin.app.vault.getAbstractFileByPath(journal.path);
        if (source === null || !(file instanceof TFile)) throw new Error("来源不存在");
        const located = parseCards(source, this.host.settings.separator).find(value => value.card.id === journal.cardId);
        if (!located) throw new Error("卡片不存在");
        const block = source.slice(located.from, located.to);
        if (block !== journal.after && block !== journal.before) throw new Error("卡片已修改，不能覆盖；请使用备份手工核对");
        if (block === journal.after) await this.host.replaceExact(file, source, source.slice(0, located.from) + journal.before + source.slice(located.to));
        journal.phase = "rolled-back";
        await this.host.port.write(this.journalPath(journal.id), JSON.stringify(journal, null, 2));
        await this.host.scan();
    }
}
export class MigrationModal extends Modal {
    private service: MigrationService;
    private selected = new Set<string>();
    private acknowledged = false;
    private reset = false;
    private busy = false;
    constructor(private plugin: LinguaLeaf) { super(plugin.app); this.service = new MigrationService(plugin.lingualeaf.host); }
    onOpen(): void { this.modalEl.addClass("ll-review-modal"); this.titleEl.setText("迁移到内置复习 · 预览"); void this.render().catch(error => new Notice(String(error))); }
    private async render(): Promise<void> {
        const cards = (await this.plugin.lingualeaf.host.scan()).filter(item => item.path && item.card.owner === "spaced-repetition");
        this.contentEl.empty();
        this.contentEl.createEl("p", { text: "只处理勾选的卡片。先保存原文备份，再移除 SR 问答分隔符与调度注释，由内置 FSRS 接管。旧算法进度只能近似转换；不支持的格式可选择重新开始。" });
        const reset = this.contentEl.createEl("label");
        const resetInput = reset.createEl("input", { type: "checkbox" }); resetInput.checked = this.reset;
        reset.appendText(" 重新开始，不推算旧进度");
        resetInput.onchange = () => { this.reset = resetInput.checked; void this.render().catch(error => new Notice(String(error))); };
        for (const item of cards) {
            const source = await this.plugin.lingualeaf.host.port.read(item.path);
            const located = parseCards(source, this.plugin.settings.learning.separator).find(value => value.card.id === item.card.id);
            let description: string; let valid = true;
            try { description = importSchedule(located.schedule, this.reset).description; } catch (error) { description = String(error); valid = false; this.selected.delete(item.card.id); }
            const row = this.contentEl.createEl("label", { cls: "ll-migration-row" });
            const checkbox = row.createEl("input", { type: "checkbox" }); checkbox.checked = this.selected.has(item.card.id); checkbox.disabled = !valid;
            checkbox.onchange = () => { if (checkbox.checked) this.selected.add(item.card.id); else this.selected.delete(item.card.id); };
            row.createSpan({ text: `${item.card.text} · ${item.path}\n${description}` });
        }
        const ack = this.contentEl.createEl("label"); const check = ack.createEl("input", { type: "checkbox" }); check.checked = this.acknowledged;
        ack.appendText(" 我已关闭 Spaced Repetition 复习窗口，确认迁移勾选卡片"); check.onchange = () => { this.acknowledged = check.checked; };
        const action = this.contentEl.createEl("button", { text: "迁移勾选卡片", cls: "mod-cta" });
        action.onclick = () => { void (async () => {
            if (this.busy) return;
            if (!this.acknowledged || !this.selected.size) { new Notice("请先勾选卡片并确认已关闭 SR 复习窗口"); return; }
            if (Array.from(document.querySelectorAll<HTMLElement>(".sr-modal-content,.sr-card-container")).some(element => element.offsetParent !== null)) { new Notice("请先关闭 SR 复习窗口"); return; }
            this.busy = true; action.disabled = true;
            try { for (const item of cards.filter(item => this.selected.has(item.card.id))) await this.service.migrate(item, this.reset); this.selected.clear(); new Notice("迁移完成，使用“开始词句复习”命令复习"); await this.render(); }
            catch (error) { new Notice(String(error)); await this.render(); }
            finally { this.busy = false; }
        })(); };
        const journals = await this.service.journals();
        if (journals.length) this.contentEl.createEl("h3", { text: "迁移记录与恢复" });
        for (const journal of journals.filter(item => item.phase !== "rolled-back")) {
            const row = this.contentEl.createDiv({ cls: "ll-migration-row" }); row.createSpan({ text: `${journal.path} · ${journal.cardId} · ${journal.phase === "prepared" ? "待恢复" : "已完成"}` });
            for (const [label, task] of [["恢复迁移", () => this.service.resume(journal)], ["回退（尚未复习时）", () => this.service.rollback(journal)]] as const) {
                if (label === "恢复迁移" && journal.phase !== "prepared") continue;
                const button = row.createEl("button", { text: label }); button.onclick = () => { if (this.busy) return; this.busy = true; void task().then(() => this.render()).catch(error => new Notice(String(error))).finally(() => { this.busy = false; }); };
            }
        }
    }
}
