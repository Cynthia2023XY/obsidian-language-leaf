import { describe, expect, it } from "vitest";
import { effectScope, ref } from "vue";
import { useLoading } from "./uses";

/** 用可控 Promise 复现旧查询晚于新查询完成的真实顺序 */
describe("词典请求提交权限", () => {
    it("旧查询和已关闭视图不能覆盖新结果或加载状态", async () => {
        // 不挂载界面，直接验证 composable 与 Vue watcher 清理协作。
        const scope = effectScope();
        // 当前词是 watcher 的唯一查询输入。
        const word = ref("");
        // 模拟网络返回顺序，保留真实 Vue 响应式机制。
        const pending: Array<{ resolve: () => void; valid: () => boolean }> = [];
        // 用户最终看到的当前词典结果。
        let shown = "";
        // 收集外部可观察的加载事件。
        const statuses: unknown[] = [];
        scope.run(() => useLoading(() => word.value, "test", async valid => {
            // 这个请求只使用触发时的表达。
            const query = word.value;
            await new Promise<void>(resolve => pending.push({ resolve, valid }));
            if (!valid()) return false;
            shown = query; return true;
        }, (_event, status) => statuses.push(status)));
        word.value = "leaf"; word.value = "tree";
        pending[1].resolve(); await Promise.resolve(); await Promise.resolve();
        expect(shown).toBe("tree");
        pending[0].resolve(); await Promise.resolve(); await Promise.resolve();
        expect(shown).toBe("tree");
        expect(statuses).toHaveLength(3);
        word.value = "forest"; scope.stop();
        pending[2].resolve(); await Promise.resolve(); await Promise.resolve();
        expect(shown).toBe("tree");
        expect(pending[2].valid()).toBe(false);
    });
});
