import { getLanguage } from "obsidian";
import zh from "./locale/zh";
import en from "./locale/en";
import zh_TW from "./locale/zh-TW";

/** Obsidian 界面语言对应的本地词典文案 */
const localeMap: { [k: string]: Partial<typeof en>; } = {
    en,
    zh,
    "zh-TW": zh_TW,
};


/** 使用宿主公开 API 读取当前界面语言 */
const lang = getLanguage();
/** 未识别语言时回退到英文 */
const locale = localeMap[lang || "en"];

/** 按宿主语言获取插件本地文案 */
export function t(text: keyof typeof en): string {
    return (locale && locale[text]) || en[text];
}