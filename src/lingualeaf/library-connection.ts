import * as path from "path";
import * as fs from "fs";
import * as files from "fs/promises";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
import type { LeafSettings } from "./host";
import type { LibraryRepositoryPort } from "./repository";

/** 主词库随笔记库移动，外部收录入口只保存本机连接 */
export type LibraryMode = "vault" | "external";
/** 每台设备独立保存外部库地址，不随 Obsidian 设置同步 */
export class LibraryBindings {
    /** 默认使用用户本机配置目录，测试可指定隔离位置 */
    constructor(private directory = path.join(homedir(), ".config", "language-leaf", "connections")) {}
    /** 来源库和学习库共同决定绑定，避免不同来源互相覆盖 */
    private filename(vaultId: string, libraryId: string): string {
        if (!vaultId || !libraryId) throw new Error("外部学习库连接缺少身份，请重新连接");
        return path.join(this.directory, createHash("sha256").update(`${vaultId}:${libraryId}`).digest("hex") + ".json");
    }
    /** 同步设置到另一台设备时，未绑定路径必须由用户明确指定 */
    read(vaultId: string, libraryId: string): string | undefined {
        try {
            // 绑定文件只包含地址和学习库身份，不包含学习内容或凭据。
            const value = JSON.parse(fs.readFileSync(this.filename(vaultId, libraryId), "utf8"));
            if (value.schema !== 1 || value.libraryId !== libraryId || typeof value.directory !== "string" || !path.isAbsolute(value.directory)) throw new Error("本机学习库连接损坏，请重新连接");
            return value.directory;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }
    /** 原子保存单个绑定，不同笔记库或不同进程不会覆盖整份配置 */
    async save(vaultId: string, libraryId: string, directory: string): Promise<void> {
        if (!path.isAbsolute(directory)) throw new Error("外部学习库必须选择本机绝对路径");
        // 每个绑定拥有独立文件，临时文件也位于本机配置区。
        const target = this.filename(vaultId, libraryId);
        // 随机身份避免并发编辑连接时共用临时文件。
        const temporary = `${target}.${randomUUID()}.tmp`;
        await files.mkdir(this.directory, { recursive: true });
        try { await files.writeFile(temporary, JSON.stringify({ schema: 1, libraryId, directory: path.resolve(directory) }), { mode: 0o600, flag: "wx" }); await files.rename(temporary, target); }
        finally { await files.unlink(temporary).catch((): void => undefined); }
    }
}
/** 主词库路径限定在当前笔记库内，换设备后由当地根目录解析 */
export function vaultLibraryDirectory(base: string, relative: string): string {
    if (!base || !path.isAbsolute(base)) throw new Error("当前宿主无法提供本机笔记库路径");
    if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0") || relative.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) throw new Error("主词库请输入笔记库内的普通相对目录，例如 LanguageLeafLibrary");
    return path.join(base, relative);
}
/** 兼容旧绝对地址，新外部连接优先读取设备本地绑定 */
export function resolveLibraryDirectory(settings: Partial<LeafSettings>, base: string, bindings = new LibraryBindings()): string | undefined {
    if (settings.libraryMode === "vault") return vaultLibraryDirectory(base, settings.libraryPath || "LanguageLeafLibrary");
    if (settings.libraryMode === "external") {
        // 新格式设置只同步库身份，绝对路径属于当前设备。
        const bound = bindings.read(settings.vaultId!, settings.libraryId!);
        if (!bound) throw new Error("此设备尚未连接主词库，请先同步主笔记库，再在学习库管理中选择本机主词库目录");
        return bound;
    }
    // 历史安装保持可读，用户重新连接后才转成新连接格式。
    return settings.libraryPath || undefined;
}
/** 未连接时保留设置入口，所有学习操作明确失败且绝不退回旧随文写回 */
export class UnavailableLibraryFiles implements LibraryRepositoryPort {
    /** 未绑定的端口没有任何可操作的磁盘目录 */
    readonly directory = "";
    /** 保存连接故障供每个操作一致报告 */
    constructor(private message: string) {}
    /** 未连接时禁止读写或创建任何学习资料 */
    private fail(): never { throw new Error(this.message); }
    /** 读取失败不能伪装成文件不存在 */
    async read(_relative: string): Promise<string | null> { return this.fail(); }
    /** 不允许写入替代数据源 */
    async write(_relative: string, _content: string): Promise<void> { this.fail(); }
    /** 不允许创建替代事件 */
    async create(_relative: string, _content: string): Promise<void> { this.fail(); }
    /** 不允许把未连接误报为空词库 */
    async list(_prefix: string): Promise<string[]> { return this.fail(); }
    /** 故障连接不会执行提交回调 */
    async exclusive<T>(_action: () => Promise<T>): Promise<T> { return this.fail(); }
}
