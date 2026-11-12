import { afterEach, describe, expect, it, vi } from "vitest";
import { attachment, type ChatImageBlob } from "../src/shared/chat/model";
import { HookHost, find } from "./support/fake-hooks";
vi.mock("react", async (importOriginal) => {
 const actual=await importOriginal<typeof import("react")>(); const {fakeReact}=await import("./support/fake-hooks"); const hooks={...fakeReact,useLayoutEffect:fakeReact.useEffect};
 return {...actual,...hooks,default:{...actual,...hooks}};
});
const {Thumb,blobPictureBudget}=await import("../src/renderer/chat/ChatView");
const place={hostId:"a"};
afterEach(()=>vi.unstubAllGlobals());
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const ref=(i:number):ChatImageBlob=>({path:"/Users/fixture/.claude/projects/proj/s.jsonl",ino:777,parts:[[i*2000,1500]]});
describe("image cache and reference transitions",()=>{
 it("shows a frame immediately when an inline image reference changes",async()=>{
  const one=ref(100); const two=ref(101);
  let finish: (v:string|null)=>void=()=>undefined;
  vi.stubGlobal("window",{herdrDesktop:{chatBlobImage:(b:ChatImageBlob)=>b.parts[0]![0]===200000?Promise.resolve("data:image/png;base64,OLD"):new Promise<string|null>(r=>{finish=r;})}});
  const view=new HookHost(Thumb as (props:object)=>unknown,{attachment:attachment(null,"image/png",one),place});view.render();await settle();
  expect(find(view.tree,"img")?.props["src"]).toContain("OLD");
  view.render({attachment:attachment(null,"image/png",two),place});
  const current=find(view.tree,"img")?.props["src"]; finish(null); await settle(); view.unmount();
  expect(current).toBeUndefined();
 });
 it("clears the old bitmap when an inline attachment becomes a frame without a blob",async()=>{
  vi.stubGlobal("window",{herdrDesktop:{chatBlobImage:()=>Promise.resolve("data:image/png;base64,OLD_FRAME")}});
  const view=new HookHost(Thumb as (props:object)=>unknown,{attachment:attachment(null,"image/png",ref(200)),place});view.render();await settle();
  view.render({attachment:attachment(null,"image/png"),place});await settle();
  const current=find(view.tree,"img")?.props["src"];view.unmount();expect(current).toBeUndefined();
 });
 it("evicts blob URLs after many pictures have been shown and unmounted",async()=>{
  const url="data:image/png;base64,CACHE"+"A".repeat(Math.ceil(blobPictureBudget/50));
  let calls=0;vi.stubGlobal("window",{herdrDesktop:{chatBlobImage:()=>{calls++;return Promise.resolve(url);}}});
  for(let i=0;i<60;i++){const v=new HookHost(Thumb as (props:object)=>unknown,{attachment:attachment(null,"image/png",ref(1000+i)),place});v.render();await settle();v.unmount();}
  const v=new HookHost(Thumb as (props:object)=>unknown,{attachment:attachment(null,"image/png",ref(1000)),place});v.render();await settle();v.unmount();
  expect(calls).toBeGreaterThan(60);
 });
 it("asks main when the same file coordinates belong to another host",async()=>{
  let host="a";const calls:string[]=[];vi.stubGlobal("window",{herdrDesktop:{chatBlobImage:()=>{calls.push(host);return Promise.resolve("data:image/png;base64,"+host);}}});
  const wanted=ref(3000);const a=new HookHost(Thumb as (props:object)=>unknown,{attachment:attachment(null,"image/png",wanted),place:{hostId:"a"}});a.render();await settle();a.unmount();
  host="b";const b=new HookHost(Thumb as (props:object)=>unknown,{attachment:attachment(null,"image/png",wanted),place:{hostId:"b"}});b.render();await settle();const current=find(b.tree,"img")?.props["src"];b.unmount();
  expect(calls).toEqual(["a","b"]);expect(current).toBe("data:image/png;base64,b");
 });
});
