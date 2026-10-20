import { describe, expect, it } from "vitest";
import { readSettings } from "./config";
import { SettingsWriter } from "./settings-writer";

describe("编辑后自动保存设置", () => {
    it("连续修改按顺序保存并保留其他字段", async () => {
        // 模拟异步持久化后才更新运行配置。
        let current = readSettings({});
        // 记录用户最终实际写入的配置。
        const saved: unknown[] = [];
        // 通过真实保存边界验证快速编辑不会相互覆盖。
        const writer = new SettingsWriter(() => current, async next => { await Promise.resolve(); current = next; saved.push(next); }, async () => false);
        await Promise.all([writer.update(next => { next.learning.language = "fr"; }), writer.update(next => { next.auto_pron = false; }), writer.update(next => { next.dictionaries.youdao.enable = false; })]);
        expect(saved).toHaveLength(3);
        expect(current.learning.language).toBe("fr");
        expect(current.auto_pron).toBe(false);
        expect(current.dictionaries.youdao.enable).toBe(false);
    });
    it("无效输入不落盘且不阻塞后续有效设置", async () => {
        // 用运行配置验证非法编辑没有偷偷回退成默认值。
        let current = readSettings({ learning: { deck: "#words" } });
        // 保存边界使用与插件相同的成功后应用语义。
        const writer = new SettingsWriter(() => current, async next => { current = next; }, async () => false);
        await expect(writer.update(next => { next.learning.deck = "#"; })).rejects.toThrow("有效卡组标签");
        await expect(writer.update(next => { next.learning.separator = ""; })).rejects.toThrow("有效的单行分隔符");
        await writer.update(next => { next.review_auto_pron = false; });
        expect(current.learning.deck).toBe("#words");
        expect(current.learning.separator).toBe("?");
        expect(current.review_auto_pron).toBe(false);
    });
    it("已有闪卡时拒绝改分隔符并允许其他设置生效", async () => {
        // 有现存闪卡的场景必须保护 SR 解析格式。
        let current = readSettings({});
        // 模拟宿主扫描发现至少一张已有卡片。
        const writer = new SettingsWriter(() => current, async next => { current = next; }, async () => true);
        await expect(writer.update(next => { next.learning.separator = "::"; })).rejects.toThrow("已有闪卡");
        await writer.update(next => { next.learning.deck = "#words/en"; });
        expect(current.learning.separator).toBe("?");
        expect(current.learning.deck).toBe("#words/en");
    });
    it("写盘失败后保持原配置且下一次修改可以恢复", async () => {
        // 模拟磁盘暂时不可写，而不是只测试内存赋值。
        let current = readSettings({});
        // 第一次写入失败后下一次可以正常保存。
        let fail = true;
        // 持久化失败不能让队列永久停在失败状态。
        const writer = new SettingsWriter(() => current, async next => { if (fail) { fail = false; throw new Error("写盘失败"); } current = next; }, async () => false);
        await expect(writer.update(next => { next.learning.language = "fr"; })).rejects.toThrow("写盘失败");
        expect(current.learning.language).toBe("en");
        await writer.update(next => { next.learning.language = "fr"; });
        expect(current.learning.language).toBe("fr");
    });
});
