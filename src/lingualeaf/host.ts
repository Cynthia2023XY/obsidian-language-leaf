import { MarkdownView, Notice, Plugin, TFile, normalizePath, parseYaml, Vault } from "obsidian";
import type { FilePort, CaptureOperation } from "./storage";
import { LearningStore } from "./storage";
import { extractContext, fencedBlocks, parseCards, upsertCard, validateCard } from "./article";
import { expressionKey, newId } from "./domain";
import { captureCounts } from "./capture-count";
import type { LeafCard, ArticleContext } from "./domain";

/** 用户可配置的 LinguaLeaf 学习参数 */
export interface LeafSettings {
    /** 默认收录语言 */
    language: string;
    /** 用户选择的修饰键 */
    modifier: "shiftKey" | "ctrlKey" | "altKey" | "metaKey";
    /** 与 SR 匹配的卡组标签 */
    deck: string;
    /** 与 SR 匹配的多行分隔符 */
    separator: string;
    /** 持久数据目录 */
    dataFolder: string;

}
/** 原生文章学习的默认配置，复习统一交给 Spaced Repetition */
export const LEAF_DEFAULTS: LeafSettings = { language: "en", modifier: "shiftKey", deck: "#flashcards", separator: "?", dataFolder: "LinguaLeafData" };
/** 文章索引中的来源与卡片 */
export interface IndexedCard {
    /** 当前来源路径，可随重命名更新 */
    path: string;
    /** 当前卡片内容 */
    card: LeafCard;
    /** 同语言同表达的历史主动收录次数 */
    captureCount?: number;
}
/** Vault 文件端口，只访问明确相对路径 */
export class VaultPort implements FilePort {
    /** 当前插件提供宿主生命周期 */
    private plugin: Plugin;
    /** 绑定 Vault */
    constructor(plugin: Plugin) { this.plugin = plugin; }
    /** 校验后返回标准化路径 */
    safe(path: string): string {
        if (!path || path.startsWith("/") || /[\\\x00:]/.test(path) || path.split("/").some(part => part === ".." || part === ".")) throw new Error("拒绝访问非法路径");
        return normalizePath(path);
    }
    /** 读取普通文件，不读取或改写插件设置 */
    async read(path: string): Promise<string | null> {
        // 不存在时返回 null，其他 I/O 错误需要交给上层处理。
        const file = this.plugin.app.vault.getAbstractFileByPath(this.safe(path));
        if (!file) return null;
        if (!(file instanceof TFile)) throw new Error("目标不是普通文件");
        return this.plugin.app.vault.read(file);
    }
    /** 递归建立数据目录，保留已有文件 */
    async write(path: string, content: string): Promise<void> {
        path = this.safe(path);
        // 文件夹逐级建立，避免对空路径或插件目录执行递归操作。
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
            // 每一级均只创建不存在的目录。
            const folder = parts.slice(0, index).join("/");
            if (!this.plugin.app.vault.getAbstractFileByPath(folder)) await this.plugin.app.vault.createFolder(folder);
        }
        // 只针对目标文件写入，不替换整个数据目录。
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.plugin.app.vault.modify(file, content);
        else if (!file) await this.plugin.app.vault.create(path, content);
        else throw new Error("目标路径被文件夹占用");
    }
    /** 枚举普通数据文件，不依赖索引库 */
    async list(prefix: string): Promise<string[]> {
        return this.plugin.app.vault.getFiles().filter(file => file.path.startsWith(prefix)).map(file => file.path);
    }
}
/** 阅读会话与选区来源严格绑定在叶子视图上 */
export interface ReadingSession {
    /** 激活时的视图 */
    view: MarkdownView;
    /** 激活时的文件对象，用于检测切换 */
    file: TFile;
    /** 原显示模式，退出时恢复 */
    mode: string;
    /** 对应文档事件清理器 */
    dispose: () => void;
    /** 让旧异步查询失效的会话标记 */
    token: string;
}
/** 连接文件、收词恢复、词库索引与宿主事件的应用服务 */
export class LeafHost {
    /** 当前学习语言、修饰键和 SR 格式配置 */
    settings: LeafSettings;
    /** 插件实例只在宿主层使用 */
    plugin: Plugin;
    /** 数据文件端口 */
    port: VaultPort;
    /** 可重放的学习仓库 */
    store: LearningStore;
    /** 每个视图独立的学习会话 */
    sessions = new Map<MarkdownView, ReadingSession>();
    /** 会话增删后同步宿主按钮状态 */
    onSessionChange?: () => void;
    /** 上次有效索引，损坏文件不会静默清空 */
    index = new Map<string, IndexedCard[]>();
    /** 阻止损坏来源继续被修改 */
    errors = new Map<string, string>();
    /** 已建立有效索引的文件版本，避免每次划词重读整库 */
    private stamps = new Map<string, string>();
    /** 串行化文章收词与恢复操作 */
    private writes: Promise<unknown> = Promise.resolve();
    /** 初始化最小宿主依赖 */
    constructor(plugin: Plugin, settings: Partial<LeafSettings>) {
        this.plugin = plugin;
        this.settings = { ...LEAF_DEFAULTS, ...settings };
        this.port = new VaultPort(plugin);
        this.store = new LearningStore(this.port, this.settings.dataFolder);
    }
    /** 重新建立当前 Vault 中的词句索引，不依赖旧 IndexedDB */
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
    /** 文件修改事件使缓存失效，避免同毫秒修改和相同长度内容漏更新 */
    invalidate(path: string): void { this.stamps.delete(path); }
    /** 读取大纲约定，仅处理唯一有效的 YAML 大纲块 */
    outline(source: string): string {
        // 解析的是来源 Markdown，不是折叠状态对应的 DOM。
        const blocks = fencedBlocks(source).filter(block => block.info === "ll-outline");
        if (blocks.length > 1) throw new Error("发现多个 ll-outline 大纲，请保留唯一一个");
        if (!blocks.length) return "";
        // 宿主负责 YAML，领域只接收文本快照。
        const outline = parseYaml(blocks[0].body);
        if (outline?.schema !== 1 || !Array.isArray(outline.items) || !outline.items.every((item: any) => typeof item.text === "string")) throw new Error("ll-outline 大纲格式错误");
        return outline.items.map((item: any) => item.text).join("；");
    }
    /** 从当前文件取得学习语言，不依据 UI 语言猜测 */
    language(file: TFile): string {
        // 文档可覆写默认语言，非法值拒绝用于标准化。
        const language = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.["ll-language"] || this.settings.language;
        if (typeof language !== "string" || !/^[a-z]{2,3}(?:-[a-zA-Z0-9]+)*$/.test(language)) throw new Error("文档学习语言标识无效");
        return language;
    }
    /** 查询前捕获来源，以便异步词典响应不会改变所属文章 */
    async context(file: TFile, selected: string, paragraph?: string): Promise<ArticleContext> {
        // 查询不写元数据或修改文章。
        const source = await this.plugin.app.vault.read(file);
        return extractContext(source, selected, this.outline(source), paragraph);
    }
    /** 收录词句，先持久化意图，再改文章，完成后更新索引 */
    async save(file: TFile, card: LeafCard, captureId?: string): Promise<void> {
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
        this.writes = action.catch(() => undefined);
        return action;
    }
    /** 用最新文件内容应用操作，恢复时不覆盖已经落盘的卡片 */
    async apply(operation: CaptureOperation, recovering: boolean): Promise<void> {
        // 恢复文件不可信，写入实体路径前必须验证稳定身份。
        operation.card = validateCard(operation.card);
        // 显式删除优先于旧的未完成收词，防止重启后复活已删卡片。
        if (recovering && await this.port.read(`${this.store.root}/deletions/${operation.card.id}.json`)) {
            await this.store.capture({ ...operation, done: true });
            return;
        }
        // 不根据旧快照整篇覆盖文章，SR 的最新注释来自当前文件。
        const file = this.plugin.app.vault.getAbstractFileByPath(this.port.safe(operation.path));
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
    /** 删除本文卡片前备份原文，保留全局词条和历史评分 */
    async removeCard(file: TFile, cardId: string): Promise<void> {
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
    /** 在已预览的原文仍匹配时原子替换，保护 SR 同时写入的新进度 */
    async replaceExact(file: TFile, expected: string, output: string): Promise<void> {
        // 本版最低宿主提供 Vault.process，禁止降级为可能丢并发数据的全量覆盖。
        const vault = this.plugin.app.vault as Vault & { process: (file: TFile, action: (data: string) => string) => Promise<string> };
        if (!vault.process) throw new Error("请升级 Obsidian 后重试");
        await vault.process(file, current => {
            if (current !== expected) throw new Error("来源文件已改变，已停止写入，请重试");
            return output;
        });
    }
    /** 启动时恢复未完成操作，单个失败不丢弃其他操作 */
    async recover(): Promise<string[]> {
        // 返回用户可理解的待处理状态，不能误报全部成功。
        const failures: string[] = [];
        for (const operation of await this.store.pending()) {
            try { await this.apply(operation, true); } catch (error) { failures.push(`${operation.path}: ${String(error)}`); }
        }
        return failures;
    }
    /** 关闭已失效视图的会话，不把暂停的其他标签当作关闭 */
    prune(): void {
        // 获取仍附着的 Markdown 视图，以便关闭标签后清理监听。
        const views = new Set<MarkdownView>();
        this.plugin.app.workspace.getLeavesOfType("markdown").forEach(leaf => { if (leaf.view instanceof MarkdownView) views.add(leaf.view); });
        for (const [view, session] of this.sessions) if (!views.has(view) || view.file !== session.file || !this.plugin.app.vault.getAbstractFileByPath(session.file.path)) this.stop(view, false);
    }
    /** 结束单个学习会话并清除文档事件 */
    stop(view: MarkdownView, restore = true): void {
        // 先移除会话让异步查询失效，再恢复原来的显示模式。
        const session = this.sessions.get(view);
        if (!session) return;
        this.sessions.delete(view);
        session.dispose();
        view.containerEl.removeClass("lingualeaf-reading");
        this.onSessionChange?.();
        if (restore && view.file === session.file && session.mode !== view.getMode()) void view.setState({ ...view.getState(), mode: session.mode }, { history: false });
    }
    /** 插件卸载时不留下监听器或临时标记 */
    dispose(): void { for (const view of this.sessions.keys()) this.stop(view); }
}
