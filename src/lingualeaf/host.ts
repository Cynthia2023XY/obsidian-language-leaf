import { LegacyLearningAdapter } from "./legacy-adapter";
import { MarkdownView, Notice, Plugin, TFile, normalizePath, parseYaml, Vault } from "obsidian";
import type { FilePort, CaptureOperation } from "./storage";
import { LearningStore } from "./storage";
import { CONTEXT_DEFAULTS, extractContext, fencedBlocks } from "./article";
import { expressionKey, newId } from "./domain";
import type { ReadingSelection } from "./selection-query";
import { LearningLibrary } from "./library";
import type { LibrarySource } from "./library";
import type { LeafCard, ArticleContext } from "./domain";

/** 用户可配置的 LinguaLeaf 学习参数 */
export interface LeafSettings {
    /** 学习模式下普通划选完成后自动查询 */
    autoQuerySelection: boolean;
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
    /** 可选的独立学习库绝对路径，空值保留旧版读取 */
    libraryPath?: string;
    /** 已确认连接的学习库身份 */
    libraryId?: string;
    /** 当前笔记库的稳定来源身份 */
    vaultId?: string;
    /** 短句触发阈值与前后各扩展的句数 */
    shortSentenceThreshold: number;
    contextSentenceCount: number;

}
/** 原生文章学习的默认配置，既有安装保持 SR 格式 */
export const LEAF_DEFAULTS: LeafSettings = { ...CONTEXT_DEFAULTS, language: "en", autoQuerySelection: false, modifier: "shiftKey", deck: "#flashcards", separator: "?", dataFolder: "LinguaLeafData" };
/** 文章索引中的来源与卡片 */
export interface IndexedCard {
    /** 当前来源路径，可随重命名更新 */
    path: string;
    /** 当前卡片内容 */
    card: LeafCard;
    /** 同语言同表达的历史主动收录次数 */
    captureCount?: number;
    /** 独立资料内容版本 */
    revision?: number;
    /** 学习库保存的更新时间 */
    updatedAt?: string;
    /** 来源仅用于展示与跳转 */
    sources?: LibrarySource[];
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
    async create(path: string, content: string): Promise<void> {
        path = this.safe(path);
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
            const folder = parts.slice(0, index).join("/");
            if (!this.plugin.app.vault.getAbstractFileByPath(folder)) await this.plugin.app.vault.createFolder(folder);
        }
        await this.plugin.app.vault.create(path, content);
    }
    /** 枚举普通数据文件，不依赖索引库 */
    async list(prefix: string): Promise<string[]> {
        return this.plugin.app.vault.getFiles().filter(file => file.path.startsWith(prefix)).map(file => file.path);
    }
}
/** 阅读会话与选区来源严格绑定在叶子视图上 */
export interface ReadingSession {
    /** 查询命令可以恢复命令面板打开前的有效选区 */
    selection?: () => ReadingSelection | null;
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
    port: FilePort;
    /** 原笔记访问端口，与学习库文件严格分开 */
    articlePort: VaultPort;
    /** 选择独立数据源后不再扫描或改写文章卡片 */
    library?: LearningLibrary;
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
    /** 旧模式索引和写回只由兼容适配器处理 */
    private legacy: LegacyLearningAdapter;
    /** 初始化最小宿主依赖 */
    constructor(plugin: Plugin, settings: Partial<LeafSettings>) {
        this.plugin = plugin;
        this.settings = { ...LEAF_DEFAULTS, ...settings };
        this.articlePort = new VaultPort(plugin);
        this.library = settings.libraryPath ? new LearningLibrary(settings.libraryPath, settings.libraryId) : undefined;
        this.port = this.library?.port || this.articlePort;
        this.store = new LearningStore(this.port, this.settings.dataFolder);
        this.legacy = new LegacyLearningAdapter(plugin, this.articlePort, () => this.settings);
        this.index = this.legacy.index; this.errors = this.legacy.errors;
    }
    /** 重新建立当前 Vault 中的词句索引，不依赖旧 IndexedDB */
    async scan(): Promise<IndexedCard[]> {
        if (this.library) {
            // 独立目录是唯一权威数据源，保留来源失联的资料。
            const catalog = await this.library.catalog();
            // 同词累计次数包含已删除卡片的历史收录事实。
            const counts = new Map<string, number>();
            for (const record of catalog.records) {
                // 统一语言和规范化表达以维持已有计数规则。
                const key = expressionKey(record.card.language, record.card.text);
                counts.set(key, (counts.get(key) || 0) + record.baseline + record.captures.length);
            }
            return catalog.records.filter(record => !record.deleted).map(record => ({ card: record.card, path: record.sources[0]?.path || "", sources: record.sources, revision: record.revision, updatedAt: record.updatedAt, captureCount: counts.get(expressionKey(record.card.language, record.card.text)) || 0 }));
        }
        return this.legacy.scan();
    }
    /** 文件修改事件使缓存失效，避免同毫秒修改和相同长度内容漏更新 */
    invalidate(path: string): void { this.legacy.invalidate(path); }
    /** 记录出处时使用库身份隔离相同的文章路径 */
    source(path: string): LibrarySource {
        return { vaultId: this.settings.vaultId || this.plugin.app.vault.getName(), vaultName: this.plugin.app.vault.getName(), path };
    }
    /** 查看来源是独立操作，失败不影响学习资料编辑或复习 */
    async openSource(item: IndexedCard): Promise<void> {
        // 跨库不把相同路径误认为当前库的文章。
        const source = item.sources?.[0];
        if (source?.kind && source.kind !== "obsidian") {
            if (!source.uri || !/^(https?:|file:)/i.test(source.uri)) throw new Error("此来源没有可打开的地址");
            window.open(source.uri); return;
        }
        if (!source || source.vaultId === this.settings.vaultId) {
            if (!item.path || !this.plugin.app.vault.getAbstractFileByPath(item.path)) throw new Error("来源文章已移动或删除，学习资料仍保留");
            await this.plugin.app.workspace.openLinkText(item.path, "", false);
        } else window.open(`obsidian://open?vault=${encodeURIComponent(source.vaultName)}&file=${encodeURIComponent(source.path)}`);
    }
    /** 读取大纲约定，仅处理唯一有效的 YAML 大纲块 */
    outline(source: string): string {
        // 解析的是来源 Markdown，不是折叠状态对应的 DOM。
        const blocks = fencedBlocks(source).filter(block => block.info === "ll-outline");
        if (blocks.length > 1) throw new Error("发现多个 ll-outline 大纲，请保留唯一一个");
        if (!blocks.length) return "";
        // 宿主负责 YAML，领域只接收文本快照。
        const outline: unknown = parseYaml(blocks[0].body);
        if (!outline || typeof outline !== "object" || !("schema" in outline) || outline.schema !== 1 || !("items" in outline) || !Array.isArray(outline.items)) throw new Error("ll-outline 大纲格式错误");
        // 逐项校验大纲文本，拒绝损坏或未知结构。
        const items: unknown[] = outline.items;
        return items.map(item => {
            if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string") throw new Error("ll-outline 大纲格式错误");
            return item.text;
        }).join("；");
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
        return extractContext(source, selected, this.outline(source), paragraph, this.settings);
    }
    /** 收录词句，先持久化意图，再改文章，完成后更新索引 */
    async save(file: TFile | undefined, card: LeafCard, captureId?: string, expectedRevision?: number): Promise<void> {
        if (this.library) {
            // 文件只提供收录时出处，保存不检查原文是否仍存在。
            const source = file ? this.source(file.path) : undefined;
            await this.library.save(card, source, captureId, expectedRevision);
            return;
        }
        return this.legacy.save(file, card, captureId);
    }
    /** 用最新文件内容应用操作，恢复时不覆盖已经落盘的卡片 */
    async apply(operation: CaptureOperation, recovering: boolean): Promise<void> {
        return this.legacy.apply(operation, recovering);
    }
    /** 删除本文卡片前备份原文，保留全局词条和历史评分 */
    async removeCard(file: TFile | undefined, cardId: string, expectedRevision?: number): Promise<void> {
        if (this.library) { await this.library.remove(cardId, expectedRevision); return; }
        return this.legacy.removeCard(file, cardId);
    }
    /** 在已预览的原文仍匹配时原子替换，保护 SR 同时写入的新进度 */
    async replaceExact(file: TFile, expected: string, output: string): Promise<void> {
        return this.legacy.replaceExact(file, expected, output);
    }
    /** 启动时恢复未完成操作，单个失败不丢弃其他操作 */
    async recover(): Promise<string[]> {
        if (this.library) { await this.library.catalog(); return []; }
        return this.legacy.recover();
    }
    /** 关闭已失效视图的会话，不把暂停的其他标签当作关闭 */
    prune(): void {
        // 获取仍附着的 Markdown 视图，以便关闭标签后清理监听。
        const views = new Set<MarkdownView>();
        this.plugin.app.workspace.getLeavesOfType("markdown").forEach(leaf => { if (leaf.view instanceof MarkdownView) views.add(leaf.view); });
        for (const [view, session] of this.sessions) {
            if (!views.has(view) || view.file !== session.file || !this.plugin.app.vault.getAbstractFileByPath(session.file.path)) this.stop(view, false);
            else if (view.getMode() !== "preview") {
                this.stop(view, false);
                new Notice("已切换到编辑视图，Language Leaf 学习模式已退出");
            }
        }
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
