<template><span ref="element" class="ll-icon" aria-hidden="true"></span></template>
<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { setIcon } from "obsidian";
/** 使用 Obsidian 内置图标，保持主题和图标风格一致 */
const props = defineProps<{ name: string }>();
/** 由宿主填充图标的独立容器 */
const element = ref<HTMLElement | null>(null);
/** 更新图标时不插入外部资源或自定义路径 */
function render(): void { if (element.value) setIcon(element.value, props.name); }
onMounted(render);
watch(() => props.name, render);
</script>
