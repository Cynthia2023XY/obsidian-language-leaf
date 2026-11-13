import { LearningCore } from "./learning-core";
import { LibraryFiles } from "./library-files";
import type { LibraryRepositoryPort } from "./repository";

export type { LibrarySource, LibraryRecord, LibraryCatalog } from "./learning-core";

/** 桌面本地库装配入口，纯学习业务位于不依赖 Node 的 LearningCore */
export class LearningLibrary extends LearningCore {
    /** 路径只出现在本地适配器，核心接收可替换仓储端口 */
    constructor(directory: string | LibraryRepositoryPort, expectedId?: string) {
        super(typeof directory === "string" ? new LibraryFiles(directory) : directory, expectedId);
    }
}
