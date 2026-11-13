/** 同步契约只描述业务操作，不暴露本地文件路径 */
export interface SyncOperation {
    /** 永不复用的操作身份，也是请求重试幂等键 */
    operationId: string;
    /** 所属学习库，错误库必须拒绝 */
    libraryId: string;
    /** 客户端安装身份，不能使用设备名称代替 */
    clientId: string;
    /** 业务实体身份 */
    entityId: string;
    /** 客户端产生操作时看到的实体版本 */
    baseRevision: number;
    /** 修改、删除与恢复必须显式传播 */
    kind: "edit-material" | "delete-material" | "restore-material" | "grade" | "undo" | "suspend";
    /** 协议版本与本地存储格式版本独立演进 */
    protocolVersion: 1;
    /** 业务负载由具体操作校验，未知字段不能静默写入 */
    payload: unknown;
}
/** 服务端明确确认成功、冲突或旧客户端不可写 */
export type SyncResult =
    | { status: "committed"; operationId: string; revision: number; cursor: string }
    | { status: "conflict"; operationId: string; currentRevision: number; resolution: "refresh-and-reapply" | "choose-review-branch" }
    | { status: "upgrade-required"; minimumProtocolVersion: number };
/** 增量游标只在整页成功应用后推进，重复页按操作身份去重 */
export interface SyncPage {
    /** 学习库身份 */
    libraryId: string;
    /** 作为当前页基线的原游标 */
    fromCursor: string;
    /** 全页提交后才能保存的新游标 */
    nextCursor: string;
    /** 包括删除和恢复的有序业务变化 */
    changes: SyncOperation[];
    /** 是否仍有后续变化 */
    hasMore: boolean;
}
