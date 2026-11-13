import { build } from "esbuild";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";

/** 通过结构化参数读取路径，不拼接 shell */
const args = process.argv.slice(2);
/** 迁移原库 */
const vault = args[args.indexOf("--vault") + 1];
/** 新数据源 */
const destination = args[args.indexOf("--destination") + 1];
if (!args.includes("--vault") || !args.includes("--destination") || !vault || !destination) throw new Error("用法：node scripts/migrate-independent-library.mjs --vault <原库> --destination <新数据源> [--apply]");
/** 一次性编译目录，不加载 Obsidian 或插件 */
const temporary = await mkdtemp(join(tmpdir(), "leaf-migration-"));
try {
    // 复用正式解析器、身份校验和 FSRS 导入规则。
    const output = join(temporary, "migration.cjs");
    await build({ entryPoints: ["src/lingualeaf/library-migration.ts"], outfile: output, bundle: true, platform: "node", format: "cjs" });
    // 显式 apply 才执行迁移。
    const { migrateLibrary } = createRequire(import.meta.url)(output);
    console.log(JSON.stringify(await migrateLibrary({ vault, destination, apply: args.includes("--apply") }), null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
