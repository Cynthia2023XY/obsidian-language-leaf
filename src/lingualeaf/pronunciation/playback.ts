import { PronunciationError } from "./service";
import type { PlaybackPort, PronunciationOutput } from "./service";
export class BrowserPlayback implements PlaybackPort {
    private cancel?: () => void;
    stop(): void { this.cancel?.(); this.cancel = undefined; }
    play(output: PronunciationOutput, signal: AbortSignal, started: () => void): Promise<void> {
        this.stop();
        return new Promise((resolve, reject) => {
            let audio: HTMLAudioElement | undefined; let utterance: SpeechSynthesisUtterance | undefined; let url: string | undefined;
            let settled = false; let didStart = false;
            const startTimer = setTimeout(() => finish(new PronunciationError("start-timeout")), 6000);
            const endTimer = setTimeout(() => finish(new PronunciationError("playback-timeout")), 120000);
            const finish = (error?: unknown): void => {
                if (settled) return; settled = true;
                clearTimeout(startTimer); clearTimeout(endTimer); signal.removeEventListener("abort", abort);
                if (audio) { audio.onplaying = audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute("src"); audio.load(); }
                if (utterance) { utterance.onstart = utterance.onend = utterance.onerror = null; speechSynthesis.cancel(); }
                if (url) URL.revokeObjectURL(url);
                this.cancel = undefined;
                if (error) reject(error); else resolve();
            };
            const abort = (): void => finish(new PronunciationError("cancelled"));
            const onStart = (): void => { if (settled || didStart) return; didStart = true; clearTimeout(startTimer); started(); };
            this.cancel = abort;
            if (signal.aborted) { abort(); return; }
            signal.addEventListener("abort", abort, { once: true });
            try {
                if (output.kind === "audio") {
                    url = URL.createObjectURL(new Blob([output.bytes], { type: output.mime })); audio = new Audio(url);
                    audio.onplaying = onStart; audio.onended = () => finish(); audio.onerror = () => finish(new PronunciationError("decode"));
                    audio.play()?.catch(() => finish(new PronunciationError("playback-blocked")));
                } else {
                    utterance = new SpeechSynthesisUtterance(output.text); utterance.voice = output.voice; utterance.lang = output.language; utterance.rate = output.rate;
                    utterance.onstart = onStart; utterance.onend = () => didStart ? finish() : finish(new PronunciationError("speech-no-start"));
                    utterance.onerror = () => finish(new PronunciationError("speech-playback"));
                    speechSynthesis.speak(utterance);
                }
            } catch { finish(new PronunciationError("playback")); }
        });
    }
}
