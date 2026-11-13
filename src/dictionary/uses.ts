import { watch } from "vue";

/** 词典加载状态的统一事件 */
type Emit = (event: "loading", status: { id: string; loading: boolean; result: boolean }) => void;

/** 快速换词和卸载时取消旧请求的提交权限 */
function useLoading(watchee: () => unknown, id: string, search: (valid: () => boolean) => Promise<boolean>, emit: Emit) {
    watch(watchee, async (_word, _old, cleanup) => {
        // 每个 watch 周期独占结果写入权限。
        let active = true;
        cleanup(() => { active = false; });
        emit("loading", { id, loading: true, result: false });
        try {
            // 词典组件在赋值前使用相同权限校验。
            const result = await search(() => active);
            if (active) emit("loading", { id, loading: false, result });
        } catch {
            if (active) emit("loading", { id, loading: false, result: false });
        }
    }, { flush: "sync" });
}

export { useLoading };
