<template>
    <div id="langr-data" class="ll-panel">
        <NConfigProvider :theme="theme" :theme-overrides="themeConfig">
            <header class="ll-library-heading"><h2>单词列表 <span class="ll-muted ll-small">{{ data.length }}</span></h2><span class="ll-muted ll-small">收录于原文 · 使用 SR 复习</span></header>
            <div class="ll-library-filters">
                <NInput size="small" v-model:value="searchText" aria-label="搜索词句" placeholder="搜索表达、释义或来源…" clearable />
                <select v-model.number="minimumCount" aria-label="收录次数筛选"><option :value="0">全部收录次数</option><option :value="2">收录 2 次及以上</option><option :value="3">收录 3 次及以上</option><option :value="5">收录 5 次及以上</option></select>
                <NSelect size="small" v-model:value="selectedTags" :options="tagOptions" multiple clearable placeholder="全部标签" aria-label="标签筛选" />
                <select v-model="mode" aria-label="标签匹配方式"><option value="and">匹配全部标签</option><option value="or">匹配任一标签</option></select>
            </div>
            <NDataTable size="small" :loading="loading" :data="filteredData" :columns="columns" :row-key="makeRowKey" :pagination="pagination" :bordered="false" :single-line="true" :scroll-x="760" />
            <p class="ll-muted ll-small" aria-live="polite">{{ filteredData.length ? `共 ${filteredData.length} 条词句` : '没有匹配的词句' }}</p>
        </NConfigProvider>
    </div>
</template>
<script setup lang="ts">
import { moment, TFile, Notice, Modal } from "obsidian";
import { h, ref, reactive, computed, watch, onMounted, onUnmounted, getCurrentInstance } from "vue";
import { NConfigProvider, NDataTable, NTag, NInput, NButton, NSelect, NDropdown, darkTheme } from "naive-ui";
import type { DataTableColumns } from "naive-ui";
import type { IndexedCard } from "../lingualeaf/host";
import type PluginType from "../plugin";
import { action } from "../lingualeaf/ui";
import { cardToForm } from "../lingualeaf/panel-model";
import { usePanelTheme } from "../lingualeaf/panel-theme";
import PanelIcon from "../component/PanelIcon.vue";

/** 每行保留独立的文章闪卡，跨文只共享累计次数 */
interface Row {
    /** 卡片稳定身份 */
    key: string;
    /** 原文位置和内容 */
    native: IndexedCard;
    /** 表达题面 */
    expr: string;
    /** 跨文章累计主动收录次数 */
    captureCount: number;
    /** 当前语境释义 */
    meaning: string;
    /** 用户标签 */
    tags: string[];
    /** 来源最后修改日期，不冒充历史收录日期 */
    date: string;
}
/** 当前词库标签页所属插件 */
const plugin = getCurrentInstance().appContext.config.globalProperties.plugin as PluginType;
/** 组件配色跟随 Obsidian 主题与主题 CSS */
const themeConfig = usePanelTheme();
/** 保留组件库本身的深浅色行为 */
const theme = computed(() => plugin.store.dark ? darkTheme : null);
/** 已加载的随文词句 */
const data = ref<Row[]>([]);
/** 扫描过程中的加载提示 */
const loading = ref(true);
/** 限定最后一次扫描才能更新页面 */
let loadSequence = 0;
/** 搜索表达、释义和来源的关键字 */
const searchText = ref("");
/** 多标签筛选保留所有与任一两种模式 */
const mode = ref("and");
/** 用户已选中的标签 */
const selectedTags = ref<string[]>([]);
/** 只看反复收录的词句 */
const minimumCount = ref(0);
/** 从已加载词句生成当前可用标签 */
const tagOptions = computed(() => [...new Set(data.value.flatMap(row => row.tags))].sort().map(value => ({ label: value, value })));
/** 组合搜索、频次和标签条件，不依赖表格内部的重复过滤状态 */
const filteredData = computed(() => {
    // 空白和大小写不会影响词库检索。
    const query = searchText.value.trim().toLocaleLowerCase();
    return data.value.filter(row => (!query || `${row.expr} ${row.meaning} ${row.native.path}`.toLocaleLowerCase().includes(query)) && row.captureCount >= minimumCount.value &&
        (!selectedTags.value.length || (mode.value === "and" ? selectedTags.value.every(tag => row.tags.includes(tag)) : selectedTags.value.some(tag => row.tags.includes(tag)))));
});
/** 翻页仍使用原组件，在筛选改变后回到第一页 */
const pagination = reactive({ page: 1, pageSize: 10, onChange: (page: number) => { pagination.page = page; } });
watch([searchText, minimumCount, selectedTags, mode], () => { pagination.page = 1; }, { deep: true });
/** 保留跨来源闪卡的独立行身份 */
function makeRowKey(row: Row): string { return row.key; }
/** 扫描当前随文数据，保留用户正在使用的筛选条件 */
async function loadData(): Promise<void> {
    // 较慢的旧结果不能覆盖用户随后保存的词条。
    const sequence = ++loadSequence;
    loading.value = true;
    try {
        // 不从旧数据库或评分状态生成额外的词库数据。
        const cards = await plugin.lingualeaf.host.scan();
        if (sequence !== loadSequence) return;
        data.value = cards.map(item => {
            // 当前文章内容是释义和例句的权威来源。
            const form = cardToForm(item.card, item.path);
            // 日期明确表示文件更新，不推测首次收录时间。
            const file = plugin.app.vault.getAbstractFileByPath(item.path);
            return { key: item.card.id, native: item, expr: form.expression, captureCount: item.captureCount || 0, meaning: form.meaning, tags: form.tags,
                date: file instanceof TFile ? moment(file.stat.mtime).format("YYYY-MM-DD") : "" };
        });
        pagination.page = Math.min(pagination.page, Math.max(1, Math.ceil(filteredData.value.length / pagination.pageSize)));
    } catch (error) { new Notice(String(error)); }
    finally { if (sequence === loadSequence) loading.value = false; }
}
/** 删除操作沿用先备份、后删除原文卡片的已有保护 */
function confirmDelete(row: Row): void {
    // 快照行没有可供修改的文章，不提供删除入口。
    const item = row.native;
    if (!item.path) return;
    // 确认仅用于破坏性操作，编辑始终使用右侧新词面板。
    const confirm = new Modal(plugin.app);
    confirm.contentEl.createEl("h2", { text: `删除：${item.card.text}` });
    confirm.contentEl.createEl("p", { text: `将备份 ${item.path} 并删除该卡片及 SR 调度，全局词条保留。` });
    action(confirm.contentEl, "备份并删除本文卡片", async () => {
        // 删除前重新定位，防止改名或关闭文章后误删其他文件。
        const file = plugin.app.vault.getAbstractFileByPath(item.path);
        if (!(file instanceof TFile)) throw new Error("来源文章已删除");
        await plugin.lingualeaf.host.removeCard(file, item.card.id);
        confirm.close(); await loadData();
    });
    confirm.open();
}
/** 轻量菜单集中呈现来源、编辑和删除，不重复铺满每一行 */
function rowAction(key: string, row: Row): void {
    if (key === "source") void plugin.app.workspace.openLinkText(row.native.path, "", false);
    if (key === "edit") void plugin.lingualeaf.editCard(row.native.path, row.native.card).catch(error => new Notice(String(error)));
    if (key === "delete") confirmDelete(row);
}
/** 表达与来源组成信息层级，弱化标签与日期，累计次数可排序 */
const columns = computed<DataTableColumns<Row>>(() => [
    { type: "expand", width: 32, expandable: row => !!(row.native.card.sentence || row.native.card.notes || row.native.card.outline), renderExpand: row => {
        // 展开区保留多笔记、多例句、译文及概览，不丢失原有信息。
        const form = cardToForm(row.native.card, row.native.path);
        return h("div", { class: "ll-word-details" }, [
            ...form.sentences.map(sentence => h("div", { class: "ll-word-example" }, [h("p", sentence.text), h("p", { class: "ll-muted" }, sentence.trans), h("p", { class: "ll-muted ll-small" }, sentence.origin)])),
            ...form.notes.map(note => h("p", note)), row.native.card.outline ? h("p", `文章概览：${row.native.card.outline}`) : null,
        ]);
    } },
    { title: "表达 / 来源", key: "expr", minWidth: 210, sorter: "default", render: row => h("div", { class: "ll-expression-cell" }, [
        h("div", { class: "ll-expression-title" }, [h("span", row.expr), h("span", { class: "ll-muted ll-small" }, `${row.native.card.language.toUpperCase()} · ${row.native.card.kind === "phrase" ? "短语" : "单词"}`)]),
        row.native.path ? h("a", { href: "#", class: "ll-source-link", title: row.native.path, onClick: (event: MouseEvent) => { event.preventDefault(); rowAction("source", row); } }, row.native.path.replace(/\.md$/i, "")) : h("span", { class: "ll-muted ll-small" }, "来源已删除"),
    ]) },
    { title: "含义", key: "meaning", minWidth: 150 },
    { title: "收录次数", key: "captureCount", width: 108, defaultSortOrder: "descend", sorter: (left, right) => left.captureCount - right.captureCount, render: row => h("span", { class: "ll-count-badge" }, `${row.captureCount} 次`) },
    { title: "标签", key: "tags", minWidth: 100, render: row => h("div", { class: "ll-row-tags" }, row.tags.map(tag => h(NTag, { size: "small", bordered: false }, { default: () => tag }))) },
    { title: "更新日期", key: "date", width: 115, sorter: (left, right) => left.date.localeCompare(right.date), render: row => h("span", { class: "ll-muted ll-small ll-date" }, row.date || "—") },
    { title: "", key: "actions", width: 42, render: row => !row.native.path ? null : h(NDropdown, { trigger: "click", options: [{ label: "打开来源", key: "source" }, { label: "编辑", key: "edit" }, { label: "删除", key: "delete" }], onSelect: (key: string) => rowAction(key, row) },
        { default: () => h(NButton, { text: true, size: "small", class: "ll-row-menu", "aria-label": `${row.expr} 的操作` }, { default: () => h(PanelIcon, { name: "ellipsis" }) }) }) },
]);
/** 只在 Markdown 来源变化后更新表格 */
function onVaultChange(file: { extension?: string }): void { if (file.extension === "md") void loadData(); }
onMounted(() => { void loadData(); window.addEventListener("obsidian-langr-refresh", loadData); plugin.app.vault.on("modify", onVaultChange); plugin.app.vault.on("delete", onVaultChange); plugin.app.vault.on("rename", onVaultChange); });
onUnmounted(() => { ++loadSequence; window.removeEventListener("obsidian-langr-refresh", loadData); plugin.app.vault.off("modify", onVaultChange); plugin.app.vault.off("delete", onVaultChange); plugin.app.vault.off("rename", onVaultChange); });
</script>
