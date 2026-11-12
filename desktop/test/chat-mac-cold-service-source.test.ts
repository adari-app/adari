// Boundary cases for the cold link's service. `place` names the cold link's host constant ("mini"); two omit
// rows' arrows have braces (the typecheck refuses an assignment's implicit `any` return in an `as const` table);
// the omit table keeps three passing rows beside the null-omitted one.
//   Main's blob cache lets a picture go when its last window chat is hidden or unavailable.
//   A read reply with "omitted":null is a failed read, omit kept on.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChatService} from '../src/main/chat/service';
import {coldHost,coldLines,coldPath,coldServiceOpen,shownBlobs} from './support/cold-link';
import {RelayClient} from '../src/main/herdr/relay';
import {SshTranscriptReader} from '../src/main/chat/ssh-reader';
import {PinningHostKeyPolicy,MemoryPinStore} from '../src/main/herdr/host-key-pinning';
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const current=(s:ChatService)=>[...(s as any).windows.values()][0];
const place={hostId:coldHost,slot:''};
describe('main blob cache boundaries',()=>{
 async function setup(){const {service,run}=await coldServiceOpen({mode:'relay',text:coldLines.userWithShot('u','image','A'.repeat(2000),1)+'\n',cache:null});return {service,run,chat:current(service),blob:shownBlobs(current(service).timeline)[0]!};}
 it.each(['hidden','unavailable'] as const)('drops images when its last window chat is %s',async change=>{
  const {service,chat,blob}=await setup();vi.spyOn(chat.feed,'fetchImage').mockResolvedValue('A'.repeat(2000));await service.blobImage({id:1},blob,place);await settle();expect(service.blobImagesKept.bytes).toBeGreaterThan(0);
  if(change==='hidden')service.setPaused({id:1},true);
  else {const hosts=(service as any).hosts;hosts.agent=()=>null;hosts.pane=()=>null;service.refresh();}
  expect(chat.handle).toBeNull();console.log('UNFOLLOWED_BLOB',change,service.blobImagesKept);expect(service.blobImagesKept).toEqual({count:0,bytes:0});service.closeAll();
 });
});
function malformedReader(change:(a:any)=>void){let first=true;const frames:any[]=[];let client:RelayClient;const data=Buffer.from('hello\n');client=new RelayClient({write:raw=>{const f=JSON.parse(raw);frames.push(f);const a:any={relay:'read',id:f.id,size:data.length,ino:7,offset:0,data:data.toString('base64'),...(f.omit===undefined?{}:{omitted:[]})};if(first){first=false;change(a);}queueMicrotask(()=>client.data(Buffer.from(JSON.stringify(a)+'\n')));},close:()=>undefined},'/fake/relay.sock');client.data(Buffer.from('{"relay":"hello","v":1}\n'));const reader=new SshTranscriptReader({host:'fixture.invalid',port:22,username:'fixture',privateKeyPath:'',herdrSession:'default'},new PinningHostKeyPolicy(new MemoryPinStore()),{relay:async()=>client,timeoutMs:20});return {reader,frames};}
describe('exact omit downgrade contract',()=>{
 it.each([['null omitted',(a:any)=>{a.omitted=null;}],['negative offset',(a:any)=>{a.offset=-1;}],['null size and missing offset',(a:any)=>{a.size=null;delete a.offset;}],['malformed omitted and missing offset',(a:any)=>{a.omitted='invalid';delete a.offset;}] ] as const)('%s is failed with omit kept',async(_name,change)=>{const {reader,frames}=malformedReader(change);let failed=false;await reader.readWithIdentity(coldPath,0,512,{omit:true,tail:512}).catch(()=>failed=true);await reader.readWithIdentity(coldPath,0,512,{omit:true});expect({failed,omit:frames.at(-1).omit}).toEqual({failed:true,omit:1024});});
});
