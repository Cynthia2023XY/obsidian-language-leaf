<template>
    <details class="dict-item ll-dictionary" :open="isOpen" @toggle="onToggle">
        <summary class="dict-item-header"><PanelIcon name="chevron-right" /><span class="dict-name">{{ props.name }}</span><span class="ll-muted ll-small">{{ props.loading ? '查询中…' : '' }}</span></summary>
        <div class="dict-item-body"><article><slot></slot></article></div>
    </details>
</template>
<script setup lang="ts">
import { ref } from "vue";
import PanelIcon from "../component/PanelIcon.vue";
/** 各个词典保留独立折叠状态，默认展开第一个已启用词典 */
const props = defineProps<{ loading: boolean; name: string; id: string; defaultOpen?: boolean }>();
/** 折叠仅影响展示，保留已有词典查询与缓存结果 */
const isOpen = ref(!!props.defaultOpen);
/** 同步键盘或鼠标切换的原生折叠状态 */
function onToggle(event: Event): void { isOpen.value = (event.target as HTMLDetailsElement).open; }
</script>
