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
/** 每轮只建立本次划词验收文件，不读取其他库 */
const fixture = await evaluate(`
// 当前 Obsidian 的模态框关闭按钮使用 pointerdown，先关闭本次 SR 验收留下的遮罩。
if(document.hidden)throw new Error('请先将新功能测试仓库窗口置于可见状态，后台窗口会暂停 Obsidian 原生阅读渲染');
const close=document.querySelector('#sr-modal-view .modal-header-button');close?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
const path='Language Leaf划词回归-'+Date.now()+'.md';
const file=await app.vault.create(path,'An old bookmark lay on the bedside table, beside a narrow slip of paper.');
const leaf=app.workspace.getLeaf(false);await leaf.openFile(file);await app.workspace.revealLeaf(leaf);app.workspace.setActiveLeaf(leaf,{focus:true});
await app.plugins.plugins['language-leaf'].lingualeaf.enter(leaf.view);
if(!app.plugins.plugins['language-leaf'].lingualeaf.host.sessions.has(leaf.view))throw new Error('测试文章尚未进入学习模式');
window.__shiftRegression={path,leaf};return path;
`);
/** 等待原生阅读段落渲染，不插入替代正文 */
let ready=false;
for(let i=0;i<50&&!ready;i++){
    ready=await evaluate(`return !!window.__shiftRegression.leaf.view.containerEl.querySelector('.markdown-preview-view p');`);
    if(!ready)await new Promise(resolve=>setTimeout(resolve,60));
}
assert.ok(ready,'原生段落未渲染');
/** 实际 DOM 事件覆盖按下、移动和松开，查询结果只记录在本地 */
const result=await evaluate(`
const runtime=app.plugins.plugins['language-leaf'].lingualeaf;
const view=window.__shiftRegression.leaf.view;
const paragraph=view.containerEl.querySelector('.markdown-preview-view p');
paragraph.scrollIntoView({block:'center'});
const text=paragraph.firstChild;const value=text.textContent;const doc=view.containerEl.ownerDocument;
const original=runtime.queryActive;const modifier=runtime.host.settings.modifier;
const results=[];let captured='';runtime.queryActive=async()=>{captured=doc.getSelection().toString()};runtime.host.settings.modifier='shiftKey';
const point=offset=>{const range=doc.createRange();range.setStart(text,offset);range.setEnd(text,offset+1);const rect=range.getBoundingClientRect();return {clientX:rect.left+.1,clientY:rect.top+rect.height/2}};
const dispatch=(type,offset,buttons)=>paragraph.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',shiftKey:true,button:0,buttons,...point(offset)}));
try{
    for(const sample of [{word:'narrow slip',reverse:false},{word:'old bookmark',reverse:false},{word:'narrow slip',reverse:true}]){
        const from=value.indexOf(sample.word);const to=from+sample.word.length;
        doc.getSelection().collapse(text,0);captured='';
        dispatch('pointerdown',sample.reverse?to:from,1);
        dispatch('pointermove',sample.reverse?from:to,1);
        dispatch('pointerup',sample.reverse?from:to,0);
        const selected=doc.getSelection().toString();
        if(selected!==sample.word||captured!==sample.word)throw new Error('划词不准确：'+JSON.stringify({sample,selected,captured}));
        results.push({word:sample.word,reverse:sample.reverse,selected,captured});
    }
    runtime.host.stop(view,false);
    doc.getSelection().collapse(text,0);dispatch('pointerdown',value.indexOf('narrow'),1);
    if(doc.getSelection().anchorOffset!==0)throw new Error('退出后仍拦截 Shift');
    await runtime.enter(view);
    return {cases:results,listenersRemovedOnExit:true};
}finally{runtime.queryActive=original;runtime.host.settings.modifier=modifier;}
`);
/** 验收报告明确区分 DOM 事件和真实硬件输入 */
const report={testedAt:new Date().toISOString(),fixture,method:'Obsidian DOM PointerEvent with actual caret coordinates; physical mouse not verified',...result};
writeFileSync('docs/lingualeaf/selection-smoke.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
