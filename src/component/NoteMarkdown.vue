<template><div ref="element"></div></template>
<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import type { App } from "obsidian";
import { renderNoteMarkdown } from "../lingualeaf/note-markdown";

/** 笔记保留原始 Markdown 与来源路径，链接相对原文解析 */
const props = defineProps<{ app: App; text: string; sourcePath: string }>();
/** Vue 负责挂载，Obsidian 负责渲染内容 */
const element = ref<HTMLElement | null>(null);
/** 内容更新或列表收起时清理旧渲染资源 */
let dispose: (() => void) | undefined;
/** 切换笔记内容后只展示当前版本 */
function render(): void {
    dispose?.();
    if (element.value) dispose = renderNoteMarkdown(props.app, props.text, element.value, props.sourcePath);
}
onMounted(render);
watch(() => [props.text, props.sourcePath], render);
onUnmounted(() => { dispose?.(); });
</script>
