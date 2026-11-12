import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/main/chat/service";
import { SshTranscriptReader } from "../src/main/chat/ssh-reader";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { RelayClient } from "../src/main/herdr/relay";
import { ChatFeed, standardColdLoad } from "../src/shared/chat/feed";
import { blobsToRestore, rebuildOmitted, type BlobRange } from "../src/shared/chat/blobs";
import { TranscriptFollower } from "../src/shared/chat/follower";
import { coldFeedOpen, coldServiceOpen, coldLines, coldPath, coldSession, ColdLink, coldHosts, cachedChat, runClock, shownBlobs, itemCount, coldHost } from "./support/cold-link";
import { claudeSession, FakeTranscriptReader } from "./support/chat-lines";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function customReader(change: (answer: Record<string, unknown>, frame: Record<string, unknown>) => void) {
 const frames: Record<string, unknown>[] = [];
 let client: RelayClient;
 const data=Buffer.from(coldLines.user("u", "hello", 1)+"\n");
 client=new RelayClient({write: (raw: string) => {
  const f=JSON.parse(raw); frames.push(f);
  const at=f.tail===undefined ? Number(f.offset) : Math.max(0,data.length-Number(f.tail));
  const a: Record<string, unknown>={relay:"read",id:f.id,size:data.length,ino:7,offset:at,data:Buffer.from(data.subarray(at,at+Number(f.max))).toString("base64"),...(f.omit===undefined?{}:{omitted:[]})};
  change(a,f); queueMicrotask(()=>client.data(Buffer.from(JSON.stringify(a)+"\n")));
 },close:()=>undefined},"/fake/relay.sock");
 client.data(Buffer.from('{"relay":"hello","v":1}\n'));
 const reader=new SshTranscriptReader({host:"fixture.invalid",port:22,username:"fixture",privateKeyPath:"",herdrSession:"default"},new PinningHostKeyPolicy(new MemoryPinStore()),{relay:async()=>client, timeoutMs:20});
 return {reader,client,frames};
}

describe("cold load boundaries",()=>{
 it("preserves omit after a malformed omitted list in a tail reply with a valid offset",async()=>{
  let first=true;
  const {reader,frames}=customReader((a,f)=>{if(first&&f.tail!==undefined){first=false;a.omitted="invalid";}});
  await reader.readWithIdentity(coldPath,0,512,{omit:true,tail:512}).catch(()=>null);
  await reader.readWithIdentity(coldPath,0,512,{omit:true});
  expect(frames.at(-1)?.omit).toBe(1024);
 });
 it("preserves omit after a malformed size in a tail reply with a valid offset",async()=>{
  let first=true;
  const {reader,frames}=customReader((a,f)=>{if(first&&f.tail!==undefined){first=false;a.size=null;}});
  await reader.readWithIdentity(coldPath,0,512,{omit:true,tail:512}).catch(()=>null);
  await reader.readWithIdentity(coldPath,0,512,{omit:true});
  expect(frames.at(-1)?.omit).toBe(1024);
 });
 it("missing tail offset disables omit, then returns the right plain bytes",async()=>{
  let first=true;
  const {reader,frames}=customReader((a,f)=>{if(first&&f.tail!==undefined){first=false;a.offset=null;}});
  const got=await reader.readWithIdentity(coldPath,0,512,{omit:true,tail:512});
  expect(new TextDecoder().decode(got!.data)).toContain("hello");
  await reader.readWithIdentity(coldPath,0,512,{omit:true});
  expect(frames.at(-1)?.omit).toBeUndefined();
 });
 it("timeout and dropped connection preserve omit for the next relay",async()=>{
  for(const failure of ["timeout","drop"]){
   let first=true;
   const {reader,client,frames}=customReader((a,_f)=>{if(first){first=false;a.relay="ignored";}});
   const pending=reader.readWithIdentity(coldPath,0,512,{omit:true,tail:512});
   const caught=pending.catch(()=>null);
   await Promise.resolve(); await Promise.resolve();
   if(failure==="drop") client.finish("probe drop");
   await vi.advanceTimersByTimeAsync(30); await caught;
   // The reader property is the state under test; the closed client cannot itself recover.
   expect((reader as unknown as {omits:boolean}).omits).toBe(true);
   expect(frames[0]?.omit).toBe(1024);
  }
 });
 it("keeps a valid numeric line after its whole-line reread fails once and the relay recovers",async()=>{
  const lost=coldLines.user("lost","must survive transient reread failure",3).replace(/}$/,',"n":'+"7".repeat(1100)+'}');
  const original=[coldLines.user("u1","hello",1),coldLines.agent("a1","first",2),lost,coldLines.agent("a2","second",4)].join("\n")+"\n";
  const {run,feed}=await coldFeedOpen({mode:"relay",text:original,link:l=>{l.plainReadsFail=true;}});
  run.link.plainReadsFail=false;
  run.link.append(coldLines.user("u9","after recovery",5)+"\n");
  await runClock(()=>JSON.stringify(feed.timeline).includes("after recovery"),30000);
  const rendered=JSON.stringify(feed.timeline); feed.stop();
  expect(rendered).toContain("must survive transient reread failure");
 });
 it("rejects other path, inode and parts, unsafe media types and oversize images without range reads",async()=>{
  const {run,service}=await coldServiceOpen({mode:"relay",text:coldLines.userWithShot("u","shot","A".repeat(2000),1)+"\n",cache:null});
  const win=[...(service as any).windows.values()][0]; const blob=shownBlobs(win.timeline)[0]!;
  const before=run.link.readsOf().length;const place={hostId:coldHost,slot:""};
  expect(await service.blobImage({id:1},{...blob,path:"/other.jsonl"},place)).toBeNull();
  expect(await service.blobImage({id:1},{...blob,ino:blob.ino!+1},place)).toBeNull();
  expect(await service.blobImage({id:1},{...blob,parts:[[0,99999999]]},place)).toBeNull();
  const attachment=win.timeline.turns[0].items[0].value.attachments[0];
  const old=attachment.mediaType; attachment.mediaType="image/svg+xml";
  expect(await service.blobImage({id:1},blob,place)).toBeNull(); attachment.mediaType=old;
  const parts=blob.parts; (blob as any).parts=[[0,20_000_000]];
  expect(await service.blobImage({id:1},blob,place)).toBeNull(); (blob as any).parts=parts;
  expect(run.link.readsOf().length).toBe(before); service.closeAll();
 });
 it("restores an omitted JSON object key with a 1100-character name by rereading the line",()=>{
  const key="7".repeat(1100); const full='{'+JSON.stringify(key)+':1,"text":"hello"}';
  const at=2; const range: BlobRange=[at,1100]; const bytes=new TextEncoder().encode(full);
  const kept=new Uint8Array([...bytes.subarray(0,at),...bytes.subarray(at+1100)]);
  const follower=new TranscriptFollower(); follower.nextRead(bytes.length+1);
  const rebuilt=rebuildOmitted(0,new Uint8Array([...kept,10]),[range])!;
  const line=follower.consumeLines(0,rebuilt,[range])[0]!;
  expect(blobsToRestore(line.text,[range]).whole).toBe(true);
 });
 it("stops cold fill at a pause and resumes its carried reader without repeated bytes",async()=>{
  const reader=new FakeTranscriptReader(); const content=coldSession({textTurns:20,imageTurns:6}); reader.put(coldPath,content,coldPath);
  const feed=new ChatFeed(reader,{cold:standardColdLoad,pollIntervalMs:5}); let paused=false;
  feed.subscribe(u=>{if(!paused&&u.state.status==="live"&&u.timeline.earlier==="loading"){paused=true;feed.pause();}});
  feed.start(claudeSession); await runClock(()=>paused,5000);
  const count=reader.calls.length; await vi.advanceTimersByTimeAsync(3000); expect(reader.calls.length).toBe(count);
  feed.resume(); await runClock(()=>itemCount(feed.timeline)>=20||feed.timeline.turns.length>=4,10000); expect(itemCount(feed.timeline)).toBeGreaterThan(1); feed.stop();
 });
 it("measures full-screen text while thumbnails fetch immediately on each published timeline",async()=>{
  const seen=new Set<string>(); const fetching: Promise<unknown>[]=[];
  const {run,feed}=await coldFeedOpen({mode:"relay",text:coldSession(),start:feed=>{
   feed.subscribe(u=>{for(const blob of shownBlobs(u.timeline)){const key=JSON.stringify(blob);if(seen.has(key))continue;seen.add(key);fetching.push(feed.fetchImage(blob));}});
   feed.start(claudeSession);
  }});
  console.log("IMMEDIATE_THUMB_MODEL",run.line("first full screen",run.fullScreen));
  expect(run.fullScreen).toBeDefined(); feed.stop();
 });

 it("gets the picture from the requested host when two slots have the same file path, inode and ranges",async()=>{
  const a=new ColdLink(coldPath,coldLines.userWithShot("u","screen","A".repeat(2000),1)+"\n");
  const b=new ColdLink(coldPath,coldLines.userWithShot("u","screen","B".repeat(2000),1)+"\n");
  const ra=a.reader("relay"), rb=b.reader("relay");const hostsA=coldHosts(ra,()=>true),hostsB=coldHosts(rb,()=>true);
  const hosts={...hostsA,backend:(host:string)=>host==="a"?hostsA.backend(host):hostsB.backend(host)};
  const service=new ChatService(hosts,"chat");const owner={id:77,send:()=>undefined,isDestroyed:()=>false};
  service.open(owner,"a","w1:p1","slot-a");service.open(owner,"b","w1:p1","slot-b");
  const chats=()=>[...(service as any).windows.values()];await runClock(()=>chats().every(c=>c.state.status==="live"),30000);
  const one=shownBlobs(chats()[0].timeline)[0]!,two=shownBlobs(chats()[1].timeline)[0]!;expect(one).toEqual(two);
  let got:string|null|undefined;void service.blobImage(owner,two,{hostId:"b",slot:"slot-b"}).then(v=>{got=v;});await runClock(()=>got!==undefined,10000);service.closeAll();
  expect(got).toBe("data:image/png;base64,"+"B".repeat(2000));
 });

 it("keeps the held cache after a hidden window's feed is evicted from the shelf",async()=>{
  const original=coldSession({textTurns:40,imageTurns:6});const link=new ColdLink(coldPath,original);const reader=link.reader("relay");let answered=false;
  const service=new ChatService(coldHosts(reader,()=>answered),"chat",{}, {},{capacity:0});
  const cache=cachedChat(original);service.useLaunchCache({chat:()=>cache,catchingUp:()=>!answered,noteChat:()=>undefined});
  const updates:any[]=[];const owner={id:55,send:(_c:string,u:any)=>updates.push(u),isDestroyed:()=>false};
  service.open(owner,"mini","w1:p1");answered=true;service.refresh();
  const current=()=>[...(service as any).windows.values()][0];await runClock(()=>current().feed?.state.status==="live",30000);
  expect(current().fromCache).toBe(true);expect(itemCount(current().timeline)).toBe(60);
  service.setPaused(owner,true);expect(service.keptKeys).toHaveLength(0);const at=updates.length;service.setPaused(owner,false);
  await runClock(()=>updates.slice(at).some(u=>u.state.status==="live"&&!u.catchingUp),30000);
  const handover=updates.slice(at).find(u=>u.state.status==="live"&&!u.catchingUp);console.log("EVICTED_HANDOVER",JSON.stringify(handover===undefined?null:{items:itemCount(handover.timeline),earlier:handover.timeline.earlier,catchingUp:handover.catchingUp??false}));service.closeAll();
  expect(handover===undefined||itemCount(handover.timeline)>=60||handover.timeline.earlier==="none").toBe(true);
 });
 it("keeps signature and encrypted-content runs as references without restoring them",async()=>{
  const original=[coldLines.user("u","hello",1),coldLines.agent("a","reply",2).replace(/}$/,',"signature":"'+"A".repeat(2000)+'","encrypted_content":"'+"B".repeat(2000)+'"}')].join("\n")+"\n";
  const {run,feed}=await coldFeedOpen({mode:"relay",text:original});
  expect(run.link.readsOf().filter(r=>r.kind==="relay"&&!r.omit&&r.covered>0)).toHaveLength(0);expect(JSON.stringify(feed.timeline)).toContain("reply");feed.stop();
 });

});
