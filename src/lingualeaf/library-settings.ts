import type { FileSystemAdapter } from "obsidian";
import { Notice, Setting } from "obsidian";
import type LanguageLeaf from "../plugin";
import { LibraryManager } from "./library-manager";
import { vaultLibraryDirectory } from "./library-connection";
import type { LibraryMode } from "./library-connection";

/** 主词库与额外收录入口分别配置，数据始终只保存一份 */
export function renderLibrarySettings(container: HTMLElement, plugin: LanguageLeaf): void {
    new Setting(container).setName("学习库管理").setHeading();
    // 当前设置只控制待连接目标，不会在输入时改变运行中的学习库。
    let mode: LibraryMode = plugin.settings.learning.libraryMode || "external";
    // 主库默认使用可随笔记库移动的普通相对目录。
    let directory = mode === "vault" ? plugin.settings.learning.libraryPath || "LanguageLeafLibrary" : "";
    // 管理操作执行期间禁止重复提交。
    let busy = false;
    // 数据源规则复用独立管理服务。
    const manager = new LibraryManager();
    new Setting(container).setName("学习库位置").addDropdown(control => control.addOption("vault", "当前笔记库内的主词库").addOption("external", "连接本机其他笔记库的词库").setValue(mode).onChange(value => { mode = value as LibraryMode; directory = mode === "vault" ? "LanguageLeafLibrary" : ""; input.setValue(directory); }));
    // 所有目录控件共享同一个待确认输入，模式切换时同步默认值。
    let input: { setValue(value: string): unknown };
    new Setting(container).setName("学习库目录").setDesc("主词库填写相对目录，例如 LanguageLeafLibrary；其他笔记库填写本机主词库的绝对路径，地址仅保存在本机。另一台设备须先同步主库再重新连接。").addText(control => { input = control; control.setValue(directory).setPlaceholder("LanguageLeafLibrary 或本机主词库绝对路径").onChange(value => { directory = value.trim(); }); });
    // 无连接时仍可打开管理设置，不会回退为随文卡片。
    const status = container.createEl("p", { attr: { role: "status" }, text: plugin.lingualeaf.host.connectionError || (plugin.lingualeaf.host.library ? "词条、资料与评分历史随主库同步；锁、缓存和会话断点只保存在本机。切换设备前请先完成同步。" : "当前仍使用随文卡片和本笔记库内的 LinguaLeafData，不会自动迁移。下方操作用于手动创建或连接独立学习库，已有卡片请先按迁移说明处理。") });
    // 只有用户选择管理动作时才读写数据源。
    const run = async (action: "create" | "connect" | "import"): Promise<void> => {
        if (busy) return;
        busy = true; status.textContent = "正在处理学习库…";
        try {
            if (plugin.reviewModal) throw new Error("请先关闭复习窗口再管理学习库");
            // 先将主库相对目录解析为当前设备路径，外部入口保持用户明确地址。
            const base = (plugin.app.vault.adapter as FileSystemAdapter).getBasePath();
            // 导入操作始终选择另一份已有库的绝对目录。
            const target = action !== "import" && mode === "vault" ? vaultLibraryDirectory(base, directory) : directory;
            if (action === "import") {
                if (!plugin.lingualeaf.host.library) throw new Error("请先连接当前学习库并重新加载插件");
                // 追加导入不切换当前学习库。
                const result = await manager.import(plugin.lingualeaf.host.library, target);
                status.textContent = result.alreadyImported ? "此学习库已经导入，无需重复处理。" : `已追加 ${result.imported} 张卡片，已有资料和进度已保留。`;
                window.dispatchEvent(new CustomEvent("obsidian-langr-refresh"));
            } else {
                // 已绑定身份只允许连接同一个学习库，避免误选其他有效目录。
                const library = action === "create" ? await manager.create(target) : await manager.connect(target, plugin.settings.learning.libraryId);
                await plugin.stageLibraryConnection(library.port.directory, (await library.catalog()).id, mode);
                status.textContent = "连接已保存，请重新加载 Language Leaf 后使用新数据源。";
                new Notice(status.textContent);
            }
        } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
        finally { busy = false; }
    };
    new Setting(container).setName("数据源操作")
        .addButton(button => button.setButtonText("创建学习库").onClick(() => { void run("create"); }))
        .addButton(button => button.setButtonText("连接已有库").onClick(() => { void run("connect"); }))
        .addButton(button => button.setButtonText("导入另一个库").onClick(() => { void run("import"); }));
    if (plugin.lingualeaf.host.library) {
        void plugin.lingualeaf.host.library.catalog().then(catalog => {
            if (!container.isConnected) return;
            // 学习日配置保持与主库一致。
            let timeZone = catalog.calendar?.timeZone || "Asia/Shanghai";
            // 切日小时支持自定义作息。
            let rolloverHour = catalog.calendar?.rolloverHour ?? 4;
            // 共享设置独立版本阻止旧窗口覆盖新设置。
            let revision = catalog.reviewRevision || 0;
            new Setting(container).setName("共享学习日时区").addText(control => control.setValue(timeZone).onChange(value => { timeZone = value.trim(); }));
            new Setting(container).setName("每日切换小时").setDesc("0—23，默认凌晨 4 点。").addText(control => control.setValue(String(rolloverHour)).onChange(value => { rolloverHour = Number(value); })).addButton(button => button.setButtonText("保存学习日规则").onClick(() => {
                void plugin.lingualeaf.host.library!.configureCalendar({ timeZone, rolloverHour }, revision).then(() => { revision++; status.textContent = "共享学习日规则已保存。"; }).catch(error => { status.textContent = String(error); });
            }));
        }).catch(error => { status.textContent = String(error); });
    }
}
