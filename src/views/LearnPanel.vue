<template>
	<div id="langr-learn-panel">
		<NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
			<!-- <NThemeEditor> -->
			<p v-if="!leafCapture">请先打开要保存词句的 Markdown 文章，再打开新词面板。</p>
            <NForm :model="model" label-placement="top" label-width="auto" :rules="rules"
				require-mark-placement="right-hanging">
				<!-- 一个单词或短语字符串 -->
				<NFormItem :label="t('Expression')" :label-style="labelStyle" path="expression">
					<NInput size="small" v-model:value="model.expression" :placeholder="t('A word or a phrase')" />
				</NFormItem>
				<!-- 单词或短语的含义(精简) -->
				<NFormItem :label="t('Meaning')" :label-style="labelStyle" path="meaning">
					<NInput size="small" v-model:value="model.meaning" :placeholder="t('A short definition')"
						type="textarea" autosize />
				</NFormItem>
				<!-- 类别，可以是Word或Phrase -->
				<NFormItem :label="t('Type')" :label-style="labelStyle" path="t">
					<NRadioGroup v-model:value="model.t">
						<NRadio value="WORD">{{ t("Word") }}</NRadio>
						<NRadio value="PHRASE">{{ t("Phrase") }}</NRadio>
					</NRadioGroup>
				</NFormItem>
				<!-- 当前单词的学习状态 -->
				<NFormItem :label="t('Status')" :label-style="labelStyle" path="status">
					<NRadioGroup v-model:value="model.status" size="small">
						<NRadioButton v-for="(s, i) in status" :value="i">
							{{ s.text }}
						</NRadioButton>
					</NRadioGroup>
				</NFormItem>
				<!-- 加一些tag, 可以用来搜索 -->
				<NFormItem :label="t('Tags')" :label-style="labelStyle" path="tags">
					<NSelect size="small" v-model:value="model.tags" filterable multiple tag
						:placeholder="t('Input or select some tags')" :loading="tagLoading" :options="tagOptions"
						@search="tagSearch"></NSelect>
				</NFormItem>
				<!-- 可选,可以记多条笔记 -->
				<NFormItem :label="t('Notes')" :label-style="labelStyle" path="tags">
					<NDynamicInput v-model:value="model.notes" :create-button-props="{ size: 'small' }">
						<template #create-button-default>
							{{ t("Create") }}
						</template>
						<template #="{ index, value }">
							<NInput size="small" type="textarea" :placeholder="t('Write a new note')"
								v-model:value="model.notes[index]" />
						</template>
					</NDynamicInput>
				</NFormItem>
				<!-- 可选,例句也可以记多条 -->
				<div style="margin-bottom: 8px">
					<label for="Sentences" :style="[labelStyle]">{{
						t("Sentences")
					}}</label>
				</div>
				<NDynamicInput v-model:value="model.sentences" :create-button-props="{ size: 'small' }"
					:on-create="onCreateSentence">
					<template #create-button-default>
						{{ t("Create") }}
					</template>
					<template #="{ index, value }">
						<div style="display: flex;
                                flex-direction: column;
                                flex: 1;
                                border: 2px solid gray;
                                border-radius: 3px;
                                padding: 3px;
                            ">
							<NFormItem :show-label="false" :path="`sentences[${index}].text`" :rule="sourceRule">
								<NInput size="small" type="textarea" v-model:value="model.sentences[index].text"
									:placeholder="t('Origin sentence')" :autosize="{ minRows: 1, maxRows: 3 }" />
							</NFormItem>
							<NFormItem :show-feedback="false" :show-label="false" :path="`sentences[${index}].trans`">
								<NInput size="small" type="textarea" v-model:value="model.sentences[index].trans"
									:placeholder="t('Translation (Optional)')" :autosize="{ minRows: 1, maxRows: 3 }" />
							</NFormItem>
							<NFormItem :show-feedback="false" :show-label="false" :path="`sentences[${index}].origin`">
								<NInput size="small" type="textarea" v-model:value="
									model.sentences[index].origin
								" :placeholder="t('Origin (Optional)')" :autosize="{ minRows: 1, maxRows: 3 }" />
							</NFormItem>
						</div>
					</template>
				</NDynamicInput>
                <!-- 仅原生文章收录增加大纲字段，其余沿用原表单控件 -->
                <NFormItem v-if="leafCapture" class="lingualeaf-outline-field" label="文章概览（收录时快照）">
                    <NInput size="small" type="textarea" v-model:value="leafOutline" autosize />
                </NFormItem>
			</NForm>
			<!-- 提交按钮 -->
			<div style="margin-top: 10px">
				<NButton size="small" style="--n-width: 100%" attr-type="submit" @click="submit"
					:loading="submitLoading" :disabled="!leafCapture">
					<NIconWrapper v-if="successing" :size="18" :border-radius="6" style="margin-right: 6px;">
						<NIcon :size="16">
							<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16">
								<g fill="none">
									<path d="M14.046 3.486a.75.75 0 0 1-.032 1.06l-7.93 7.474a.85.85 0 0 1-1.188-.022l-2.68-2.72a.75.75 0 1 1 1.068-1.053l2.234 2.267l7.468-7.038a.75.75 0 0 1 1.06.032z" fill="currentColor">
									</path>
								</g>
							</svg>
						</NIcon>
					</NIconWrapper>
					<NIconWrapper v-if="failing" :size="18" :border-radius="6" style="margin-right: 6px;" color="#DE5959">
						<NIcon :size="16">
							<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16">
								<g fill="none">
									<path d="M2.397 2.554l.073-.084a.75.75 0 0 1 .976-.073l.084.073L8 6.939l4.47-4.47a.75.75 0 1 1 1.06 1.061L9.061 8l4.47 4.47a.75.75 0 0 1 .072.976l-.073.084a.75.75 0 0 1-.976.073l-.084-.073L8 9.061l-4.47 4.47a.75.75 0 0 1-1.06-1.061L6.939 8l-4.47-4.47a.75.75 0 0 1-.072-.976l.073-.084l-.073.084z" fill="currentColor">
									</path>
								</g>
							</svg>
						</NIcon>
					</NIconWrapper>
					
					{{ t("Submit") }}
				</NButton>
			</div>
			<!-- </NThemeEditor> -->
		</NConfigProvider>
	</div>
</template>

<script setup lang="ts">
import { Notice } from "obsidian";
import { ref, shallowRef, computed, getCurrentInstance, onUnmounted } from "vue";
import type { CSSProperties } from "vue";
import { NIcon, NIconWrapper, NForm, NFormItem, NInput, NRadio, NRadioButton, NRadioGroup, NButton, NDynamicInput, NSelect, NConfigProvider, darkTheme } from "naive-ui";
import type { GlobalThemeOverrides, SelectOption } from "naive-ui";
import type Plugin from "@/plugin";
import type { ExpressionInfo } from "@/lingualeaf/panel-model";
import type { PanelCapture } from "@/lingualeaf/runtime";
import { t } from "@/lang/helper";
import { useEvent } from "@/utils/use";
import { search } from "@dict/youdao/engine";
import store from "@/store";

/** 当前新词面板所属插件 */
const plugin = getCurrentInstance().appContext.config.globalProperties.plugin as Plugin;
/** 固定保存文章的收词请求，不能被 Vue 转为另一份代理身份 */
const leafCapture = shallowRef<PanelCapture | null>(null);
/** 原文大纲的收录快照 */
const leafOutline = ref("");
/** 与原表单相同的词句、标签、笔记和例句模型 */
const model = ref<ExpressionInfo>({ expression: "", meaning: "", status: 1, t: "WORD", tags: [], notes: [], sentences: [] });
/** 隔离连续查询和关闭面板后的异步翻译响应 */
let lookupSequence = 0;
/** 自动适配 Obsidian 的明暗主题 */
const theme = computed(() => store.dark ? darkTheme : null);
/** 沿用原新词面板的控件字号、间距与动态输入布局 */
const themeOverrides: GlobalThemeOverrides = { Form: { labelFontSizeTopMedium: "15px", feedbackFontSizeMedium: "13px", blankHeightMedium: "5px", feedbackHeightMedium: "22px" }, Radio: { buttonBorderRadius: "5px", fontSizeMedium: "13px", fontSizeSmall: "13px", buttonHeightSmall: "22px" }, Input: { fontSizeSmall: "12px", paddingSmall: "0 5px" }, DynamicInput: { actionMargin: "0 0 0 5px" } };
/** 表单字段验证规则 */
const rules = { expression: { required: true, trigger: ["blur", "input"], message: t("Please input a word/phrase") }, meaning: { required: true, trigger: ["blur", "input"], message: t("A short definition is needed") } };
/** 例句的原文字段不得为空 */
const sourceRule = { required: true, trigger: ["blur", "input"], message: "请填写原文例句" };
/** 保持原表单标签的强调方式 */
const labelStyle: CSSProperties = { fontWeight: "bold" };
/** 词句的五档学习状态，与 SR 调度进度互相独立 */
const status = ["Ignore", "Learning", "Familiar", "Known", "Learned"].map(key => ({ text: t(key) }));
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
function onCreateSentence() { return { text: "", trans: "", origin: "" }; }
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
    model.value = request ? JSON.parse(JSON.stringify(request.model)) : { expression: "", meaning: "", status: 1, t: "WORD", tags: [], notes: [], sentences: [] };
    leafOutline.value = request?.card.outline || "";
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
    if (!leafCapture.value) { new Notice("请先打开要保存词句的 Markdown 文章，再打开新词面板"); return; }
    if (!model.value.expression?.trim() || !model.value.meaning?.trim()) { new Notice("请填写词句和释义"); return; }
    submitLoading.value = true; successing.value = false; failing.value = false;
    try {
        await plugin.lingualeaf.saveCapture(leafCapture.value, JSON.parse(JSON.stringify(model.value)), leafOutline.value);
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

<style lang="scss">
#langr-learn-panel {
	padding-bottom: 18px;

	/* 留出例句与文章概览之间的阅读间距 */
	.lingualeaf-outline-field {
		margin-top: 16px;
	}

	.n-input {
		margin: 1px 0;
	}

	.n-dynamic-input .n-button-group {
		flex-direction: column;

		button {
			height: 26px;
			width: 26px;

			&:nth-child(1) {
				border-top-left-radius: 34px !important;
				border-top-right-radius: 34px !important;
				border-bottom-left-radius: 0 !important;
				border-bottom-right-radius: 0 !important;
			}

			&:nth-child(2) {
				border-top-left-radius: 0 !important;
				border-top-right-radius: 0 !important;
				border-bottom-left-radius: 34px !important;
				border-bottom-right-radius: 34px !important;
			}
		}
	}
}
</style>
