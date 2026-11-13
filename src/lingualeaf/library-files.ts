import * as fs from "fs/promises";
import { watch } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { Dirent } from "fs";
import type { FilePort } from "./storage";

/** 独立学习库的磁盘接口，不经过 Obsidian 文章索引 */
export class LibraryFiles implements FilePort {
    /** 用户明确选择的绝对目录 */
    readonly directory: string;
    /** 拒绝相对目录，防止数据随当前工作目录漂移 */
    constructor(directory: string) {
        if (!path.isAbsolute(directory)) throw new Error("独立学习库必须使用绝对路径");
        this.directory = path.resolve(directory);
    }
    /** 所有数据文件只能位于已选择的学习库内 */
    private resolve(relative: string): string {
        if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === ".." || !part) || relative.includes("\0")) throw new Error("学习库数据路径无效");
        return path.join(this.directory, relative);
    }
    /** 不存在与磁盘读取失败必须区分，禁止失败后创建空数据源 */
    async read(relative: string): Promise<string | null> {
        try { return await fs.readFile(this.resolve(relative), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
    /** 临时文件写完并落盘后才发布，读者不会读到半份 JSON */
    private async publish(relative: string, content: string, exclusive: boolean): Promise<void> {
        // 临时文件与目标位于同一目录，避免跨文件系统移动。
        const target = this.resolve(relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        // 随机临时文件不会覆盖另一个窗口的未完成写入。
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
            // 独占建立临时文件并确认内容落盘。
            const handle = await fs.open(temporary, "wx", 0o600);
            try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
            if (exclusive) await fs.link(temporary, target);
            else await fs.rename(temporary, target);
        } finally { await fs.unlink(temporary).catch((): void => undefined); }
    }
    /** 原子替换目录内的一份可变数据 */
    async write(relative: string, content: string): Promise<void> { await this.publish(relative, content, false); }
    /** 评分事件采用独占发布，两个窗口不能写入同一个版本 */
    async create(relative: string, content: string): Promise<void> { await this.publish(relative, content, true); }
    /** 枚举已发布文件，忽略临时文件和互斥锁 */
    async list(prefix: string): Promise<string[]> {
        // 原接口传入目录前缀，允许结尾的一个分隔符。
        const folder = prefix.replace(/\/$/, "");
        // 所有返回值继续使用与旧评分引擎一致的相对路径。
        const walk = async (relative: string): Promise<string[]> => {
            // 不存在的事件目录代表尚未产生事件。
            let entries: Dirent[];
            try { entries = await fs.readdir(this.resolve(relative), { withFileTypes: true }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
            return (await Promise.all(entries.map(async entry => {
                // 不跟随符号链接，不把外部文件纳入数据源。
                const child = `${relative}/${entry.name}`;
                return entry.isDirectory() ? walk(child) : entry.isFile() && entry.name.endsWith(".json") ? [child] : [];
            }))).flat();
        };
        return walk(folder);
    }
    /** 文件原子替换产生新的 inode，避免整份目录反复解析 */
    async version(relative: string): Promise<string> {
        // 文件不存在也形成明确版本，不吞掉权限或磁盘错误。
        try {
            // 高精度 stat 身份与大小共同标识一次原子发布。
            const stat = await fs.stat(this.resolve(relative), { bigint: true });
            return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    }
    /** 监听完整目录树，任何已发布文件变化都会通知订阅者 */
    subscribe(changed: () => void): () => void {
        // Obsidian 桌面环境支持递归监听，关闭面板时立即释放句柄。
        const watcher = watch(this.directory, { recursive: true }, (_event, filename) => {
            if (filename?.endsWith(".json")) changed();
        });
        watcher.on("error", changed);
        return () => watcher.close();
    }
    /** 跨插件实例串行更新词库，进程退出后的锁可以安全回收 */
    async exclusive<T>(task: () => Promise<T>): Promise<T> {
        // 学习库必须预先迁移或显式创建，不能悄悄换成空库。
        const lock = path.join(this.directory, ".catalog.lock");
        // 锁身份用于释放时确认所有者未变化。
        const token = `${process.pid}:${randomUUID()}`;
        try { await fs.writeFile(lock, token, { flag: "wx", mode: 0o600 }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // 回收互斥锁避免两个恢复者先后删除新的活跃锁。
            const reaper = `${lock}.reaper`;
            try { await fs.writeFile(reaper, token, { flag: "wx", mode: 0o600 }); }
            catch { throw new Error("学习库正在恢复写入锁，请稍后重试"); }
            try {
            // 只有可以确认进程不存在时才清理，绝不靠超时抢占活跃写入。
            const owner = await fs.readFile(lock, "utf8");
            // 锁正在创建或格式未知时拒绝写入。
            const pid = Number(owner.split(":")[0]);
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("学习库正在写入，请稍后重试");
            try { process.kill(pid, 0); throw new Error("学习库正在被另一个窗口更新，请稍后重试"); }
            catch (status) { if ((status as NodeJS.ErrnoException).code !== "ESRCH") throw status; }
            if (await fs.readFile(lock, "utf8") !== owner) throw new Error("学习库锁已变化，请重试");
            await fs.unlink(lock);
            } finally { await fs.unlink(reaper); }
            return this.exclusive(task);
        }
        try { return await task(); }
        finally { if (await fs.readFile(lock, "utf8").catch(() => "") === token) await fs.unlink(lock); }
    }
}
