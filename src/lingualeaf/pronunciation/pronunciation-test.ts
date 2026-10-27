import { afterEach, describe, expect, it, vi } from "vitest";
import { PronunciationService, PronunciationError, validateAudio, isSingleWord } from "./service";
import type { PlaybackPort, PronunciationOutput, PronunciationProvider, PronunciationRequest } from "./service";
import { SystemSpeechProvider, YoudaoProvider, selectVoice } from "./providers";
const request: PronunciationRequest = { text: "hello", language: "en", accent: "us", trigger: "manual", owner: "test" };
function bytes(): ArrayBuffer { const data = new Uint8Array(24); data.set([73,68,51]); return data.buffer; }
function playback(fail = false): PlaybackPort { return { stop: vi.fn(), play: vi.fn(async (_output, _signal, start) => { if (fail) throw new PronunciationError("decode"); start(); }) }; }
afterEach(() => vi.unstubAllGlobals());
describe("统一发音", () => {
    it("词典接口错误、HTML/JSON、空音频被拒绝", () => {
        expect(() => validateAudio(500,"audio/mpeg",bytes())).toThrow("server");
        expect(() => validateAudio(200,"text/html",bytes())).toThrow("invalid-audio");
        expect(() => validateAudio(200,"audio/mpeg",new ArrayBuffer(0))).toThrow();
        expect(() => validateAudio(200,"audio/mpeg",new TextEncoder().encode('<html>not audio</html>').buffer)).toThrow();
        expect(() => validateAudio(200,"audio/mpeg",bytes())).not.toThrow();
    });
    it("短语和句子不再盲目请求词典接口", () => {
        const provider = new YoudaoProvider(vi.fn());
        expect(provider.supports(request)).toBe(true);
        expect(provider.supports({ ...request,text:"the crease in his brow" })).toBe(false);
        expect(isSingleWord("well-being")).toBe(true);
    });
    it("优先词典录音地址，并映射美音到 type=2", async () => {
        const transport = vi.fn(async () => ({ status:200,mime:"audio/mpeg",bytes:bytes() }));
        const provider = new YoudaoProvider(transport);
        await provider.generate(request,new AbortController().signal);
        expect(transport.mock.calls[0][0]).toContain("type=2");
        provider.register("hello","us","https://dict.youdao.com/dictvoice?audio=recording&type=2");
        await provider.generate(request,new AbortController().signal);
        expect(transport.mock.calls[1][0]).toContain("audio=recording");
    });
    it("临时服务故障只重试一次", async () => {
        const transport=vi.fn(async () => ({ status:500,mime:"text/html",bytes:bytes() }));
        await expect(new YoudaoProvider(transport).generate(request,new AbortController().signal)).rejects.toThrow("server");
        expect(transport).toHaveBeenCalledTimes(2);
    });
    it("失败转入备用来源，日志不包含原文和URL", async () => {
        const warn=vi.spyOn(console,"warn").mockImplementation(() => {});
        const first: PronunciationProvider={ id:"youdao",supports:()=>true,generate:async()=>{throw new PronunciationError("invalid-audio");} };
        const next: PronunciationProvider={ id:"local-future",supports:()=>true,generate:async()=>({kind:"audio",bytes:bytes(),mime:"audio/mpeg"}) };
        const port=playback();const service=new PronunciationService([first,next],port);
        await service.speak(request);expect(port.play).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("hello");warn.mockRestore();service.dispose();
    });
    it("成功播放后缓存，切换口音不会误用缓存", async () => {
        const generate=vi.fn(async ():Promise<PronunciationOutput>=>({kind:"audio",bytes:bytes(),mime:"audio/mpeg"}));
        const provider:PronunciationProvider={id:"test",supports:()=>true,cacheKey:r=>r.text+r.accent,generate};
        const service=new PronunciationService([provider],playback());
        await service.speak(request);await service.speak(request);expect(generate).toHaveBeenCalledTimes(1);
        await service.speak({...request,accent:"uk"});expect(generate).toHaveBeenCalledTimes(2);service.dispose();
    });
    it("解码失败的结果不会留在缓存中", async () => {
        const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
        const generate=vi.fn(async ():Promise<PronunciationOutput>=>({kind:"audio",bytes:bytes(),mime:"audio/mpeg"}));
        const service=new PronunciationService([{id:"test",supports:()=>true,cacheKey:()=>"x",generate}],playback(true));
        const states:string[]=[];service.subscribe(state=>states.push(state.phase));
        await service.speak(request);await service.speak(request);expect(generate).toHaveBeenCalledTimes(2);expect(states).toContain("error");service.dispose();warn.mockRestore();
    });
    it("取消或切卡后，迟到的生成结果不播放", async () => {
        let finish!:(value:PronunciationOutput)=>void;
        const provider:PronunciationProvider={id:"slow",supports:()=>true,generate:()=>new Promise(resolve=>{finish=resolve;})};
        const port=playback();const service=new PronunciationService([provider],port);
        const pending=service.speak(request);service.stop("test");finish({kind:"audio",bytes:bytes(),mime:"audio/mpeg"});await pending;
        expect(port.play).not.toHaveBeenCalled();service.dispose();
    });
    it("新请求覆盖旧请求，相同的进行中请求去重", async () => {
        let finish!:(value:PronunciationOutput)=>void;
        const generate=vi.fn((r:PronunciationRequest):Promise<PronunciationOutput>=>r.text==="hello"?new Promise(resolve=>{finish=resolve;}):Promise.resolve({kind:"audio",bytes:bytes(),mime:"audio/mpeg"}));
        const port=playback();const service=new PronunciationService([{id:"test",supports:()=>true,generate}],port);
        const old=service.speak(request);await service.speak(request);expect(generate).toHaveBeenCalledTimes(1);
        await service.speak({...request,text:"world"});finish({kind:"audio",bytes:bytes(),mime:"audio/mpeg"});await old;
        expect(port.play).toHaveBeenCalledTimes(1);service.dispose();
    });
    it("系统语音按语言与口音选择，可提示同语言降级", async () => {
        const voice={name:"English",lang:"en-GB"} as SpeechSynthesisVoice;
        vi.stubGlobal("speechSynthesis",{getVoices:()=>[voice]});vi.stubGlobal("SpeechSynthesisUtterance",class {});
        const result=await new SystemSpeechProvider().generate(request,new AbortController().signal);
        expect(result.kind).toBe("speech");expect((result as any).downgraded).toBe(true);
        await expect(new SystemSpeechProvider().generate({...request,language:"fr"},new AbortController().signal)).rejects.toThrow("voice-unavailable");
    });
    it("没有系统朗读能力时明确失败", async () => {
        vi.stubGlobal("speechSynthesis",undefined);
        await expect(new SystemSpeechProvider().generate(request,new AbortController().signal)).rejects.toThrow("speech-unavailable");
    });
});


describe("声音选择与系统朗读开关", () => {
    const makeVoice = (name: string, lang = "en-US", uri = name): SpeechSynthesisVoice => ({ name, lang, voiceURI: uri, default: false, localService: true });
    it("自动选择避开特殊声音，并优先普通增强音色与所选口音", () => {
        const voices = [makeVoice("Albert"), makeVoice("Zarvox"), makeVoice("Samantha"), makeVoice("Samantha (Enhanced)"), makeVoice("Daniel", "en-GB")];
        expect(selectVoice(voices, request).voice.name).toBe("Samantha (Enhanced)");
        expect(selectVoice(voices, { ...request, accent: "uk" }).voice.name).toBe("Daniel");
    });
    it("保存的 voiceURI 能精确指定同语言声音", () => {
        const voices = [makeVoice("Samantha"), makeVoice("Ava", "en-US", "voice-ava")];
        expect(selectVoice(voices, { ...request, voice: "voice-ava" }).voice.name).toBe("Ava");
        expect(() => selectVoice(voices, { ...request, voice: "missing" })).toThrow("selected-voice-unavailable");
    });
    it("不默默选择错误语言，或在只有特殊效果音色时自动播放", () => {
        expect(() => selectVoice([makeVoice("Albert")], request)).toThrow("voice-unavailable");
        expect(() => selectVoice([makeVoice("French", "fr-FR")], request)).toThrow("voice-unavailable");
    });
    it("系统朗读关闭时不支持自动路由，但试听可以显式启用", () => {
        const provider = new SystemSpeechProvider();
        expect(provider.supports({ ...request, allowSystem: false })).toBe(false);
        expect(provider.supports({ ...request, allowSystem: true, systemOnly: true })).toBe(true);
        expect(new YoudaoProvider(vi.fn()).supports({ ...request, systemOnly: true })).toBe(false);
    });
});
