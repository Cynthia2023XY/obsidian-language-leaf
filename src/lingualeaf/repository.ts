import type { FilePort } from "./storage";
import type { LeafCard } from "./domain";
import type { LibraryCatalog, LibraryRecord, LibrarySource } from "./learning-core";

/** 本地实现专用端口，业务调用方无需了解文件布局 */
export interface LibraryRepositoryPort extends FilePort {
    /** 本地目录仅供迁移及数据源管理使用 */
    readonly directory: string;
    /** 跨实例原子执行一次业务事务 */
    exclusive<T>(task: () => Promise<T>): Promise<T>;
    /** 获取单文件原子版本，用于可重建读缓存 */
    version?(relative: string): Promise<string>;
    /** 文件变化通知；远程实现可使用推送 */
    subscribe?(changed: () => void): () => void;
}
/** 学习业务使用的仓储契约，可由本地库或远程服务实现 */
export interface LearningRepository {
    /** 获取资料和共享规则的同一版本 */
    catalog(): Promise<LibraryCatalog>;
    /** 按编辑基线和收录操作身份保存资料 */
    save(card: LeafCard, source?: LibrarySource, operationId?: string, expectedRevision?: number): Promise<LibraryRecord>;
    /** 保留历史的软删除 */
    remove(id: string, expectedRevision?: number): Promise<void>;
    /** 逐字段提交共享规则 */
    configure(patch: Partial<LibraryCatalog["review"]>, expected?: Partial<LibraryCatalog["review"]>): Promise<void>;
}
/** 独立词条投影，同一表达只拥有一个规范身份 */
export interface Expression {
    /** 词条稳定身份 */
    id: string;
    /** 语言和规范化表达 */
    key: string;
    /** 人类可读的表达 */
    text: string;
}
/** 学习资料可生成多个题型，当前卡片作为兼容投影保留 */
export interface LearningMaterial {
    /** 资料自身身份 */
    id: string;
    /** 所属词条 */
    expressionId: string;
    /** 语境资料快照 */
    content: Pick<LeafCard, "meaning" | "sentence" | "translation" | "notes" | "outline">;
    /** 来源只负责跳转 */
    sources: LibrarySource[];
}
