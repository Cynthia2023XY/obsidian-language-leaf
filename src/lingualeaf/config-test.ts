import { describe, expect, it } from "vitest";
import { readSettings } from "./config";

describe("复习样式设置", () => {
    it("旧配置和未知样式默认专注回忆", () => {
        expect(readSettings(null).review.layout).toBe("focus");
        expect(readSettings({ review: { layout: "unknown" } }).review.layout).toBe("focus");
    });
    it("语境对照设置可保存回读，其他复习配置保留", () => {
        const config = readSettings({ review: { layout: "context", engine: "builtin", newLimit: 8, retention: .92 } });
        expect(config.review).toEqual({ layout: "context", engine: "builtin", newLimit: 8, retention: .92 });
        expect(readSettings(JSON.parse(JSON.stringify(config))).review).toEqual(config.review);
    });
});

describe("简化配置", () => {
    it("默认只提供原生学习、词典和 SR 配置", () => {
        // 当前数据目录不复用旧数据库或独立调度事件。
        const config = readSettings(null);
        expect(config.learning).toEqual({ language: "en", autoQuerySelection: false, modifier: "shiftKey", deck: "#flashcards", separator: "?", dataFolder: "LinguaLeafData" });
        expect(Object.keys(config).sort()).toEqual(["auto_pron", "dictionaries", "learning", "review", "review_auto_pron", "review_prons", "speech", "use_machine_trans"]);
    });
    it("不接入旧插件数据库、服务端、阅读器和内置调度选项", () => {
        // 不迁移旧字段，也不保留隐藏的旧功能开关。
        const config = readSettings({ use_server: true, self_server: true, db_name: "WordDB", foreign: "fr", popup_search: true, lingualeaf: { owner: "builtin", newLimit: 100 } });
        expect(config.learning.language).toBe("en");
        expect(config).not.toHaveProperty("db_name");
        expect(config).not.toHaveProperty("use_server");
        expect(config.learning).not.toHaveProperty("owner");
    });
    it("新配置中的法语、修饰键和关闭联网选项能正常保存回读", () => {
        // 保留用户明确配置的当前功能值。
        const config = readSettings({ learning: { language: "fr", autoQuerySelection: true, modifier: "altKey", deck: "#flashcards/french", separator: "??" }, auto_pron: false, review_auto_pron: false, use_machine_trans: false, review_prons: "1", dictionaries: { youdao: { enable: false } } });
        expect(config.learning.language).toBe("fr");
        expect(config.learning.modifier).toBe("altKey");
        expect(config.learning.autoQuerySelection).toBe(true);
        expect(config.dictionaries.youdao.enable).toBe(false);
        expect(readSettings(JSON.parse(JSON.stringify(config)))).toEqual(config);
    });
    it("非法分隔符与卡组值不进入文件写回配置", () => {
        // 未知配置不能变成多行卡片语法或越界文件路径。
        const config = readSettings({ learning: { language: "invalid", modifier: "invalid", deck: "bad\n#tag", separator: "?\n?", dataFolder: "../../outside" } });
        expect(config.learning.deck).toBe("#flashcards");
        expect(config.learning.separator).toBe("?");
        expect(config.learning.dataFolder).toBe("LinguaLeafData");
    });
});


describe("系统声音设置", () => {
    it("旧设置默认启用并自动选择，新设置可以关闭和保存音色", () => {
        expect(readSettings(null).speech).toEqual({ enabled: true, voice: "" });
        const settings = readSettings({ speech: { enabled: false, voice: "com.apple.voice.samantha" } });
        expect(readSettings(JSON.parse(JSON.stringify(settings))).speech).toEqual(settings.speech);
        expect(readSettings({ speech: { voice: 5 } }).speech.voice).toBe("");
    });
});
