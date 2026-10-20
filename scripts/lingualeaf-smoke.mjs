import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

/** 只在指定开发测试库执行，不对用户个人库写验收数据 */
const vault = "新功能测试仓库";
/** CLI 通过参数数组传值，不经过 shell 插值 */
const cli = (...args) => execFileSync("obsidian", [`vault=${vault}`, ...args], { encoding: "utf8" }).trim().replace(/^=> /, "");
assert.equal(cli("vault", "info=path"), "/Users/dingxinyi.2/Documents/practice/obsidian测试笔记库/新功能测试仓库");
/** 每个阶段只等待自己的异步结果，避免 CLI 对 Promise 直接返回空内容 */
async function evaluate(code) {
    // 每次运行使用独立结果槽，代码解析失败时不会误取上一阶段结果。
    const slot = "__linguaResult" + Date.now() + Math.floor(Math.random() * 100000);
    // 结果槽只包含验收文件信息，不记录用户数据或词典密钥。
    cli("eval", `code=window[${JSON.stringify(slot)}]=null;void Promise.resolve().then(async()=>{${code}}).then(value=>{window[${JSON.stringify(slot)}]=JSON.stringify({value})},error=>{window[${JSON.stringify(slot)}]=JSON.stringify({error:String(error),stack:error.stack})})`);
    for (let attempt = 0; attempt < 100; attempt++) {
        // 不做长时间阻塞等待，CLI 结果就绪即继续。
        const raw = cli("eval", `code=window[${JSON.stringify(slot)}] || 'pending'`);
        if (raw && raw !== "pending" && raw !== "(no output)") {
            // 所有阶段错误都使脚本失败，不能生成“通过”的报告。
            const result = JSON.parse(raw);
            if (result.error) throw new Error(result.stack || result.error);
            return result.value;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Obsidian 验收阶段超时");
}
/** 所有断言均限定在本轮新建文章和当前插件 UI */
const results = [];
/** 本轮只使用临时内存配置，测试不保存用户词典设置 */
const original = await evaluate(`
const plugin=app.plugins.plugins['obsidian-language-learner'];
const commands=Object.values(app.commands.commands).filter(command=>command.id.startsWith(plugin.manifest.id+':'));
const expected=['切换当前文档为学习模式','打开单词列表','打开查词面板','打开新词面板'];
if(commands.length!==4||expected.some(name=>!commands.some(command=>command.name===plugin.manifest.name+': '+name)))throw new Error('命令清单不是指定的四项');
if(plugin.db||plugin.server||plugin.parser||plugin.lingualeaf.openReview||plugin.lingualeaf.exportBackup)throw new Error('仍在运行旧功能');
window.__leafSimpleOriginal=JSON.parse(JSON.stringify(plugin.settings));
plugin.settings.auto_pron=false;plugin.settings.review_auto_pron=false;plugin.settings.use_machine_trans=false;
for(const dictionary of Object.values(plugin.settings.dictionaries))dictionary.enable=false;
plugin.store.dictsChange=!plugin.store.dictsChange;
plugin.lingualeaf.host.settings.modifier='shiftKey';
return {commands:commands.map(command=>command.name)};
`);
results.push({name:'只注册四条命令，未启动旧数据库、服务器或内置复习',...original});
try {
    await evaluate(`
const plugin=app.plugins.plugins['obsidian-language-learner'];app.setting.open();app.setting.openTabById(plugin.manifest.id);
return true;
`);
    const settings = await evaluate(`
const text=app.setting.activeTab.containerEl.textContent;
for(const label of ['学习语言','划词修饰键','查词词典','Spaced Repetition 闪卡','保存设置'])if(!text.includes(label))throw new Error('缺少配置：'+label);
for(const label of ['使用服务器','IndexDB','数据库名称','内置复习','每日新卡','迁移','恢复学习备份'])if(text.includes(label))throw new Error('仍有旧配置：'+label);
const count=app.setting.activeTab.containerEl.querySelectorAll('.setting-item').length;
app.setting.close();return {settingRows:count};
`);
    results.push({name:'简化设置页只含学习、查词、发音、翻译及 SR 格式',...settings});
    const prepared = await evaluate(`
const plugin=app.plugins.plugins['obsidian-language-learner'];const runtime=plugin.lingualeaf;
const path='Language Leaf简化验收-'+Date.now()+'.md';
const fence=String.fromCharCode(96).repeat(3);const source=[fence+'ll-outline','schema: 1','items:','  - text: 书签被纸条替换，留下线索',fence,'','The old blue bookmark lay on the bedside table. In its place was a narrow slip of paper.','','> [!translation]-','> 原来的蓝色书签被一张纸条替换。',''].join('\\n');
const file=await app.vault.create(path,source);const leaf=app.workspace.getLeaf(false);await leaf.openFile(file);app.workspace.setActiveLeaf(leaf,{focus:true});
window.__leafSimple={path,file,leaf,source};
app.commands.executeCommandById(plugin.manifest.id+':leaf-toggle-reading');
for(let i=0;i<50&&!runtime.host.sessions.has(leaf.view);i++)await new Promise(resolve=>setTimeout(resolve,20));
if(!runtime.host.sessions.has(leaf.view)||leaf.view.getMode()!=='preview')throw new Error('学习命令未生效');
if(await app.vault.read(file)!==source)throw new Error('进入学习模式修改了正文');
return {path};
`);
    let selected = false;
    for (let attempt=0;attempt<30&&!selected;attempt++) {
        selected=await evaluate(`
const view=window.__leafSimple.leaf.view;const p=Array.from(view.containerEl.querySelectorAll('.markdown-preview-view p')).find(p=>p.textContent.startsWith('The old blue bookmark'));if(!p)return false;
app.workspace.setActiveLeaf(view.leaf,{focus:true});
const text=p.firstChild;const range=document.createRange();const start=text.textContent.indexOf('In its place');range.setStart(text,start);range.setEnd(text,start+12);document.getSelection().removeAllRanges();document.getSelection().addRange(range);
p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,shiftKey:true,button:0}));return true;
`);
        if(!selected)await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.ok(selected,'原生段落未渲染');
    let captured = false;
    for(let attempt=0;attempt<30&&!captured;attempt++){
        captured=await evaluate(`
const plugin=app.plugins.plugins['obsidian-language-learner'];const request=plugin.lingualeaf.capture;
if(!request||request.file.path!==window.__leafSimple.path||request.card.text!=='In its place')return false;
if(!request.context.translation||!request.card.outline)throw new Error('已有译文或大纲丢失');
const left=app.workspace.getLeavesOfType('langr-search-panel')[0];const right=app.workspace.getLeavesOfType('langr-learn-panel')[0];
if(!left||!right)return false;
if(!app.workspace.leftSplit.containerEl.contains(left.view.containerEl)||!app.workspace.rightSplit.containerEl.contains(right.view.containerEl))throw new Error('左右面板位置错误');
return right.view.containerEl.querySelectorAll('textarea').length>0;
`);
        if(!captured)await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.ok(captured,'没有在原有左右面板呈现收词');
    await evaluate(`
const runtime=app.plugins.plugins['obsidian-language-learner'].lingualeaf;const request=runtime.capture;
request.model.notes=['第一条笔记','第二条笔记'];request.model.sentences.push({text:'Another bookmark.',trans:'另一枚书签。',origin:'补充来源'});request.model.tags=['简化验收'];request.model.status=4;
window.dispatchEvent(new CustomEvent('obsidian-langr-search',{detail:{selection:request.card.text,leafCapture:request}}));return true;
`);
    await evaluate(`
const panel=app.workspace.getLeavesOfType('langr-learn-panel')[0].view.containerEl;const meaning=panel.querySelectorAll('.n-form-item')[1].querySelector('textarea,input');meaning.value='取而代之';meaning.dispatchEvent(new Event('input',{bubbles:true}));return true;
`);
    await evaluate(`Array.from(app.workspace.getLeavesOfType('langr-learn-panel')[0].view.containerEl.querySelectorAll('button')).at(-1).click();return true;`);
    let saved = false;
    for(let attempt=0;attempt<40&&!saved;attempt++){
        saved=await evaluate(`return (await app.vault.read(window.__leafSimple.file)).includes('取而代之');`);
        if(!saved)await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.ok(saved,'真实新词表单没有保存到文章');
    const sr = await evaluate(`
const plugin=app.plugins.plugins['obsidian-language-learner'];const item=(await plugin.lingualeaf.host.scan()).find(item=>item.path===window.__leafSimple.path);
if(!item||item.card.owner!=='spaced-repetition'||item.card.noteEntries.length!==2||item.card.sentences.length!==2||item.card.status!=='learned')throw new Error('随文表单数据丢失');
const note=await app.plugins.plugins['obsidian-spaced-repetition']._dataManager.loadNote(window.__leafSimple.file);
if(note.questionList.length!==1||!note.questionList[0].cards[0].back.includes(item.card.outline))throw new Error('真实 SR 没有正确读取闪卡或大纲');
window.__leafSimple.card=item.card;
return {srCards:note.questionList.length,multipleNotes:true,multipleSentences:true,outline:true};
`);
    results.push({name:'原表单保存完整上下文，SR 真实加载一张随文闪卡',...prepared,...sr});
    await evaluate(`app.commands.executeCommandById('obsidian-language-learner:leaf-library');return true;`);
    let table = false;
    for(let attempt=0;attempt<30&&!table;attempt++){
        table=await evaluate(`const leaf=app.workspace.getLeavesOfType('langr-data-panel')[0];return !!leaf&&app.workspace.rootSplit.containerEl.contains(leaf.view.containerEl)&&!!leaf.view.containerEl.querySelector('.n-data-table');`);
        if(!table)await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.ok(table,'单词列表不在原表格标签页');
    await evaluate(`const view=window.__leafSimple.leaf.view;app.workspace.setActiveLeaf(view.leaf,{focus:true});return true;`);
    cli('command','id=obsidian-spaced-repetition:srs-review-flashcards-in-note');
    await evaluate(`const show=Array.from(document.querySelectorAll('.sr-show-answer-button')).find(button=>button.offsetParent!==null);if(!show)throw new Error('未打开 SR 复习');show.click();return true;`);
    await evaluate(`const good=Array.from(document.querySelectorAll('.sr-good-button')).find(button=>button.offsetParent!==null);if(!good)throw new Error('SR 未显示答案');good.click();return true;`);
    // SR 持久化完成后才比较调度文本。
    for(let i=0;i<30;i++){if(await evaluate(`return (await app.vault.read(window.__leafSimple.file)).includes('<!--SR:');`))break;await new Promise(resolve=>setTimeout(resolve,80));}
    const schedule = await evaluate(`
const plugin=app.plugins.plugins['obsidian-language-learner'];const file=window.__leafSimple.file;const before=await app.vault.read(file);const start=before.indexOf('<!--SR:');const schedule=start<0?'':before.slice(start,before.indexOf('-->',start)+3);if(!schedule)throw new Error('SR 真实评分没有写入');
await plugin.lingualeaf.host.save(file,{...window.__leafSimple.card,meaning:'编辑后的语境释义'});
const after=await app.vault.read(file);if(!after.includes(schedule))throw new Error('编辑覆盖了 SR 进度');
return {schedule};
`);
    results.push({name:'保留原单词表并由 SR 评分，编辑后完整保留进度',...schedule});
    await evaluate(`const sr=document.querySelector('.sr-modal-content');const close=sr?.closest('.modal')?.querySelector('.modal-close-button,.modal-header-button');close?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));close?.click();return true;`);
    await evaluate(`app.workspace.setActiveLeaf(window.__leafSimple.leaf,{focus:true});app.commands.executeCommandById('obsidian-language-learner:leaf-learn-panel');return true;`);
    const manual = await evaluate(`
const runtime=app.plugins.plugins['obsidian-language-learner'].lingualeaf;const request=runtime.capture;
if(!request||request.file.path!==window.__leafSimple.path||request.card.text!=='')throw new Error('手工新词面板没有固定保存文章');
return {source:request.file.path};
`);
    results.push({name:'打开新词面板可手工收词，并明确固定来源文章',...manual});
    const styling=await evaluate(`
const callout=window.__leafSimple.leaf.view.containerEl.querySelector('.callout[data-callout=translation]');const style=el=>getComputedStyle(el);
if(style(callout.querySelector('.callout-title-inner')).display!=='none'||style(callout.querySelector('.callout-content')).borderLeftWidth!=='2px')throw new Error('双语样式丢失');
return {translationStyle:true};
`);
    results.push({name:'双语阅读样式仍生效',...styling});
} finally {
    await evaluate(`
const plugin=app.plugins.plugins['obsidian-language-learner'];
plugin.settings=window.__leafSimpleOriginal;plugin.lingualeaf.host.settings=plugin.settings.learning;
plugin.store.dictsChange=!plugin.store.dictsChange;delete window.__leafSimpleOriginal;
return true;
`);
}
/** 仅在所有断言通过时写入当前精简版报告 */
const report={testedAt:new Date().toISOString(),scope:'四命令、SR 唯一复习方式',results};
writeFileSync('docs/lingualeaf/runtime-smoke.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
