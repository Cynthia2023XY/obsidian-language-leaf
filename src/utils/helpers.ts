import { Notice, requestUrl } from "obsidian";
import { PronunciationService, PronunciationError } from "../lingualeaf/pronunciation/service";
import type { PronunciationRequest, PronunciationState } from "../lingualeaf/pronunciation/service";
import { SystemSpeechProvider, YoudaoProvider } from "../lingualeaf/pronunciation/providers";
import { BrowserPlayback } from "../lingualeaf/pronunciation/playback";
let service: PronunciationService | undefined;
let dictionary: YoudaoProvider | undefined;
let speechOptions = { enabled: true, voice: "" };
export function configureSpeech(options: { enabled: boolean; voice: string }): void {
    if (JSON.stringify(options) !== JSON.stringify(speechOptions)) service?.stop();
    speechOptions = { ...options };
}
function current(): PronunciationService {
    if (!service) {
        dictionary = new YoudaoProvider(async (url, signal) => {
            if (signal.aborted) throw new PronunciationError("cancelled");
            // Obsidian requestUrl avoids renderer CORS. It cannot abort the underlying
            // transport; the service aborts waiting and discards all late responses.
            try {
                const result = await requestUrl({ url, throw: false });
                if (signal.aborted) throw new PronunciationError("cancelled");
                const mime = Object.entries(result.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
                return { status: result.status, mime, bytes: result.arrayBuffer };
            } catch (error) { if (error instanceof PronunciationError) throw error; throw new PronunciationError("network"); }
        });
        service = new PronunciationService([dictionary, new SystemSpeechProvider()], new BrowserPlayback());
        service.subscribe(state => {
            if (state.phase !== "error" || state.request?.trigger !== "manual") return;
            const message = document.createDocumentFragment();
            message.append(document.createTextNode(state.message + " "));
            const retry = document.createElement("button"); retry.textContent = "重试发音";
            const failedService = service;
            retry.onclick = () => { if (service === failedService && state.request) void service.speak(state.request); };
            message.append(retry); new Notice(message, 7000);
        });
    }
    return service;
}
export function pronounce(request: PronunciationRequest): void { void current().speak({ ...request, voice: request.voice ?? speechOptions.voice, allowSystem: request.allowSystem ?? speechOptions.enabled }); }
export function stopPronunciation(owner?: string): void { service?.stop(owner); }
export function disposePronunciation(): void { service?.dispose(); service = undefined; dictionary = undefined; }
export function onPronunciation(listener: (state: PronunciationState) => void): () => void { return current().subscribe(listener); }
export function registerRecording(text: string, accent: "us" | "uk", url: string): void { current(); dictionary?.register(text, accent, url); }
/** Compatibility adapter for dictionary-provided recording links. */
export function playAudio(src: string, text?: string): void {
    let spoken = text || "";
    try { spoken = spoken || new URL(src).searchParams.get("audio")?.replace(/_(?:1|2)$/, "") || ""; } catch { /* Unknown URL remains an audio-only request. */ }
    pronounce({ text: spoken || "发音", language: "en", accent: /[?&]type=1(?:&|$)/.test(src) ? "uk" : "us", trigger: "manual", owner: "search", audioUrl: src });
}
