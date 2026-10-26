import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { build } from "esbuild";

/** 只读取指定的已安装 SR 包，验证其真实解析器，不执行插件宿主代码。 */
const srPath = process.argv[2];
assert.ok(srPath, "用法：node scripts/leaf-card-sr-compat.mjs <Spaced Repetition main.js>");
const sr = readFileSync(srPath, "utf8");
const dependenciesEnd = sr.indexOf("// node_modules/.pnpm/moment@");
const parserStart = sr.indexOf("// src/parser.ts\n");
const parserEnd = sr.indexOf("\n// src/", parserStart + 1);
const metadata = sr.match(/^var SR_METADATA_CALLOUT = .*;$/m)?.[0];
assert.ok(dependenciesEnd > 0 && parserStart > dependenciesEnd && parserEnd > parserStart && metadata, "SR 包结构改变，请更新提取边界");
const srContext = {};
runInNewContext(sr.slice(0, dependenciesEnd) + "\n" + metadata + "\n" + sr.slice(parserStart, parserEnd) + "\nthis.srParse=parse;", srContext);
const bundle = await build({ entryPoints: ["src/lingualeaf/article.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
const leafModule = { exports: {} };
const leafContext = { module: leafModule, exports: leafModule.exports };
runInNewContext(bundle.outputFiles[0].text, leafContext);
const { renderCard, parseCards, upsertCard } = leafContext.module.exports;
const card = { id: "compat-1", expressionId: "expression-1", language: "en", text: "ample justification", meaning: "充分的理由", sentence: "He supplied ample justification.", translation: "他提供了充分的理由。", outline: "阅读练习", notes: "保留提示", anchor: "He supplied ample justification.", kind: "phrase", owner: "spaced-repetition", sentences: [{ text: "He supplied ample justification.", trans: "他提供了充分的理由。", origin: "Reading" }] };
const schedule = "<!--SR:!2026-10-26,3,250-->";
const options = { singleLineCardSeparator: "::", singleLineReversedCardSeparator: ":::", multilineCardSeparator: "?", multilineReversedCardSeparator: "??", multilineCardEndMarker: "", clozePatterns: [] };
// 使用同一文章中的相邻卡片，验证留白不会提前截断或吞掉下一张卡。
const source = renderCard(card, "?", schedule) + "\n\n" + renderCard({ ...card, id: "compat-2", text: "a second phrase" }, "?");
for (const newline of ["\n", "\r\n"]) {
    const input = source.replace(/\n/g, newline);
    const cards = srContext.srParse(input, options);
    assert.equal(cards.length, 2);
    assert.ok(cards[0].text.includes("**译文**：他提供了充分的理由。"));
    assert.ok(cards[0].text.includes("**笔记**：保留提示"));
    assert.ok(cards[0].text.includes('出处：Reading</small>'));
    assert.ok(cards[0].text.includes(schedule));
    const updated = upsertCard(input, { ...card, meaning: "更新释义" }, "?", "#flashcards");
    assert.equal(srContext.srParse(updated, options).length, 2);
    assert.equal(parseCards(updated, "?")[0].schedule, schedule);
}
const report = { testedAt: new Date().toISOString(), srVersion: JSON.parse(readFileSync(join(dirname(srPath), "manifest.json"), "utf8")).version, srBundleSha256: createHash("sha256").update(sr).digest("hex"), method: "Installed SR parser and bundled clozecraft executed in isolation; no Obsidian UI or physical trackpad verification", checks: ["LF/CRLF each retain two complete cards", "translation, notes, source and schedule remain inside first SR card", "updating a card preserves SR schedule and card count"] };
writeFileSync("docs/lingualeaf/card-sr-compat.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
