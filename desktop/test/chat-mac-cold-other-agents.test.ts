import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import {ChatFeed,standardColdLoad,type TranscriptReadOptions} from "../src/shared/chat/feed";
import {makeSessionRef} from "../src/shared/chat/locator";
import {rebuildOmitted} from "../src/shared/chat/blobs";
import {FakeTranscriptReader} from "./support/chat-lines";
import {relayOmit,runClock} from "./support/cold-link";
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
class OmitReader extends FakeTranscriptReader {
 readonly identityAsks:{at:number,max:number,omit:boolean}[]=[];
 async readWithIdentity(path:string,at:number,max:number,options:TranscriptReadOptions={}){
  this.identityAsks.push({at,max,omit:options.omit===true});
  const size=await super.size(path);const full=await super.read(path,0,size);const start=options.tail===undefined?at:Math.max(0,size-options.tail);
  const raw=full.subarray(start,start+max);const out=options.omit?relayOmit(full,start,raw,1024):{kept:raw,omitted:[]};
  return {size,ino:77,offset:start,data:rebuildOmitted(start,out.kept,out.omitted)!,omitted:out.omitted};
 }
}
describe("other agents preserve their text and item ids under omitted reads",()=>{
 for(const format of ["codex","grok"] as const)it(format,async()=>{
  const id=format==="grok"?"01a19e72-280e-7291-9d2d-8c2ac0bdb217":"019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b";
  const path=format==="grok"?`/Users/fixture/.grok/sessions/%2FUsers%2Ffixture%2Fproj/${id}/updates.jsonl`:`/fake/${id}.jsonl`;
  const question="question "+"A".repeat(2000),answer="answer "+"B".repeat(2000);
  const lines=format==="codex"?[
   {type:"session_meta",timestamp:"2026-11-01T03:00:00.000Z",payload:{cwd:"/Users/fixture/proj"}},
   {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:question}]}},
   {type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:answer}]}}
  ]:[
   {method:"session/update",params:{sessionId:id,update:{sessionUpdate:"user_message_chunk",content:{type:"text",text:question}}}},
   {method:"session/update",params:{sessionId:id,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:answer}}}}
  ];
  const original=lines.map(l=>JSON.stringify(l)).join("\n")+"\n";
  const plain=new FakeTranscriptReader(),omitted=new OmitReader();
  for(const reader of [plain,omitted]){reader.put(path,original,path);if(format==="grok")reader.put(path.replace(/updates.jsonl$/,"summary.json"),JSON.stringify({info:{cwd:"/Users/fixture/proj"}}),null);}
  const feeds=[new ChatFeed(plain,{cold:standardColdLoad}),new ChatFeed(omitted,{cold:standardColdLoad})];
  const session=makeSessionRef(format,{kind:"id",id})!;let done=0;
  for(const feed of feeds){feed.start(session);void feed.loaded().then(()=>done++);}await runClock(()=>done===2,10000);
  expect(feeds[1]!.state).toEqual({status:"live"});expect(feeds[1]!.timeline).toEqual(feeds[0]!.timeline);
  expect(JSON.stringify(feeds[1]!.timeline)).toContain(question);expect(JSON.stringify(feeds[1]!.timeline)).toContain(answer);for(const feed of feeds)feed.stop();
 });
 it("does not eagerly restore the base64 of an unshown Grok picture",async()=>{
  const id="01a19e72-280e-7291-9d2d-8c2ac0bdb217",path=`/Users/fixture/.grok/sessions/%2FUsers%2Ffixture%2Fproj/${id}/updates.jsonl`;
  const line=JSON.stringify({method:"session/update",params:{sessionId:id,update:{sessionUpdate:"user_message_chunk",content:{type:"image",mimeType:"image/png",data:"A".repeat(200000)}}}})+"\n";
  const reader=new OmitReader();reader.put(path,line,path);reader.put(path.replace(/updates.jsonl$/,"summary.json"),JSON.stringify({info:{cwd:"/Users/fixture/proj"}}),null);
  const feed=new ChatFeed(reader,{cold:standardColdLoad});feed.start(makeSessionRef("grok",{kind:"id",id})!);let done=false;void feed.loaded().then(()=>done=true);await runClock(()=>done,10000);
  expect(feed.state).toEqual({status:"live"});const plain=reader.identityAsks.filter(r=>!r.omit&&r.max>0);feed.stop();
  console.log("GROK_IMAGE_EAGER_RESTORES",JSON.stringify(plain));expect(plain).toHaveLength(0);
 });

});
