import * as fs from "fs/promises";
import { watch } from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { Dirent } from "fs";
import type { FilePort } from "./storage";

/** 独立学习库的磁盘接口，不经过 Obsidian 文章索引 */
export class LibraryFiles implements FilePort {
    /** 用户明确选择的绝对目录 */
    readonly directory: string;
    /** 缓存库外的本机运行区，锁与缓存不会进入同步目录 */
    private runtime?: Promise<string>;
    /** 拒绝相对目录，防止数据随当前工作目录漂移 */
    constructor(directory: string) {
        if (!path.isAbsolute(directory)) throw new Error("独立学习库必须使用绝对路径");
        this.directory = path.resolve(directory);
    }
    /** 在所属笔记库之外建立同文件系统运行区，保持原子发布语义 */
    async runtimeDirectory(): Promise<string> {
        if (!this.runtime) this.runtime = (async () => {
            // 向上查找实际 Obsidian 根目录，只检查目录标记，不读取笔记内容。
            let ancestor = this.directory;
            // 没有关联笔记库的独立库使用同级本机目录。
            let parent = path.dirname(this.directory);
            while (true) {
                try { if ((await fs.stat(path.join(ancestor, ".obsidian"))).isDirectory()) { parent = path.dirname(ancestor); break; } }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                if (path.dirname(ancestor) === ancestor) break;
                ancestor = path.dirname(ancestor);
            }
            return path.join(parent, ".language-leaf-local", createHash("sha256").update(this.directory).digest("hex"));
        })();
        return this.runtime;
    }
    /** 拒绝越界路径，临时会话与派生索引自动路由到库外 */
    private async resolve(relative: string): Promise<string> {
        if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === ".." || !part) || relative.includes("\0")) throw new Error("学习库数据路径无效");
        // 学习进度的权威来源是事件；会话与派生索引仅属于当前设备。
        const local = relative === "LinguaLeafData/review/projection.json" || relative === "LinguaLeafData/review/sessions" || relative.startsWith("LinguaLeafData/review/sessions/");
        return path.join(local ? await this.runtimeDirectory() : this.directory, relative);
    }
    /** 不存在与磁盘读取失败必须区分，禁止失败后创建空数据源 */
    async read(relative: string): Promise<string | null> {
        try { return await fs.readFile(await this.resolve(relative), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
    /** 临时文件写完并落盘后才发布，读者不会读到半份 JSON */
    private async publish(relative: string, content: string, exclusive: boolean): Promise<void> {
        // 目标学习文件保持原路径，运行文件单独路由。
        const target = await this.resolve(relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        // 本机运行区与学习库保持在同一文件系统。
        const runtime = await this.runtimeDirectory();
        await fs.mkdir(runtime, { recursive: true });
        // 运行区与目标必须位于同一文件系统，不能降级为非原子复制。
        const [runtimeStat, targetStat] = await Promise.all([fs.stat(runtime), fs.stat(path.dirname(target))]);
        if (runtimeStat.dev !== targetStat.dev) throw new Error("本机运行区与学习库不在同一文件系统，已停止非原子写入");
        // 临时文件始终在笔记库外，即使同步插件扫描全部文件也不会上传。
        const temporary = path.join(runtime, `${randomUUID()}.tmp`);
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
            try { entries = await fs.readdir(await this.resolve(relative), { withFileTypes: true }); }
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
            const stat = await fs.stat(await this.resolve(relative), { bigint: true });
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
        await fs.stat(this.directory);
        // 运行锁位于所属笔记库外，另一台设备不会收到此进程的锁。
        const runtime = await this.runtimeDirectory();
        await fs.mkdir(runtime, { recursive: true });
        // 同一数据源的两个入口使用完全相同的本机锁。
        const lock = path.join(runtime, ".catalog.lock");
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
