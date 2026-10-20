import { computed } from "vue";
import type { GlobalThemeOverrides } from "naive-ui";
import store from "../store";

/** 将 Obsidian 的语义色转换为组件库可计算的实际颜色 */
export function usePanelTheme() {
    return computed<GlobalThemeOverrides>(() => {
        // 主题切换和主题 CSS 更新都会刷新组件颜色。
        void store.dark; void store.themeChange;
        // 借助浏览器解析主题中的嵌套变量，不固定深色或浅色调色板。
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
        document.body.appendChild(probe);
        // 组件库需要实际颜色来计算悬停和焦点色。
        const color = (token: string): string => {
            probe.style.color = `var(${token})`;
            return getComputedStyle(probe).color;
        };
        // 三个面板共用原生正文、背景、强调色和边框。
        const common = { primaryColor: color("--interactive-accent"), primaryColorHover: color("--interactive-accent-hover"), primaryColorPressed: color("--interactive-accent"),
            textColor1: color("--text-normal"), textColor2: color("--text-normal"), textColor3: color("--text-muted"), placeholderColor: color("--text-faint"),
            borderColor: color("--background-modifier-border"), inputColor: color("--background-modifier-form-field"),
            bodyColor: color("--background-primary"), cardColor: color("--background-primary"), popoverColor: color("--background-primary"), tableColor: color("--background-primary"),
            fontSize: "14px", fontSizeSmall: "13px", borderRadius: "5px" };
        probe.remove();
        return { common,
            Form: { labelFontSizeTopMedium: "12px", labelFontSizeTopSmall: "12px", labelTextColor: common.textColor3, feedbackFontSizeMedium: "12px", feedbackHeightMedium: "18px", blankHeightMedium: "0px" },
            DataTable: { fontSizeSmall: "13px", tdPaddingSmall: "14px 12px", thPaddingSmall: "10px 12px", tdColor: common.bodyColor, thColor: common.bodyColor, thColorSorting: common.bodyColor, tdColorSorting: common.bodyColor, tdColorHover: common.inputColor },
            Input: { fontSizeSmall: "14px", lineHeightTextarea: "1.5" }, Tag: { fontSizeSmall: "12px" } };
    });
}
