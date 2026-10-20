<template>
    <div id="langr-data">
        <NConfigProvider :theme="theme" :theme-overrides="themeConfig">
            <div style="display:flex; align-items:center;">
                <span
                    style="display: inline-block; width: 70px; font-size: 1.2em; font-weight: bold; margin-right: 15px;">Search:</span>
                <NInput size="small" v-model:value="searchText" />
            </div>
            <NSpace style="margin: 10px 0;" align="center">
                <span
                    style="display: inline-block; width: 70px; font-size: 1.2em; font-weight: bold; margin-right: 5px;">
                    Tags:
                </span>
                <select v-model="mode">
                    <option value="and">And</option>
                    <option value="or">Or</option>
                </select>
                <NTag v-for="(tag, i) in tags" size="small" checkable v-model:checked="checkedTags[i]">
                    {{ "#" + tag }}
                </NTag>
            </NSpace>
            <NDataTable ref="table" size="small" :loading="loading" :data="data" :columns="collumns"
                :row-key="makeRowKey" @update:checked-row-keys="handleCheck" :pagination="{ pageSize: 10 }" />
        </NConfigProvider>
    </div>
</template>

<script setup lang="ts">
import { moment, TFile, Notice, Modal } from "obsidian";
import type { IndexedCard } from "@/lingualeaf/host";
import { action } from "@/lingualeaf/ui";
import { cardToForm } from "@/lingualeaf/panel-model";
import {
    h,
    ref,
    reactive,
    computed,
    onMounted,
    onUnmounted,
    watch,
    watchEffect,
    getCurrentInstance,
} from "vue";
import {
    NConfigProvider,
    NDataTable,
    NTag,
    GlobalThemeOverrides,
    darkTheme,
    NSpace,
    NInput,
    NButton,
} from "naive-ui";
import { t } from "@/lang/helper";

import type { DataTableColumns, DataTableRowKey } from "naive-ui";
import type PluginType from "@/plugin";


const plugin = getCurrentInstance().appContext.config.globalProperties
    .plugin as PluginType;

const themeConfig: GlobalThemeOverrides = {
    DataTable: {
        fontSizeSmall: plugin.constants.platform === "mobile" ? "10px" : "14px",
        tdPaddingSmall: "8px",
    },
};

// 切换明亮/黑暗模式
const theme = computed(() => {
    return plugin.store.dark ? darkTheme : null;
});


interface Row {
    /** 每张文章闪卡使用稳定身份 */
    key: string;
    /** 随文 SR 闪卡及其来源 */
    native: IndexedCard;
    expr: string;
    status: string;
    meaning: string;
    tags: string[];
    date: string;
    senNum: number;
    noteNum: number;
}

const statusMap = [
    t("Ignore"),
    t("Learning"),
    t("Familiar"),
    t("Known"),
    t("Learned"),
];


/** 保持原表格加载状态和刷新方式 */
let loading = ref(true);
/** 避免卸载或较慢的旧扫描覆盖最新表格 */
let loadSequence = 0;
/** 从文章中的 SR 闪卡建立单词列表，继续使用原 Naive UI 表格 */
async function loadData() {
    // 每次刷新只接受最后发起的结果。
    const sequence = ++loadSequence;
    loading.value = true;
    try {
        // Markdown 是词库内容的唯一权威来源，索引文件保留删除文章后的快照。
        const cards = await plugin.lingualeaf.host.scan();
        if (sequence !== loadSequence) return;
        data.value = cards.map((item): Row => {
            // 表格按文章卡片显示，避免合并词形时丢失不同文章的例句和调度。
            const form = cardToForm(item.card, item.path);
            // 文件修改时间只用于列表排序，不伪造收录或复习历史。
            const file = plugin.app.vault.getAbstractFileByPath(item.path);
            return { key: `card:${item.card.id}`, native: item, expr: form.expression, status: statusMap[form.status], meaning: form.meaning,
                tags: form.tags, noteNum: form.notes.length, senNum: form.sentences.length + (item.card.outline ? 1 : 0),
                date: file instanceof TFile ? moment(file.stat.mtime).format("YYYY-MM-DD") : "" };
        });
        tags.value = [...new Set(data.value.flatMap(row => row.tags))].sort();
        checkedTags.value = tags.value.map(() => false);
    } catch (error) { new Notice(String(error)); }
    finally { if (sequence === loadSequence) loading.value = false; }
}
/** 首次打开和原插件提交事件均刷新同一张表格 */
onMounted(() => { void loadData(); window.addEventListener("obsidian-langr-refresh", loadData); plugin.app.vault.on("modify", onVaultChange); plugin.app.vault.on("delete", onVaultChange); plugin.app.vault.on("rename", onVaultChange); });
/** 仅 Markdown 或词条数据变化后重新扫描列表 */
function onVaultChange(file: { extension?: string }) { if (file.extension === "md") void loadData(); }
/** 关闭标签页时移除监听，阻止已关闭表格异步更新 */
onUnmounted(() => { ++loadSequence; window.removeEventListener("obsidian-langr-refresh", loadData); plugin.app.vault.off("modify", onVaultChange); plugin.app.vault.off("delete", onVaultChange); plugin.app.vault.off("rename", onVaultChange); });

let data = ref<Row[]>([]);

let table = ref<InstanceType<typeof NDataTable>>(null);
let mode = ref("and");
let tags = ref<string[]>([]);
let checkedTags = ref<boolean[]>([]);
let selectedTags = ref<string[]>([]);
watchEffect(() => {
    let selected = tags.value.filter((tag, i) => checkedTags.value[i]);
    table.value?.filter({
        tags: selected,
    });
    selectedTags.value = selected;
});

// 搜索框
let searchText = ref("");
watch(searchText, (text) => {
    table.value?.filter({
        expr: text
    });
});

// 选中行
let rowKeysRef = ref<DataTableRowKey[]>([]);
/** 相同词形在不同文章保留独立的表格行 */
let makeRowKey = (row: Row) => row.key;
function handleCheck(rowKeys: DataTableRowKey[]) {
    rowKeysRef.value = rowKeys;
}

let collumns = reactive<DataTableColumns<Row>>([
    // {
    //     type: "selection",
    // },
    {
        type: "expand",
        expandable: (row: Row) => row.noteNum + row.senNum > 0,
        renderExpand: (row: Row) => {
                // 原表格的展开区显示随文例句、大纲、笔记，全部以文本呈现。
                const card = row.native.card;
                // 继续沿用原例句和笔记样式，不创建另一套卡片列表。
                const form = cardToForm(card, row.native.path);
                return h("div", { class: "word-more" }, [
                    h("div", { class: "word-notes" }, form.notes.map(note => h("p", note))),
                    h("div", { class: "word-sens" }, form.sentences.map(sentence => h("div", { class: "word-sen" }, [h("p", sentence.text), h("p", sentence.trans), h("p", sentence.origin)]))),
                    card.outline ? h("p", `文章概览：${card.outline}`) : null
                ]);
        },
    },
    // 表达
    {
        title: "Expr",
        key: "expr",
        sorter: "default",
        filter(_, row) {
            if (!searchText.value) return true;

            return row.expr.contains(searchText.value);
        }
    },
    // 学习状态
    {
        title: "Status",
        key: "status",
        width: "70",
        defaultFilterOptionValues: statusMap.slice(1),
        filterOptions: [
            { label: t("Ignore"), value: t("Ignore") },
            { label: t("Learning"), value: t("Learning") },
            { label: t("Familiar"), value: t("Familiar") },
            { label: t("Known"), value: t("Known") },
            { label: t("Learned"), value: t("Learned") },
        ],
        filter(value, row) {
            return row.status === value;
        },
    },
    // 含义
    {
        title: "Meaning",
        key: "meaning",
    },
    // 标签
    {
        title: "Tags",
        key: "tags",
        render(row) {
            return row.tags.map((tag: string) =>
                h(
                    NTag,
                    {
                        style: { marginRight: "6px" },
                        type: "info",
                        size: "tiny",
                    },
                    { default: () => tag }
                )
            );
        },
        filter(value, row) {
            if (selectedTags.value.length === 0) {
                return true;
            }
            return mode.value === "and"
                ? selectedTags.value.every((tag) => row.tags.contains(tag))
                : selectedTags.value.some((tag) => row.tags.contains(tag));
        },
    },
    // 随文数据增加来源，保留原筛选方式。
    {
        title: "来源 / 语言",
        key: "source",
        render(row) { return row.native ? `${row.native.path || "来源已删除"} · ${row.native.card.language}` : ""; }
    },
    {
        title: "操作",
        key: "actions",
        render(row) {
            if (!row.native?.path) return null;
            // 操作沿用原表格按钮和右侧表单；不打开新的词库或编辑弹窗。
            const item = row.native;
            return h(NSpace, { size: 4 }, { default: () => [
                h(NButton, { size: "tiny", onClick: () => plugin.app.workspace.openLinkText(item.path, "", false) }, { default: () => "来源" }),
                h(NButton, { size: "tiny", onClick: () => plugin.lingualeaf.editCard(item.path, item.card).catch(error => new Notice(String(error))) }, { default: () => "编辑" }),
                h(NButton, { size: "tiny", onClick: () => {
                    // 只在删除前使用确认弹窗，词库与编辑仍保持原来的标签页和面板。
                    const confirm = new Modal(plugin.app);
                    confirm.contentEl.createEl("h2", { text: `删除：${item.card.text}` });
                    confirm.contentEl.createEl("p", { text: `将备份 ${item.path} 并删除该卡片及 SR 调度，全局词条保留。` });
                    action(confirm.contentEl, "备份并删除本文卡片", async () => {
                        // 删除前重新定位文件，避免来源变化导致写错文章。
                        const file = plugin.app.vault.getAbstractFileByPath(item.path);
                        if (!(file instanceof TFile)) throw new Error("来源文章已删除");
                        await plugin.lingualeaf.host.removeCard(file, item.card.id); confirm.close(); await loadData();
                    });
                    confirm.open();
                } }, { default: () => "删除" }),

            ] });
        }
    },
    // 修改日期
    {
        title: "Date",
        key: "date",
        sorter(row1, row2) {
            return moment.utc(row1.date).unix() - moment.utc(row2.date).unix();
        },
    },
]);


</script>

<style lang="scss">
#langr-data {
    #data-tags {
        display: flex;
    }

    .n-data-table-filter {
        width: 19px;
    }

    .n-data-table-th--filterable {
        width: 19px;

    }

    .n-data-table__pagination {
        justify-content: center;
    }

    .data-more {
        h2 {
            margin: 0.5em 0;
        }

        .data-notes {
            p {
                white-space: pre-line;
                margin: 0.5em 5px;
            }
        }

        .data-sens {
            .data-sen {
                margin-bottom: 5px;
                border: 1px solid gray;
                border-radius: 5px;

                p {
                    &:first-child {
                        font-style: italic;
                    }

                    margin: 0.5em 5px;
                }
            }
        }
    }
}

.word-more {
    h2 {
        margin: 0.5em 0;
    }

    .word-notes {
        user-select: text;

        p {
            white-space: pre-line;
            margin: 0.5em 5px;
        }
    }

    .word-sens {
        user-select: text;

        .word-sen {
            margin-bottom: 5px;
            border: 1px solid gray;
            border-radius: 5px;

            p {
                &:first-child {
                    font-style: italic;

                    em {
                        font-weight: bold;
                        color: var(--interactive-accent)
                    }
                }

                margin: 0.5em 5px;
            }
        }
    }
}

</style>
