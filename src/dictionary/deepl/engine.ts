import { requestUrl, RequestUrlParam } from "obsidian"

const langMap: Record<string, string> = {
    zh: "ZH",
    en: "EN",
    jp: "JA",
    fr: "FR",
    de: "DE",
    es: "ES",
};

export async function search(text: string, lang: string = ""): Promise<string | undefined> {
    let target = (/[\u4e00-\u9fa5]/.test(text) && !/[\u0800-\u4e00]/.test(text)) // chinese
        ? langMap[lang] || "ZH"
        : "ZH";
    const payload = {
        text,
        source_lang: "auto",
        target_lang: target,
    };

    const data: RequestUrlParam = {
        url: "https://deeplx.vercel.app/translate",
        method: "POST",
        body: JSON.stringify(payload),
        contentType: "application/json"
    };

    try {
        // 第三方响应先校验结构，避免把不确定类型作为译文返回。
        const res: unknown = (await requestUrl(data)).json;
        if (!res || typeof res !== "object" || !("code" in res) || res.code !== 200 || !("data" in res) || typeof res.data !== "string") throw new Error("Deeplx api source error.");

        return res.data;
    } catch (err) {
        console.error(err.message)
    }
}
