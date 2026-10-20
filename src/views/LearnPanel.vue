<template>
    <div id="langr-learn-panel" class="ll-panel">
        <NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
            <header class="ll-panel-heading"><PanelIcon name="notebook-pen" /><span>新词</span></header>
            <p v-if="!leafCapture" class="ll-empty">请先打开要保存词句的 Markdown 文章。</p>
            <NForm class="ll-capture-form" :model="model" label-placement="top" :rules="rules" require-mark-placement="right-hanging" @submit.prevent="submit">
                <NFormItem label="表达" path="expression"><NInput size="small" v-model:value="model.expression" placeholder="单词或短语" /></NFormItem>
                <NFormItem label="含义" path="meaning"><NInput size="small" type="textarea" :autosize="{ minRows: 2 }" v-model:value="model.meaning" placeholder="简短的语境释义" /></NFormItem>
                <div class="ll-capture-meta">
                    <NFormItem label="类别" path="t"><NRadioGroup v-model:value="model.t"><NRadio value="WORD">单词</NRadio><NRadio value="PHRASE">短语</NRadio></NRadioGroup></NFormItem>
                    <div class="ll-count-summary"><span class="ll-field-label">收录次数</span><span>{{ captureCount ? `已收录 ${captureCount} 次` : '尚未收录' }}</span></div>
                </div>
                <NFormItem label="标签" path="tags"><NSelect size="small" v-model:value="model.tags" filterable multiple tag placeholder="输入或选择标签" :loading="tagLoading" :options="tagOptions" @search="tagSearch" /></NFormItem>
                <section class="ll-example-section" aria-label="例句">
                    <div class="ll-section-heading"><span>例句</span><button type="button" class="ll-text-button" @click="addSentence"><PanelIcon name="plus" />添加</button></div>
                    <div v-for="(sentence, index) in model.sentences" :key="index" class="ll-example">
                        <div class="ll-example-heading"><span class="ll-muted">例句 {{ index + 1 }}</span><button type="button" class="ll-icon-button" :aria-label="`删除例句 ${index + 1}`" @click="model.sentences.splice(index, 1)"><PanelIcon name="minus" /></button></div>
                        <NFormItem label="原文" :path="`sentences[${index}].text`" :rule="sourceRule"><NInput size="small" type="textarea" v-model:value="sentence.text" placeholder="原文例句" :autosize="{ minRows: 2 }" /></NFormItem>
                        <NFormItem label="译文" :show-feedback="false"><NInput size="small" type="textarea" v-model:value="sentence.trans" placeholder="译文（可选）" autosize /></NFormItem>
                        <NFormItem label="来源" :show-feedback="false"><NInput size="small" v-model:value="sentence.origin" placeholder="例句出处（可选）" /></NFormItem>
                    </div>
                    <p v-if="!model.sentences.length" class="ll-muted ll-small">添加例句，帮助回忆使用语境。</p>
                </section>
                <details class="ll-optional"><summary><PanelIcon name="chevron-right" />笔记<span class="ll-muted">{{ model.notes.length ? `${model.notes.length} 条` : '可选' }}</span></summary>
                    <div v-for="(_, index) in model.notes" :key="index" class="ll-note-row"><NInput size="small" type="textarea" v-model:value="model.notes[index]" placeholder="补充用法或联想…" autosize /><button type="button" class="ll-icon-button" :aria-label="`删除笔记 ${index + 1}`" @click="model.notes.splice(index, 1)"><PanelIcon name="minus" /></button></div>
                    <button type="button" class="ll-text-button" @click="addNote"><PanelIcon name="plus" />添加笔记</button>
                </details>
                <details v-if="leafCapture" class="ll-optional lingualeaf-outline-field"><summary><PanelIcon name="chevron-right" />文章概览<span class="ll-muted">收录时快照</span></summary><NInput size="small" type="textarea" v-model:value="leafOutline" placeholder="文章内容概览（可选）" autosize /></details>
                <div class="ll-capture-footer"><span class="ll-muted ll-small">随文保存 · SR 闪卡</span><NButton class="ll-save-card" size="small" type="primary" attr-type="submit" :loading="submitLoading" :disabled="!leafCapture">{{ successing ? '已保存' : failing ? '重试保存' : '保存闪卡' }}</NButton></div>
            </NForm>
        </NConfigProvider>
    </div>
</template>

<script setup lang="ts">
import { Notice } from "obsidian";
import { ref, shallowRef, computed, getCurrentInstance, onUnmounted } from "vue";
import { NForm, NFormItem, NInput, NRadio, NRadioGroup, NButton, NSelect, NConfigProvider, darkTheme } from "naive-ui";
import type { SelectOption } from "naive-ui";
import type Plugin from "@/plugin";
import type { ExpressionInfo } from "@/lingualeaf/panel-model";
import type { PanelCapture } from "@/lingualeaf/runtime";
import { t } from "@/lang/helper";
import { useEvent } from "@/utils/use";
import { search } from "@dict/youdao/engine";
import store from "@/store";
import PanelIcon from "../component/PanelIcon.vue";
import { usePanelTheme } from "../lingualeaf/panel-theme";

/** 当前新词面板所属插件 */
const plugin = getCurrentInstance().appContext.config.globalProperties.plugin as Plugin;
/** 固定保存文章的收词请求，不能被 Vue 转为另一份代理身份 */
const leafCapture = shallowRef<PanelCapture | null>(null);
/** 原文大纲的收录快照 */
const leafOutline = ref("");
/** 与原表单相同的词句、标签、笔记和例句模型 */
const model = ref<ExpressionInfo>({ expression: "", meaning: "", t: "WORD", tags: [], notes: [], sentences: [] });
/** 隔离连续查询和关闭面板后的异步翻译响应 */
let lookupSequence = 0;
/** 自动适配 Obsidian 的明暗主题 */
const theme = computed(() => store.dark ? darkTheme : null);
/** 表单与另外两个面板使用同一组宿主语义色 */
const themeOverrides = usePanelTheme();
/** 表单字段验证规则 */
const rules = { expression: { required: true, trigger: ["blur", "input"], message: t("Please input a word/phrase") }, meaning: { required: true, trigger: ["blur", "input"], message: t("A short definition is needed") } };
/** 例句的原文字段不得为空 */
const sourceRule = { required: true, trigger: ["blur", "input"], message: "请填写原文例句" };
/** 当前词句已确认收录的次数，查询和编辑不额外计数 */
const captureCount = ref(0);
/** 标签输入的候选集合 */
const tagOptions = ref<SelectOption[]>([]);
/** 标签扫描期间的加载状态 */
const tagLoading = ref(false);
/** 提交期间阻止重复保存 */
const submitLoading = ref(false);
/** 保存成功的原表单图标状态 */
const successing = ref(false);
/** 保存失败的原表单图标状态 */
const failing = ref(false);
/** 清理反馈图标的定时器 */
let feedbackTimer: ReturnType<typeof setTimeout>;

/** 在原动态输入组件中新增一条例句 */
function addSentence(): void { model.value.sentences.push({ text: "", trans: "", origin: "" }); }
/** 新增一条独立笔记，保留原有多笔记能力 */
function addNote(): void { model.value.notes.push(""); }
/** 从当前随文词库读取标签候选，不读取旧数据库 */
async function tagSearch(query: string): Promise<void> {
    tagLoading.value = true;
    try {
        // 标签只来自当前已经持久化的 SR 词条。
        const cards = await plugin.lingualeaf.host.scan();
        tagOptions.value = [...new Set(cards.flatMap(item => item.card.tags || []))].filter(tag => tag.includes(query)).map(value => ({ label: value, value }));
    } finally { tagLoading.value = false; }
}
/** 固定文章来源并填充原表单；优先使用已有中文对照 */
async function fill(request?: PanelCapture): Promise<void> {
    // 后发查询会使旧翻译响应失效。
    const sequence = ++lookupSequence;
    leafCapture.value = request || null;
    model.value = request ? JSON.parse(JSON.stringify(request.model)) : { expression: "", meaning: "", t: "WORD", tags: [], notes: [], sentences: [] };
    leafOutline.value = request?.card.outline || "";
    captureCount.value = request?.captureCount || 0;
    if (!request || !plugin.settings.use_machine_trans || !request.card.language.startsWith("en") || !model.value.sentences[0]?.text || model.value.sentences[0].trans) return;
    try {
        // 原文缺少译文且用户允许机器翻译时，沿用有道的段落翻译能力。
        const response = await search(model.value.sentences[0].text);
        if (sequence !== lookupSequence || !request.valid() || model.value.sentences[0]?.trans) return;
        // 第三方结果只填充纯文本，不把 HTML 插入笔记。
        const html = (response?.result as any)?.translation;
        if (typeof html === "string") model.value.sentences[0].trans = new DOMParser().parseFromString(html, "text/html").querySelectorAll("p")[1]?.textContent || "";
    } catch { /* 网络失败不阻止用户手工收录 */ }
}
/** 所有提交都保存到指定文章的 SR 闪卡，并保留当前 SR 调度注释 */
async function submit(): Promise<void> {
    if (submitLoading.value) return;
    if (!leafCapture.value) { new Notice("请先打开要保存词句的 Markdown 文章，再打开新词面板"); return; }
    if (!model.value.expression?.trim() || !model.value.meaning?.trim()) { new Notice("请填写词句和释义"); return; }
    submitLoading.value = true; successing.value = false; failing.value = false;
    try {
        await plugin.lingualeaf.saveCapture(leafCapture.value, JSON.parse(JSON.stringify(model.value)), leafOutline.value);
        captureCount.value = leafCapture.value.captureCount;
        successing.value = true;
    } catch (error) { failing.value = true; new Notice(error instanceof Error ? error.message : String(error)); }
    finally {
        submitLoading.value = false; clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => { successing.value = false; failing.value = false; }, 1600);
    }
}
useEvent(window, "obsidian-langr-search", event => { void fill(event.detail.leafCapture); });
useEvent(window, "lingualeaf-clear-capture", () => { void fill(); });
onUnmounted(() => { ++lookupSequence; clearTimeout(feedbackTimer); });
void fill(plugin.lingualeaf.capture);
</script>
