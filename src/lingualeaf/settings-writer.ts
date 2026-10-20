import { readSettings } from "./config";
import type { LeafPluginSettings } from "./config";

/** 只修改本次编辑字段，避免快速编辑时覆盖其他设置 */
export type SettingsChange = (settings: LeafPluginSettings) => void;

/** 顺序校验与保存设置，失败后仍允许后续有效更改生效 */
export class SettingsWriter {
    /** 已排队的设置操作，防止异步写盘次序颠倒 */
    private pending: Promise<void> = Promise.resolve();
    /** 获取最新配置、保存配置和检查现有卡片的宿主边界 */
    constructor(
        private current: () => LeafPluginSettings,
        private save: (settings: LeafPluginSettings) => Promise<void>,
        private hasCards: () => Promise<boolean>,
    ) {}
    /** 每次只应用一个字段变化，无效输入不覆盖正在使用的配置 */
    update(change: SettingsChange): Promise<void> {
        // 排到执行时再读取配置，保证连续编辑合并到最新版本。
        const operation = this.pending.then(async () => {
            // 独立副本使校验和持久化失败不污染运行中的设置。
            const previous = this.current();
            // 保留全部受支持配置，只修改本次输入。
            const next = readSettings(previous);
            change(next);
            if (!/^#[\p{L}\p{N}_/-]+$/u.test(next.learning.deck)) throw new Error("请输入以 # 开头的有效卡组标签；当前配置未更改。");
            if (!next.learning.separator.trim() || /[\r\n<>]/.test(next.learning.separator)) throw new Error("请输入有效的单行分隔符；当前配置未更改。");
            if (next.learning.separator !== previous.learning.separator && await this.hasCards()) throw new Error("已有闪卡，不能直接更改分隔符；当前配置未更改。");
            await this.save(next);
        });
        this.pending = operation.catch(() => {});
        return operation;
    }
}
