import type { LeafCard } from "./domain";

/** 持久化读写端口，领域层不依赖 Vault 或 IndexedDB */
export interface FilePort {
    /** 获取文件；不存在时返回空值 */
    read(path: string): Promise<string | null>;
    /** 写入前由适配器创建所需目录 */
    write(path: string, content: string): Promise<void>;
    /** 枚举目录中的持久数据 */
    list(prefix: string): Promise<string[]>;
}
/** 已确认意图但尚未全部落盘的文章写入操作 */
export interface CaptureOperation {
    /** 幂等操作身份 */
    id: string;
    /** 目标文章路径 */
    path: string;
    /** 用户确认过的收词数据 */
    card: LeafCard;
    /** 恢复时保持原卡组约定 */
    separator: string;
    /** 当时选择的 SR 卡组 */
    deck: string;
    /** 操作是否已完成 */
    done: boolean;
}
/** 收词操作意图和崩溃恢复记录的持久仓库 */
export class LearningStore {
    /** 宿主提供的文件接口 */
    private port: FilePort;
    /** 专用数据目录 */
    readonly root: string;
    /** 绑定存储适配器，拒绝路径穿越 */
    constructor(port: FilePort, root: string) {
        if (!root || root.startsWith("/") || root.split("/").some(part => part === ".." || part === "." || !part) || /[\\:]/.test(root)) throw new Error("学习数据目录必须是 Vault 内普通相对路径");
        this.port = port;
        this.root = root;
    }
    /** 写入收词意图，成功后才允许修改文章 */
    async capture(operation: CaptureOperation): Promise<void> {
        await this.port.write(`${this.root}/operations/${operation.id}.json`, JSON.stringify({ schema: 1, ...operation }, null, 2));
    }
    /** 查找上次中断的收词操作，损坏文件不静默跳过 */
    async pending(): Promise<CaptureOperation[]> {
        // 获取独立操作文件，支持程序重启后恢复。
        const paths = await this.port.list(`${this.root}/operations/`);
        // 每个文件需带可识别的版本，避免未来版本被旧代码改写。
        const values = await Promise.all(paths.filter(path => path.endsWith(".json")).map(async path => {
            // 操作格式校验由恢复时的文章写入流程继续验证。
            const value = JSON.parse((await this.port.read(path)) || "null");
            if (!value || value.schema !== 1 || typeof value.id !== "string" || typeof value.path !== "string") throw new Error(`收词操作损坏：${path}`);
            return value as CaptureOperation;
        }));
        return values.filter(value => !value.done);
    }
}
