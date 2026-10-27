import { abortable, isSingleWord, PronunciationError, validateAudio } from "./service";
import type { PronunciationOutput, PronunciationProvider, PronunciationRequest } from "./service";
export interface AudioResponse { status: number; mime: string; bytes: ArrayBuffer }
export type AudioTransport = (url: string, signal: AbortSignal) => Promise<AudioResponse>;
/** Only dictionary recordings use this adapter. Local TTS will implement its own provider. */
export class YoudaoProvider implements PronunciationProvider {
    id = "youdao";
    private recordings = new Map<string, string>();
    constructor(private transport: AudioTransport) {}
    register(text: string, accent: "us" | "uk", url: string): void {
        try { const parsed = new URL(url); if (parsed.protocol === "https:" && parsed.hostname === "dict.youdao.com") {
            this.recordings.set(`${accent}:${text.trim().toLowerCase()}`, url);
            if (this.recordings.size > 256) this.recordings.delete(this.recordings.keys().next().value);
        } } catch { /* Invalid dictionary links do not become playback requests. */ }
    }
    supports(request: PronunciationRequest): boolean { return !request.systemOnly && (!!request.audioUrl || (request.language.startsWith("en") && isSingleWord(request.text))); }
    private url(request: PronunciationRequest): string {
        return request.audioUrl || this.recordings.get(`${request.accent}:${request.text.toLowerCase()}`) || `https://dict.youdao.com/dictvoice?type=${request.accent === "uk" ? 1 : 2}&audio=${encodeURIComponent(request.text)}`;
    }
    cacheKey(request: PronunciationRequest): string { return JSON.stringify([this.id, request.text, request.language, request.accent, this.url(request)]); }
    async generate(request: PronunciationRequest, signal: AbortSignal): Promise<PronunciationOutput> {
        for (let attempt = 0; ; attempt++) {
            try {
                const result = await this.transport(this.url(request), signal);
                if (signal.aborted) throw new PronunciationError("cancelled");
                validateAudio(result.status, result.mime, result.bytes);
                return { kind: "audio", bytes: result.bytes, mime: result.mime };
            } catch (error) {
                if (signal.aborted || attempt >= 1 || !(error instanceof PronunciationError) || !["server", "network"].includes(error.code)) throw error;
                await abortable(new Promise(resolve => setTimeout(resolve, 250)), signal, 500);
            }
        }
    }
}
export function voiceId(voice: SpeechSynthesisVoice): string { return voice.voiceURI || voice.name; }
/** Prefer ordinary narration voices. Web Speech exposes no portable quality score. */
export function selectVoice(voices: SpeechSynthesisVoice[], request: PronunciationRequest): { voice: SpeechSynthesisVoice; downgraded: boolean } {
    const base = request.language.split(/[-_]/)[0].toLowerCase();
    const target = base === "en" ? request.accent === "uk" ? "en-gb" : "en-us" : request.language.toLowerCase();
    const languageVoices = voices.filter(voice => voice.lang.split(/[-_]/)[0].toLowerCase() === base);
    if (request.voice) {
        const chosen = languageVoices.find(voice => voiceId(voice) === request.voice || voice.name === request.voice);
        if (!chosen) throw new PronunciationError("selected-voice-unavailable");
        return { voice: chosen, downgraded: chosen.lang.toLowerCase() !== target };
    }
    const ordinary = languageVoices.filter(voice => !/^(?:albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|trinoids|whisper|wobble|zarvox)(?:$|[ (])/i.test(voice.name));
    const score = (voice: SpeechSynthesisVoice): number => (voice.lang.toLowerCase() === target ? 1000 : 0) + (/premium|enhanced/i.test(voice.name) ? 100 : 0) + (/alex|samantha|daniel|karen|moira|tessa|ava|allison|serena|oliver/i.test(voice.name) ? 50 : 0) + (voice.default ? 10 : 0);
    const voice = ordinary.sort((a,b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
    if (!voice) throw new PronunciationError("voice-unavailable");
    return { voice, downgraded: voice.lang.toLowerCase() !== target };
}
export class SystemSpeechProvider implements PronunciationProvider {
    id = "system";
    supports(request?: PronunciationRequest): boolean { return request?.allowSystem !== false; }
    async generate(request: PronunciationRequest, signal: AbortSignal): Promise<PronunciationOutput> {
        if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") throw new PronunciationError("speech-unavailable");
        let voices = speechSynthesis.getVoices();
        if (!voices.length) voices = await new Promise<SpeechSynthesisVoice[]>((resolve, reject) => {
            const done = (): void => { clearTimeout(timer); speechSynthesis.removeEventListener("voiceschanged", changed); signal.removeEventListener("abort", aborted); };
            const changed = (): void => { const result = speechSynthesis.getVoices(); if (result.length) { done(); resolve(result); } };
            const aborted = (): void => { done(); reject(new PronunciationError("cancelled")); };
            const timer = setTimeout(() => { done(); resolve(speechSynthesis.getVoices()); }, 1000);
            speechSynthesis.addEventListener("voiceschanged", changed); signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted(); else changed();
        });
        const { voice, downgraded } = selectVoice(voices, request);
        return { kind: "speech", voice, text: request.text, language: voice.lang, rate: request.rate || 1, downgraded };
    }
}
