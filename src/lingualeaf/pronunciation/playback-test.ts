import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPlayback } from "./playback";
afterEach(()=>vi.unstubAllGlobals());
describe("实际播放适配器生命周期",()=>{
    it("系统朗读只有收到 start 才报告开始，结束后清理",async()=>{
        let utterance:any;
        const speech={ speak:vi.fn((u:any)=>{utterance=u;}),cancel:vi.fn() };
        vi.stubGlobal("speechSynthesis",speech);vi.stubGlobal("SpeechSynthesisUtterance",class { constructor(public text:string){} });
        const started=vi.fn();const port=new BrowserPlayback();
        const pending=port.play({kind:"speech",text:"the crease in his brow",language:"en-US",voice:{} as any,rate:1,downgraded:false},new AbortController().signal,started);
        expect(started).not.toHaveBeenCalled();utterance.onstart();expect(started).toHaveBeenCalledTimes(1);
        utterance.onend();await pending;expect(utterance.onstart).toBeNull();expect(speech.cancel).toHaveBeenCalled();
    });
    it("取消朗读不会再触发开始，并结束等待",async()=>{
        let utterance:any;const speech={speak:(u:any)=>{utterance=u;},cancel:vi.fn()};
        vi.stubGlobal("speechSynthesis",speech);vi.stubGlobal("SpeechSynthesisUtterance",class {});
        const signal=new AbortController();const port=new BrowserPlayback();const started=vi.fn();
        const pending=port.play({kind:"speech",text:"test",language:"en-US",voice:{} as any,rate:1,downgraded:false},signal.signal,started);
        const rejected=expect(pending).rejects.toThrow("cancelled");signal.abort();await rejected;
        expect(utterance.onstart).toBeNull();expect(started).not.toHaveBeenCalled();
    });
    it("音频从字节创建 Blob，错误时停止并释放 URL",async()=>{
        let audio:any;
        class FakeAudio { onplaying:any;onended:any;onerror:any;pause=vi.fn();load=vi.fn();removeAttribute=vi.fn(); constructor(_url:string){audio=this;} play(){return Promise.resolve();} }
        const revoke=vi.fn();vi.stubGlobal("Audio",FakeAudio);vi.stubGlobal("URL",{createObjectURL:()=>"blob:audio",revokeObjectURL:revoke});
        const port=new BrowserPlayback();const pending=port.play({kind:"audio",bytes:new ArrayBuffer(24),mime:"audio/mpeg"},new AbortController().signal,vi.fn());
        const rejected=expect(pending).rejects.toThrow("decode");audio.onerror();await rejected;
        expect(audio.pause).toHaveBeenCalled();expect(revoke).toHaveBeenCalledWith("blob:audio");
    });
});
