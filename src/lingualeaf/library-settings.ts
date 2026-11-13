import { Notice, Setting } from "obsidian";
import type LanguageLeaf from "../plugin";
import { LibraryManager } from "./library-manager";

/** 数据源管理适配器：创建、连接和追加导入是三个明确动作 */
export function renderLibrarySettings(container: HTMLElement, plugin: LanguageLeaf): void {
    new Setting(container).setName("学习库管理").setHeading();
    // 输入值只作为待处理目标，不自动切换当前运行中的数据源。
    let directory = "";
    // 处理期间禁止重复提交同一管理动作。
    let busy = false;
    // 所有底层管理规则由宿主无关服务负责。
    const manager = new LibraryManager();
    new Setting(container).setName("学习库绝对路径").setDesc("创建使用全新目录；连接选择已有学习库；追加导入将另一份独立学习库合入当前库。旧笔记库请先运行迁移工具。").addText(control => control.setPlaceholder("/Users/…/Language Leaf Library").onChange(value => { directory = value.trim(); }));
    // 结果保留在设置页，操作完成前不关闭窗口。
    const status = container.createEl("p", { attr: { role: "status" } });
    // 三个入口共用错误和忙状态保护。
    const run = async (action: "create" | "connect" | "import"): Promise<void> => {
        if (busy) return;
        busy = true; status.textContent = "正在处理学习库…";
        try {
            if (plugin.reviewModal) throw new Error("请先关闭复习窗口再管理学习库");
            if (action === "import") {
                if (!plugin.lingualeaf.host.library) throw new Error("请先连接当前学习库并重新加载插件");
                // 追加导入不切换来源，不修改其他窗口设置。
                const result = await manager.import(plugin.lingualeaf.host.library, directory);
                status.textContent = result.alreadyImported ? "此学习库已经导入，无需重复处理。" : `已追加 ${result.imported} 张卡片，已有资料和进度已保留。`;
                window.dispatchEvent(new CustomEvent("obsidian-langr-refresh"));
            } else {
                // 完成目录验证后才保存待下次启动使用的连接。
                const library = action === "create" ? await manager.create(directory) : await manager.connect(directory);
                // 待重载连接与运行设置分开保存，后续普通设置不能覆盖它。
                await plugin.stageLibraryConnection(library.port.directory, (await library.catalog()).id);
                status.textContent = "连接已保存，请重新加载 Language Leaf 后使用新数据源。";
                new Notice(status.textContent);
            }
        } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
        finally { busy = false; }
    };
    if (plugin.lingualeaf.host.library) {
        // 只为仍挂载的设置页补充共享日历，关闭页面后不再修改 DOM。
        void plugin.lingualeaf.host.library.catalog().then(catalog => {
            if (!container.isConnected) return;
            // 表单值只在用户点击保存后进入共享配置。
            let timeZone = catalog.calendar?.timeZone || "Asia/Shanghai";
            // 切日小时支持其他作息，不依赖设备本地时区。
            let rolloverHour = catalog.calendar?.rolloverHour ?? 4;
            // 每次成功保存后更新本表单的配置基线。
            let revision = catalog.reviewRevision || 0;
            new Setting(container).setName("共享学习日时区").setDesc("所有接入窗口共用此 IANA 时区，例如 Asia/Shanghai。").addText(control => control.setValue(timeZone).onChange(value => { timeZone = value.trim(); }));
            new Setting(container).setName("每日切换小时").setDesc("0—23，默认凌晨 4 点；修改会按新规则重建每日额度统计。").addText(control => control.setValue(String(rolloverHour)).onChange(value => { rolloverHour = Number(value); })).addButton(button => button.setButtonText("保存学习日规则").onClick(() => {
                void plugin.lingualeaf.host.library!.configureCalendar({ timeZone, rolloverHour }, revision).then(() => { revision++; status.textContent = "共享学习日规则已保存。"; }).catch(error => { status.textContent = String(error); });
            }));
        }).catch(error => { status.textContent = String(error); });
    }
    new Setting(container).setName("数据源操作")
        .addButton(button => button.setButtonText("创建学习库").onClick(() => { void run("create"); }))
        .addButton(button => button.setButtonText("连接已有库").onClick(() => { void run("connect"); }))
        .addButton(button => button.setButtonText("导入另一个库").onClick(() => { void run("import"); }));
}
