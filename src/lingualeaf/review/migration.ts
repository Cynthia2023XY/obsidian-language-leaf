import { TFile } from "obsidian";
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
