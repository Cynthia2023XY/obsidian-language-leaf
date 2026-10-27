<template>
    <div id="langr-search" class="ll-panel" @click="handleClick">
        <NConfigProvider :theme="theme" :theme-overrides="themeConfig">
            <header class="ll-panel-heading"><PanelIcon name="search" /><span>查词</span></header>
            <form class="search-bar ll-search-bar" @submit.prevent="handleSearch">
                <button type="button" class="ll-icon-button" aria-label="上一条查询" :disabled="historyIndex <= 0" @click="switchHistory('prev')"><PanelIcon name="chevron-left" /></button>
                <button type="button" class="ll-icon-button" aria-label="下一条查询" :disabled="historyIndex >= lastHistory" @click="switchHistory('next')"><PanelIcon name="chevron-right" /></button>
                <NInput size="small" aria-label="查询单词或短语" placeholder="输入单词或短语…" v-model:value="inputWord" />
                <button type="submit" class="ll-icon-button" aria-label="查询"><PanelIcon name="search" /></button>
            </form>
            <div v-if="word" class="ll-query-heading"><h2>{{ word }}</h2><button type="button" class="ll-icon-button" aria-label="播放单词发音" @click="pronounce"><PanelIcon name="volume-2" /></button></div>
            <p v-if="audioMessage" class="ll-muted ll-small" role="status">{{ audioMessage }} <button v-if="audioFailed" type="button" @click="pronounce">重试发音</button></p>
            <div class="dict-area">
                <DictItem v-for="(cp, i) in components" :key="cp.id" :loading="loadings[i]" :name="cp.name" :id="cp.id" :default-open="i === 0">
                    <KeepAlive><Component @loading="loading" :is="cp.type" :word="word" v-show="shows[i]" /></KeepAlive>
                </DictItem>
                <p v-if="!components.length" class="ll-empty">尚未启用词典，请在插件设置中选择。</p>
                <p v-else-if="!word" class="ll-empty">在学习模式中划选词句，或输入后按 Enter 查询。</p>
            </div>
        </NConfigProvider>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, getCurrentInstance } from "vue";
import { NConfigProvider, NInput, darkTheme } from "naive-ui";

import PanelIcon from "../component/PanelIcon.vue";
import { usePanelTheme } from "../lingualeaf/panel-theme";
import DictItem from "./DictItem.vue";
import PluginType from "@/plugin";
import { dicts } from "@dict/list";
import { playAudio, pronounce as speak, onPronunciation, stopPronunciation } from "@/utils/helpers";

/** 当前查词面板所属插件 */
const plugin = getCurrentInstance().appContext.config.globalProperties.plugin as PluginType;
const audioMessage = ref("");
const audioFailed = ref(false);
const unsubscribeAudio = onPronunciation(state => { if (state.owner === "search") { audioMessage.value = state.message; audioFailed.value = state.phase === "error"; } });
onUnmounted(() => { unsubscribeAudio(); stopPronunciation("search"); });



/** 原生主题色随 Obsidian 主题实时更新 */
const themeConfig = usePanelTheme();

let components = ref([]);
let map: { [K in string]: number } = {};
let loadings = ref<boolean[]>([]);
let shows = ref<boolean[]>([]);
watch(() => plugin.store.dictsChange, () => {
    let collection = Object.keys(plugin.settings.dictionaries)
        .map((dict: keyof typeof dicts) => {
            return {
                id: dict,
                priority: plugin.settings.dictionaries[dict].priority,
                name: dicts[dict].name,
            };
        })
        .filter((dict) => plugin.settings.dictionaries[dict.id].enable);
    collection.sort((a, b) => a.priority - b.priority);

    components.value = collection.map((dict) => {
        return {
            id: dict.id,
            name: dict.name,
            type: dicts[dict.id].Cp,
        };
    });
    collection.forEach((v, i) => {
        map[v.id] = i;
    });
    loadings.value = Array(collection.length).fill(false);
    shows.value = Array(collection.length).fill(false);

}, {
    immediate: true
});

function loading({ id, loading, result }: { id: string, loading: boolean, result: boolean; }) {
    loadings.value[map[id]] = loading;
    shows.value[map[id]] = result;
}

// 切换明亮/黑暗模式
const theme = computed(() => {
    return plugin.store.dark ? darkTheme : null;
});

// 提供一个前进后退查询记录的功能
let history: string[] = [];
let lastHistory = ref(history.length - 1);
let historyIndex = ref(-1);
function switchHistory(direction: "prev" | "next") {
    historyIndex.value = Math.max(
        0,
        Math.min(historyIndex.value + (direction === "prev" ? -1 : 1), history.length - 1)
    );
    word.value = history[historyIndex.value];
    inputWord.value = history[historyIndex.value];
}
function appendHistory() {
    if (historyIndex.value < history.length - 1) {
        history = history.slice(0, historyIndex.value + 1);
    }
    history.push(word.value);
    lastHistory.value = history.length - 1;
    historyIndex.value++;
}

let inputWord = ref("");
let word = ref("");
const onSearch = async (evt: CustomEvent) => {
    let text = evt.detail.selection;
    // 首版法语只支持手工收录，不自动发送到已有英语词典。
    if (evt.detail.leafCapture && !evt.detail.leafCapture.card.language.startsWith("en")) {
        inputWord.value = text; word.value = ""; return;
    }
    word.value = text;
    inputWord.value = text;
    appendHistory();
};

function handleSearch() {
    if (!inputWord.value.trim()) return;
    word.value = inputWord.value.trim();
    appendHistory();
}

/** 显式发音沿用已有有道音频服务与口音配置 */
function pronounce(): void {
    if (word.value.trim()) speak({ text: word.value, language: plugin.settings.learning.language, accent: plugin.settings.review_prons === "1" ? "uk" : "us", trigger: "manual", owner: "search" });
}

function handleClick(evt: MouseEvent) {
    const target = evt.target as HTMLElement;
    if (target.hasClass("speaker")) {
        evt.preventDefault();
        evt.stopPropagation();
        let url = (target as HTMLAnchorElement).href;
        playAudio(url, word.value);

    }
    else if (target.tagName === "A") {
        evt.preventDefault();
        evt.stopPropagation();
        word.value = target.textContent;
        inputWord.value = target.textContent;
        appendHistory();
    }
}


watch(word, () => { stopPronunciation("search"); audioMessage.value = ""; audioFailed.value = false; }, { flush: "sync" });

onMounted(() => {
    addEventListener('obsidian-langr-search', onSearch);
});

onUnmounted(() => {
    removeEventListener('obsidian-langr-search', onSearch);
});
</script>
