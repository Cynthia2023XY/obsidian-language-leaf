import { Plugin, TFile, Vault } from "obsidian";
import type { LeafSettings, IndexedCard } from "./host";
import type { CaptureOperation } from "./storage";
import { LearningStore } from "./storage";
import { parseCards, upsertCard, validateCard } from "./article";
import { expressionKey, newId } from "./domain";
import { captureCounts } from "./capture-count";
import type { LeafCard } from "./domain";
import type { VaultPort } from "./host";

/** 旧版 Markdown 卡片索引、恢复和写回隔离在兼容适配器内 */
export class LegacyLearningAdapter {
    /** 旧文档索引供兼容界面读取 */
    readonly index = new Map<string, IndexedCard[]>();
    /** 损坏文档阻止自动写回 */
    readonly errors = new Map<string, string>();
    /** 文件版本仅在兼容路径中使用 */
    private stamps = new Map<string, string>();
    /** 旧写回日志仓库 */
    private store: LearningStore;
    /** 兼容写回使用同一 Vault 端口 */
    private port: VaultPort;
    /** 顺序处理旧模式的写操作 */
    private writes: Promise<unknown> = Promise.resolve();
    /** 设置由宿主提供最新值，避免保存后继续读取旧配置 */
    private get settings(): LeafSettings { return this.configuration(); }
    /** 绑定旧宿主能力，不引用独立学习库 */
    constructor(private plugin: Plugin, private articlePort: VaultPort, private configuration: () => LeafSettings) {
        this.port = articlePort; this.store = new LearningStore(articlePort, configuration().dataFolder);
    }
    /** 旧模式按文件版本更新文章索引 */
    async scan(): Promise<IndexedCard[]> {
        // 先删除已不存在来源，文件改名后由新路径重新发现。
        const files = this.plugin.app.vault.getMarkdownFiles();
        for (const path of this.index.keys()) if (!files.some(file => file.path === path)) this.index.delete(path);
        for (const file of files) {
            try {
                // 已索引且文件版本未变时直接复用，损坏文件始终重新检查。
                const stamp = file.stat ? `${file.stat.mtime}:${file.stat.size}` : "";
                if (stamp && this.stamps.get(file.path) === stamp && !this.errors.has(file.path)) continue;
                // 正文仅用作本地索引，未上传任何文章。
                const source = await this.plugin.app.vault.cachedRead(file);
                // 未含标记的普通笔记不做深解析。
                const cards = source.includes("<!-- ll-card:") ? parseCards(source, this.settings.separator) : [];
                this.index.set(file.path, cards.map(located => ({ path: file.path, card: located.card })));
                if (stamp) this.stamps.set(file.path, stamp);
                this.errors.delete(file.path);
            } catch (error) { this.errors.set(file.path, String(error)); }
        }
        // 复制文章导致跨文件卡片 ID 重复时阻止复习和写回。
        const all = Array.from(this.index.values()).flat();
        // 身份冲突需要清晰定位到文件。
        const seen = new Map<string, string>();
        for (const item of all) {
            if (seen.has(item.card.id)) {
                this.errors.set(item.path, "跨文件卡片 ID 重复，请为复制的文章重新生成身份");
                this.errors.set(seen.get(item.card.id)!, "跨文件卡片 ID 重复，请为复制的文章重新生成身份");
            }
            seen.set(item.card.id, item.path);
        }
        // 全局实体独立持久化：即使文章被删除，词条及已收录快照仍保留。
        const orphaned: IndexedCard[] = [];
        for (const path of await this.port.list(`${this.store.root}/expressions/`)) {
            try {
                // 实体文件保存的是可恢复内容，不直接重新生成已删除的 SR 卡。
                const record = JSON.parse((await this.port.read(path)) || "null");
                if (record?.schema !== 1) throw new Error("未知词条实体版本");
                // 相同词条在其他文章仍有来源时不重复显示孤立项。
                const card = validateCard(record.card);
                // 标签属于共享词条，文章语境义仍以各自原文为准。
                for (const item of all.filter(item => item.card.expressionId === card.expressionId)) {
                    item.card.tags = card.tags || [];
                }
                this.errors.delete(path);
                if (!all.some(item => item.card.expressionId === card.expressionId)) orphaned.push({ path: "", card });
            } catch (error) { this.errors.set(path, String(error)); }
        }
        this.index.set("__orphan__", orphaned);
        // 计数从已完成操作恢复，避免编辑、重复点击和中断重放虚增。
        const result = all.filter(item => !this.errors.has(item.path)).concat(orphaned);
        // 每个收录请求只贡献一次，同词的不同来源展示相同累计值。
        const counts = captureCounts(result, await this.store.operations());
        for (const item of result) item.captureCount = counts.get(expressionKey(item.card.language, item.card.text)) || 0;
        return result;
    }
    /** 旧文章变更后失效单个索引 */
    invalidate(path: string): void { this.stamps.delete(path); }
    /** 旧模式先保存恢复日志，再原子修改文末卡片 */
    async save(file: TFile | undefined, card: LeafCard, captureId?: string): Promise<void> {
        if (!file) throw new Error("旧版随文模式需要文章来源");
        // 将本实例所有文章写入按序完成，避免同一单词快速点击竞争。
        const action = this.writes.then(async () => {
            await this.scan();
            if (this.errors.has(file.path)) throw new Error(this.errors.get(file.path));
            // 词条身份按语言和规范化文本匹配，法语重音不会被丢弃。
            const shared = Array.from(this.index.values()).flat().find(item => expressionKey(item.card.language, item.card.text) === expressionKey(card.language, card.text));
            if (shared) card.expressionId = shared.card.expressionId;
            // 在记录恢复意图前确定真正落盘的卡片身份，避免同词合并后重放旧 ID。
            const previous = (this.index.get(file.path) || []).find(item => item.card.id === card.id || expressionKey(item.card.language, item.card.text) === expressionKey(card.language, card.text));
            if (previous) card = { ...card, id: previous.card.id, expressionId: previous.card.expressionId, owner: previous.card.owner };
            // 老卡第一次再次收录时，保留原来至少收录过一次的事实。
            const history = captureId ? await this.store.operations() : [];
            // 操作日志保留基数，删除来源后次数也不会退回。
            const legacyCapture = !!captureId && !!previous && !history.some(item => item.captureId && item.card.id === previous.card.id);
            // 持久化每次确认的意图，用于崩溃后重试；重复请求由计数层去重。
            const operation: CaptureOperation = { id: newId(), ...(captureId ? { captureId, legacyCapture } : {}), path: file.path, card, separator: this.settings.separator, deck: this.settings.deck, done: false };
            await this.store.capture(operation);
            await this.apply(operation, false);
            await this.scan();
        });
        // 当前收录失败仍由调用方感知，队列继续接受后续保存。
        this.writes = action.catch((): void => undefined);
        return action;
    }
    /** 旧操作恢复仅进入此适配器 */
    async apply(operation: CaptureOperation, recovering: boolean): Promise<void> {
        // 恢复文件不可信，写入实体路径前必须验证稳定身份。
        operation.card = validateCard(operation.card);
        // 显式删除优先于旧的未完成收词，防止重启后复活已删卡片。
        if (recovering && await this.port.read(`${this.store.root}/deletions/${operation.card.id}.json`)) {
            await this.store.capture({ ...operation, done: true });
            return;
        }
        // 不根据旧快照整篇覆盖文章，SR 的最新注释来自当前文件。
        const file = this.plugin.app.vault.getAbstractFileByPath(this.articlePort.safe(operation.path));
        if (!(file instanceof TFile) || file.extension !== "md") throw new Error("原文不存在，待写回操作仍保留");
        for (let attempt = 0; attempt < 3; attempt++) {
            // 最新原文是唯一更新基线。
            const source = await this.plugin.app.vault.read(file);
            if (recovering && parseCards(source, operation.separator).some(item => item.card.id === operation.card.id)) {
                await this.store.capture({ ...operation, done: true });
                return;
            }
            // 全局词条快照在原文写入前持久化，原文失败时由操作日志继续恢复。
            await this.port.write(`${this.store.root}/expressions/${operation.card.expressionId}.json`, JSON.stringify({ schema: 1, card: operation.card, sourcePath: file.path }));
            // 只增改目标闪卡。
            const output = upsertCard(source, operation.card, operation.separator, operation.deck);
            // 使用可用宿主原子变换接口；旧版本仅乐观重读，冲突时重试。
            const vault = this.plugin.app.vault as Vault & { process?: (file: TFile, fn: (data: string) => string) => Promise<string> };
            if (vault.process) await vault.process(file, current => upsertCard(current, operation.card, operation.separator, operation.deck));
            else throw new Error("当前宿主缺少原子文件更新能力，请升级 Obsidian 后重试");
            await this.store.capture({ ...operation, done: true });
            return;
        }
        throw new Error("原文正在被其他操作修改，请稍后重试；收词意图已保留");
    }
    /** 兼容旧模式删除，原文修改前保留备份 */
    async removeCard(file: TFile | undefined, cardId: string): Promise<void> {
        if (!file) throw new Error("来源文章已删除");
        // 从当前文件重新定位，不能按旧偏移误删其他卡片。
        const source = await this.plugin.app.vault.read(file);
        // 损坏区域直接拒绝自动删除，保留用户可修复的原文。
        const located = parseCards(source, this.settings.separator).find(item => item.card.id === cardId);
        if (!located) throw new Error("卡片已被删除或移动，请刷新词库");
        await this.port.write(`${this.store.root}/backups/delete-${newId()}.json`, JSON.stringify({ path: file.path, content: source }));
        // 删除标记先持久化，防止中断收词在重启时把这张卡复活。
        await this.port.write(`${this.store.root}/deletions/${cardId}.json`, JSON.stringify({ schema: 1, cardId, path: file.path, deletedAt: Date.now() }));
        await this.replaceExact(file, source, source.slice(0, located.from) + source.slice(located.to));
        this.invalidate(file.path);
        await this.scan();
    }
    /** 旧调度迁移使用比较后原子替换 */
    async replaceExact(file: TFile, expected: string, output: string): Promise<void> {
        // 本版最低宿主提供 Vault.process，禁止降级为可能丢并发数据的全量覆盖。
        const vault = this.plugin.app.vault as Vault & { process: (file: TFile, action: (data: string) => string) => Promise<string> };
        if (!vault.process) throw new Error("请升级 Obsidian 后重试");
        await vault.process(file, current => {
            if (current !== expected) throw new Error("来源文件已改变，已停止写入，请重试");
            return output;
        });
    }
    /** 旧日志恢复失败时保留待处理操作 */
    async recover(): Promise<string[]> {
        // 返回用户可理解的待处理状态，不能误报全部成功。
        const failures: string[] = [];
        for (const operation of await this.store.pending()) {
            try { await this.apply(operation, true); } catch (error) { failures.push(`${operation.path}: ${String(error)}`); }
        }
        return failures;
    }
}
