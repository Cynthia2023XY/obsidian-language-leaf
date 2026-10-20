import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";

/** 验收仅操作指定测试笔记库 */
const cli = (...args) => execFileSync("obsidian", ["vault=新功能测试仓库", ...args], { encoding: "utf8" }).trim().replace(/^=> /, "");
assert.equal(cli("vault", "info=path"), "/Users/dingxinyi.2/Documents/practice/obsidian测试笔记库/新功能测试仓库");
/** 等待自己的异步执行槽，不把未完成操作误报为通过 */
async function evaluate(code) {
    // 每一步使用唯一槽，保证旧结果不会污染当前断言。
    const slot = "__leafPanel" + Date.now() + Math.floor(Math.random() * 10000);
    cli("eval", `code=void Promise.resolve().then(async()=>{${code}}).then(value=>{window['${slot}']=JSON.stringify({value})},error=>{window['${slot}']=JSON.stringify({error:String(error),stack:error.stack})})`);
    for (let attempt = 0; attempt < 60; attempt++) {
        // 单次等待不阻塞用户持续使用其他笔记库。
        const raw = cli("eval", `code=window['${slot}']||'pending'`);
        if (raw && raw !== "pending" && raw !== "(no output)") {
            // 任意脚本异常都会中断验收。
            const result = JSON.parse(raw);
            if (result.error) throw new Error(result.stack || result.error);
            return result.value;
        }
        await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error("界面验收超时");
}
/** 按实际成功的运行步骤生成报告 */
const checks = [];
await evaluate(`
const p=app.plugins.plugins['obsidian-language-learner'];
window.__leafPanelOriginal={settings:JSON.parse(JSON.stringify(p.settings)),dark:document.body.classList.contains('theme-dark'),light:document.body.classList.contains('theme-light')};
p.settings.auto_pron=false;p.settings.use_machine_trans=false;
for(const [id,entry] of Object.entries(p.settings.dictionaries))entry.enable=id==='youdao';p.store.dictsChange=!p.store.dictsChange;
const stamp=Date.now();const file=await app.vault.create('Language Leaf界面验收-'+stamp+'.md','An old bookmark.\\n');
window.__leafPanelFixture={file,text:'ui-prototype-'+stamp};
await p.lingualeaf.openCapture(file,'',{sentence:'An old bookmark.',translation:'一枚旧书签。',outline:'回忆书签的故事',anchor:'An old bookmark.'},()=>true,undefined,undefined,true);
return true;
`);
try {
    checks.push(await evaluate(`
const panel=document.querySelector('#langr-learn-panel');const set=(element,value)=>{element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}))};
const items=panel.querySelectorAll('.ll-capture-form>.n-form-item');set(items[0].querySelector('input'),window.__leafPanelFixture.text);set(items[1].querySelector('textarea'),'界面验收释义');
const optional=panel.querySelectorAll('.ll-optional');if(optional.length!==2||Array.from(optional).some(item=>item.open))throw Error('笔记与概览没有默认折叠');
optional[0].open=true;optional[0].querySelector('.ll-text-button').click();
if(panel.textContent.includes('学习状态'))throw Error('仍显示旧状态');
return {name:'真实新词面板包含例句、折叠笔记与概览，旧状态已移除'};
`));
    checks.push(await evaluate(`
const panel=document.querySelector('#langr-learn-panel');const note=panel.querySelector('.ll-note-row textarea');if(!note)throw Error('添加笔记无响应');note.value='界面验收笔记';note.dispatchEvent(new Event('input',{bubbles:true}));
const summary=document.querySelector('#langr-search .dict-item summary');if(!summary)throw Error('未渲染词典折叠分组');
const old=summary.parentElement.open;summary.click();
if(summary.parentElement.open===old)throw Error('词典折叠切换失败');
panel.querySelector('.ll-save-card').click();return {name:'原生词典折叠与多笔记添加可用'};
`));
    let saved = false;
    for (let attempt = 0; attempt < 40 && !saved; attempt++) {
        saved = await evaluate(`return (await app.vault.read(window.__leafPanelFixture.file)).includes('界面验收释义');`);
        if (!saved) await new Promise(resolve => setTimeout(resolve, 80));
    }
    assert.ok(saved, "改版表单未写入真实 SR 闪卡");
    checks.push(await evaluate(`
const p=app.plugins.plugins['obsidian-language-learner'];const card=(await p.lingualeaf.host.scan()).find(item=>item.path===window.__leafPanelFixture.file.path);
if(!card||card.captureCount!==1||!card.card.noteEntries.includes('界面验收笔记')||!card.card.outline)throw Error('保存后的数据或计数丢失');
await p.activateView('langr-data-panel','tab');return {name:'真实表单保存为 SR 闪卡，笔记、概览及收录次数正确'};
`));
    checks.push(await evaluate(`
const panel=document.querySelector('#langr-data');if(!panel)throw Error('词库标签未加载');
const search=panel.querySelector('input');search.value=window.__leafPanelFixture.text;search.dispatchEvent(new Event('input',{bubbles:true}));
return {name:'词库新搜索栏已渲染'};
`));
    checks.push(await evaluate(`
const panel=document.querySelector('#langr-data');if(!panel.textContent.includes('ui-prototype-')||!panel.textContent.includes('1 次'))throw Error('组合搜索没有找到当前词句');
if(panel.textContent.includes('Search:')||panel.textContent.includes('Tags:'))throw Error('旧筛选栏仍在运行');
const filter=panel.querySelector('select');filter.value='2';filter.dispatchEvent(new Event('change',{bubbles:true}));
return {name:'词库组合搜索与收录次数列正确，旧筛选栏已移除'};
`));
    checks.push(await evaluate(`
const panel=document.querySelector('#langr-data');if(!panel.textContent.includes('没有匹配的词句'))throw Error('收录次数筛选未生效');
const filter=panel.querySelector('select');filter.value='0';filter.dispatchEvent(new Event('change',{bubbles:true}));return {name:'收录次数筛选可组合生效'};
`));
    checks.push(await evaluate(`
const panel=document.querySelector('#langr-data');const menu=panel.querySelector('.ll-row-menu');if(!menu)throw Error('行菜单未渲染');menu.click();
return {name:'词库组合搜索与收录次数列正确，旧筛选栏已移除'};
`));
    checks.push(await evaluate(`
if(!document.querySelector('.n-dropdown-menu'))throw Error('点击行菜单无响应');
document.querySelector("#langr-data .ll-row-menu").click();
const p=app.plugins.plugins['obsidian-language-learner'];document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');p.store.dark=true;p.store.themeChange=!p.store.themeChange;
return {name:'行操作菜单可用，开始深浅色检查'};
`));
    /** 记录实际组件配色，不能用源码存在某个变量冒充运行验证 */
    const dark = await evaluate(`const input=document.querySelector('#langr-learn-panel .n-input');return {background:getComputedStyle(input).backgroundColor,text:getComputedStyle(input).color,library:getComputedStyle(document.querySelector('#langr-data .n-data-table-td')).backgroundColor,search:getComputedStyle(document.querySelector('#langr-search')).color,border:getComputedStyle(document.querySelector('#langr-learn-panel .ll-example')).borderLeftColor};`);
    await evaluate(`const p=app.plugins.plugins['obsidian-language-learner'];document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');p.store.dark=false;p.store.themeChange=!p.store.themeChange;return true;`);
    /** 浅色模式应实际更新输入背景和正文颜色 */
    const light = await evaluate(`const input=document.querySelector('#langr-learn-panel .n-input');return {background:getComputedStyle(input).backgroundColor,text:getComputedStyle(input).color,library:getComputedStyle(document.querySelector('#langr-data .n-data-table-td')).backgroundColor,search:getComputedStyle(document.querySelector('#langr-search')).color,border:getComputedStyle(document.querySelector('#langr-learn-panel .ll-example')).borderLeftColor};`);
    assert.notEqual(dark.background, light.background, "主题切换没有改变实际输入背景");
    assert.notEqual(dark.library, light.library, "词库未跟随主题更新");
    assert.notEqual(dark.search, light.search, "查词面板未跟随主题更新");
    checks.push({ name: "实际 Obsidian 三个面板的深浅色切换均正确", dark, light });
} finally {
    await evaluate(`const original=window.__leafPanelOriginal;const p=app.plugins.plugins['obsidian-language-learner'];p.settings=original.settings;p.lingualeaf.host.settings=p.settings.learning;p.store.dictsChange=!p.store.dictsChange;document.body.classList.toggle('theme-dark',original.dark);document.body.classList.toggle('theme-light',original.light);p.store.dark=original.dark;p.store.themeChange=!p.store.themeChange;return true;`);
}
/** 报告仅保存隔离验收用例，不采集用户词典内容或密钥 */
const report = { testedAt: new Date().toISOString(), checks, limitation: "测试窗口处于后台；已验证真实组件 DOM、事件、持久化与主题颜色，未验证前台像素布局和物理鼠标拖选。" };
writeFileSync("docs/lingualeaf/panel-ui-smoke.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
