import { build } from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

/** 所有参数独立读取，不拼接 shell 命令 */
const args = process.argv.slice(2);
/** 获取显式命名参数，缺少必要参数时拒绝执行 */
function option(name, fallback = "") {
    // 参数值不能被下一个选项误认为路径。
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
}
/** 当前唯一词库目录 */
const source = option("--source");
/** 负责保存和同步学习数据的主笔记库 */
const vault = option("--vault");
/** 只提供收录入口的可选笔记库 */
const secondary = option("--secondary-vault");
/** 主库内可同步的普通目录 */
const relative = option("--relative", "LanguageLeafLibrary");
if (!path.isAbsolute(source) || !path.isAbsolute(vault) || (secondary && !path.isAbsolute(secondary))) throw new Error("用法：node scripts/relocate-library-into-vault.mjs --source <原词库绝对路径> --vault <主笔记库绝对路径> [--secondary-vault <额外入口绝对路径>] [--relative LanguageLeafLibrary] [--apply]");
/** 临时编译目录位于笔记库之外，执行完立即清理 */
const temporary = await fs.mkdtemp(path.join(tmpdir(), "leaf-vault-relocation-"));
try {
    // 同一份正式服务用于预览、测试和实际迁移。
    const entry = path.join(temporary, "entry.ts");
    await fs.writeFile(entry, ["library", "library-relocation", "library-connection"].map(name => `export * from ${JSON.stringify(path.resolve("src/lingualeaf", name + ".ts"))};`).join("\n"));
    // 此脚本不加载或操作 Obsidian 内部运行时。
    const output = path.join(temporary, "services.cjs");
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "cjs" });
    // 读取经正式代码校验的库身份。
    const { LearningLibrary, relocateLibrary, LibraryBindings } = createRequire(import.meta.url)(output);
    // 插件原始设置保留所有未知字段和凭据。
    const settingsFile = root => path.join(root, ".obsidian/plugins/language-leaf/data.json");
    // 两个数据源设置分别保存，避免整份目录替换。
    const primary = JSON.parse(await fs.readFile(settingsFile(vault), "utf8"));
    // 预览模式完全不创建目标或本机绑定文件。
    const sourceLibrary = new LearningLibrary(source, primary.learning?.libraryId);
    // 重跑已发布迁移时，从目标读取身份继续配置连接。
    const catalog = await sourceLibrary.catalog().catch(async error => {
        // 仅接受明确的已迁移标记，不能因任何读取失败换成另一个库。
        const moved = JSON.parse(await fs.readFile(path.join(source, "relocation.json"), "utf8").catch(() => "null"));
        if (!moved || moved.target !== path.join(vault, relative)) throw error;
        return new LearningLibrary(moved.target, primary.learning?.libraryId).catalog();
    });
    if (!args.includes("--apply")) {
        console.log(JSON.stringify({ preview: true, source, target: path.join(vault, relative), libraryId: catalog.id, cards: catalog.records.length, secondaryVault: secondary || null }, null, 2));
    } else {
        // 迁移内部完成双版本锁保护、完整备份和字节/调度校验。
        const report = await relocateLibrary({ source, vault, relative, libraryId: catalog.id });
        // 原插件设置备份到库外，连接迁移不触碰其他字段。
        const configs = [[vault, "vault"], ...(secondary ? [[secondary, "external"]] : [])];
        for (const [root, mode] of configs) {
            // 使用写入时最新设置，保留其他窗口刚保存的非连接配置。
            const filename = settingsFile(root);
            // 备份原始字节，不将重新格式化结果冒充原文件。
            const raw = await fs.readFile(filename, "utf8");
            // 迁移重跑不能覆盖第一次连接切换之前的设置备份。
            const backup = path.join(report.backup, `plugin-settings-${path.basename(root)}.json`);
            await fs.writeFile(backup, raw, { flag: "wx", mode: 0o600 }).catch(error => { if (error.code !== "EEXIST") throw error; });
            // 只修改连接字段，各库的稳定来源身份保持原样。
            const settings = JSON.parse(raw);
            if (!settings.learning?.vaultId) throw new Error("来源笔记库缺少稳定身份，已停止连接切换");
            if (mode === "external") await new LibraryBindings().save(settings.learning.vaultId, catalog.id, report.target);
            settings.learning = { ...settings.learning, libraryMode: mode, libraryPath: mode === "vault" ? relative : "", libraryId: catalog.id };
            // 通过原子替换发布设置，避免读到半份配置。
            const pending = filename + ".relocation.tmp";
            await fs.writeFile(pending, JSON.stringify(settings, null, 2), { mode: 0o600 });
            await fs.rename(pending, filename);
        }
        console.log(JSON.stringify({ ...report, connectedVaults: configs.map(([root]) => root), authority: "Cynthia Note", runtimeFilesOutsideVault: true }, null, 2));
    }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
