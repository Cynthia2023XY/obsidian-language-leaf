import { reactive } from "vue";

/** 三个学习面板共享的主题、词典刷新和展开高度 */
const store = reactive({ dark: false, themeChange: false, dictsChange: false, dictHeight: "250px" });
export default store;
