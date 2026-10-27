/** UI-independent contract; a future local HTTP TTS adapter can return audio bytes. */
export interface PronunciationRequest {
    text: string; language: string; accent: "us" | "uk";
    trigger: "manual" | "auto"; owner: string; audioUrl?: string;
    voice?: string; model?: string; rate?: number; allowSystem?: boolean; systemOnly?: boolean;
}
export type PronunciationOutput = { kind: "audio"; bytes: ArrayBuffer; mime: string } |
    { kind: "speech"; text: string; language: string; voice: SpeechSynthesisVoice; rate: number; downgraded: boolean };
export interface PronunciationProvider {
    id: string;
    supports(request: PronunciationRequest): boolean;
    cacheKey?(request: PronunciationRequest): string;
    generate(request: PronunciationRequest, signal: AbortSignal): Promise<PronunciationOutput>;
}
export interface PlaybackPort {
    play(output: PronunciationOutput, signal: AbortSignal, started: () => void): Promise<void>;
    stop(): void;
}
export interface PronunciationState { owner: string; phase: "idle" | "loading" | "playing" | "error"; message: string; request?: PronunciationRequest }
export class PronunciationError extends Error {
    constructor(readonly code: string) { super(code); this.name = "PronunciationError"; }
}
export function abortable<T>(task: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = (): void => { cleanup(); reject(new PronunciationError("cancelled")); };
        const timer = setTimeout(() => { cleanup(); reject(new PronunciationError("timeout")); }, ms);
        const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        task.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}
export function isSingleWord(text: string): boolean { return /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(text.trim()); }
export function validateAudio(status: number, mime: string, bytes: ArrayBuffer): void {
    if (status < 200 || status >= 300) throw new PronunciationError(status >= 500 || status === 429 ? "server" : "http");
    const data = new Uint8Array(bytes);
    const signature = (data[0] === 73 && data[1] === 68 && data[2] === 51) || (data[0] === 255 && (data[1] & 224) === 224) ||
        (data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70) || (data[0] === 79 && data[1] === 103 && data[2] === 103 && data[3] === 83);
    if (!/^audio\//i.test(mime) || data.length < 16 || data.length > 8 * 1024 * 1024 || !signature) throw new PronunciationError("invalid-audio");
}
export class PronunciationService {
    private controller?: AbortController;
    private active?: PronunciationRequest;
    private listeners = new Set<(state: PronunciationState) => void>();
    private cache = new Map<string, Extract<PronunciationOutput, { kind: "audio" }>>();
    private state: PronunciationState = { owner: "", phase: "idle", message: "" };
    constructor(private providers: PronunciationProvider[], private playback: PlaybackPort) {}
    subscribe(listener: (state: PronunciationState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private emit(state: PronunciationState): void { this.state = state; this.listeners.forEach(listener => listener(state)); }
    stop(owner?: string): void {
        if (owner && this.active?.owner !== owner) return;
        this.controller?.abort(); this.playback.stop();
        if (this.active) this.emit({ owner: this.active.owner, phase: "idle", message: "" });
        this.controller = undefined; this.active = undefined;
    }
    dispose(): void { this.stop(); this.cache.clear(); this.listeners.clear(); }
    async speak(input: PronunciationRequest): Promise<void> {
        const request = { ...input, text: input.text.trim().replace(/\s+/g, " ") };
        if (!request.text) return;
        if (this.active && JSON.stringify(this.active) === JSON.stringify(request) && ["loading", "playing"].includes(this.state.phase)) return;
        this.stop(); const control = new AbortController(); this.controller = control; this.active = request;
        const current = (): boolean => this.controller === control && !control.signal.aborted;
        this.emit({ owner: request.owner, phase: "loading", message: "正在准备发音…", request });
        let failedOnline = false;
        for (const provider of this.providers.filter(item => item.supports(request))) {
            const key = provider.cacheKey?.(request);
            const child = new AbortController(); const cancel = (): void => child.abort(); control.signal.addEventListener("abort", cancel, { once: true });
            const startedAt = Date.now();
            try {
                const cached = key ? this.cache.get(key) : undefined;
                const output = cached || await abortable(provider.generate(request, child.signal), child.signal, 6000);
                if (!current()) return;
                await this.playback.play(output, child.signal, () => {
                    if (!current()) return;
                    if (key && output.kind === "audio") {
                        this.cache.delete(key); this.cache.set(key, output);
                        let size = Array.from(this.cache.values()).reduce((sum, item) => sum + item.bytes.byteLength, 0);
                        while (this.cache.size > 32 || size > 8 * 1024 * 1024) { const first = this.cache.keys().next().value as string; size -= this.cache.get(first)!.bytes.byteLength; this.cache.delete(first); }
                    }
                    const message = output.kind === "speech" ? `${failedOnline ? "在线发音失败，已改用" : "正在使用"}系统朗读 · ${output.voice.name}（${output.voice.lang}）${output.downgraded ? "（所选口音不可用，已使用同语言语音）" : ""}` : "正在播放词典发音";
                    this.emit({ owner: request.owner, phase: "playing", message, request });
                });
                if (current()) this.emit({ owner: request.owner, phase: "idle", message: output.kind === "speech" ? `系统朗读结束 · ${output.voice.name}（${output.voice.lang}）` : "", request });
                return;
            } catch (error) {
                if (!current()) return;
                if (key) this.cache.delete(key);
                failedOnline = failedOnline || provider.id === "youdao";
                console.warn("[Language Leaf pronunciation]", { provider: provider.id, code: error instanceof PronunciationError ? error.code : "playback-or-network", elapsedMs: Date.now() - startedAt });
            } finally { child.abort(); control.signal.removeEventListener("abort", cancel); }
        }
        if (current()) this.emit({ owner: request.owner, phase: "error", message: request.allowSystem === false ? "发音失败：系统朗读已关闭，当前没有可用的在线音频。" : "发音失败：在线音频或所选系统语音不可用，请检查声音设置或重试。", request });
    }
}
