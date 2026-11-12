import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {ChatService,type ChatHosts} from "../src/main/chat/service";
import {ColdLink,coldHosts,coldPath,coldSession,coldFolder,runClock} from "./support/cold-link";
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe("cold load lifecycle boundaries",()=>{
 for(const change of ["session","connection","arrival"] as const)it(change+" starts a new feed",async()=>{
  const link=new ColdLink(coldPath,coldSession({textTurns:10,imageTurns:3}));const reader=link.reader("relay");const base=coldHosts(reader,()=>true);let terminal="t-first",cwd=coldFolder;let backend=base.backend("mini");let id:string|null=null;
  const hosts={...base,backend:()=>backend,pane:(host:string,pane:string)=>({...base.pane(host,pane)!,terminalID:terminal,cwd}),agent:(host:string,pane:string)=>{const a=base.agent(host,pane)!;return {...a,terminalID:terminal,cwd,agentSession:id===null?a.agentSession:{...a.agentSession!,value:id}};}} as ChatHosts;
  const service=new ChatService(hosts,"chat");const owner={id:99,send:()=>undefined,isDestroyed:()=>false};service.open(owner,"mini","w1:p1");const current=()=>[...(service as any).windows.values()][0];const first=current().feed;let loaded=false;void first.loaded().then(()=>loaded=true);await runClock(()=>loaded,30000);
  if(change==="session")id="9b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
  if(change==="connection")backend={transcripts:()=>reader} as never;
  if(change==="arrival"){terminal="t-second";cwd=coldFolder+"/Sources";}
  service.refresh();const after=current().feed;service.closeAll();expect(after).not.toBe(first);
 });
});
