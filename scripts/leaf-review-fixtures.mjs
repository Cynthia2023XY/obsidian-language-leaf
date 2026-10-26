import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const vault = process.argv[2];
if (!vault) throw new Error('请提供专用测试笔记库路径');
const folder = join(resolve(vault), 'Language Leaf 内置复习验收-2026-10-26');
mkdirSync(folder, { recursive: true });
const bundle = await build({ entryPoints: ['src/lingualeaf/article.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const module = { exports: {} }; runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports });
const { renderCard } = module.exports;
const samples = [
    ['on the threshold', '在门槛处；即将开始', 'The traveler paused on the threshold and looked back.', '旅人在门槛处停下来，回头看了看。'],
    ['ample justification', '充分的理由 / 论证依据', 'Tav proposed the change and supplied ample justification: there was sunshine by the window, there were treats downstairs, and his husband was already here.', '塔夫提出了改变计划，并给出了充分理由：窗边有阳光，楼下有点心，而丈夫已经在这里了。'],
    ['restraint', '克制；约束', 'I ought to show a little more restraint.', '我应该稍微克制一些。'],
    ['take a closer look', '仔细看看', 'She asked him to take a closer look at the old map before making a decision.', '她让他在做决定前仔细看看那张旧地图。'],
];
function note(name, text) { const path = join(folder, name + '.md'); if (existsSync(path)) { console.log('保留已有测试文件：' + path); return; } writeFileSync(path, text); console.log('已创建：' + path); }
function card(sample, owner, index) { return { id: randomUUID(), expressionId: randomUUID(), language: 'en', text: sample[0], meaning: sample[1], sentence: sample[2], translation: sample[3], outline: '内置复习专用测试，不属于用户实际学习数据。', notes: index === 1 ? '检查长句排版；方向键评分后可撤销。' : '', anchor: sample[2], kind: sample[0].includes(' ') ? 'phrase' : 'word', owner, sentences: [{ text: sample[2], trans: sample[3], origin: '内置复习验收' }] }; }
note('01-专注回忆与方向键', '# 专注回忆与方向键\n\n命令面板运行“Language Leaf: 复习当前文章词句”。\n\n' + samples.map((sample, index) => renderCard(card(sample, 'builtin', index), '?')).join('\n\n') + '\n');
note('02-SR迁移副本', '# SR 迁移副本\n\n仅用于勾选迁移和回退测试；不会自动迁移。\n\n#flashcards\n\n' + samples.slice(0, 2).map((sample, index) => renderCard(card(sample, 'spaced-repetition', index), '?', index ? '<!--SR:!fsrs,2026-10-26T00:00:00.000Z,3,3.5,5.2,2,7,1,0,2026-10-23T00:00:00.000Z-->' : '<!--SR:!2026-10-26,3,250-->')).join('\n\n') + '\n');
note('00-验收步骤', `# 内置复习验收\n\n1. 重新加载 Language Leaf，打开 [[01-专注回忆与方向键]]，执行“复习当前文章词句”。\n2. 未揭晓时按方向键，确认不会评分；空格揭晓答案。\n3. 左＝不记得，下＝不确定，上＝记得，右＝简单。长按不应连续评分。\n4. 点击撤销，确认回到评分前状态。\n5. 编辑释义并保存，确认卡片身份与复习进度不变；输入框方向键不应评分。\n6. 暂停卡片，再从“查看已暂停”恢复。\n7. 关闭后重开，确认进度与当日新词额度保留。学习卡未到期时应显示等待。\n8. 执行“迁移 SR 卡片到内置复习（预览）”，只勾选 [[02-SR迁移副本]] 中的测试卡。关闭 SR 复习窗口后迁移。\n9. 迁移后原文没有 SR 分隔符和调度注释；未评分前可在迁移记录回退。评分后回退应被阻止。\n\n新卡片默认沿用原 SR 设置。要测试收词到内置复习，请在插件设置将“新卡片复习方式”设为“内置 FSRS 复习”。不影响已有卡片。\n`);
