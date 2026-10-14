import {afterEach,expect,it,vi} from 'vitest';
import {PluginConnection} from '../apps/figma-plugin/src/connection';
const context={instanceId:'hidden-ui',document:{id:'0',name:'Test'},page:{id:'p',name:'Page'}};
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('does not close a healthy WebSocket merely because the UI timer was delayed',async()=>{
  vi.useFakeTimers();let socket:any;const sent:any[]=[];
  class FakeSocket{
    onopen?:()=>void;onmessage?:(e:any)=>void;onclose?:()=>void;onerror?:()=>void;
    send(raw:string){const msg=JSON.parse(raw);sent.push(msg);if(msg.type==='hello')this.onmessage?.({data:JSON.stringify({type:'welcome',version:1,sessionId:'stable',heartbeatMs:3000,leaseMs:10000})});}
    close=vi.fn();constructor(){socket=this;queueMicrotask(()=>this.onopen?.());}
  }
  vi.stubGlobal('WebSocket',FakeSocket);const client=new PluginConnection(()=>context,()=>{},()=>{});
  const promise=client.connect('a'.repeat(64),'ws');await vi.advanceTimersByTimeAsync(0);await promise;
  // A timer resumes 65 seconds later although the transport itself stayed open.
  vi.setSystemTime(Date.now()+65000);await vi.advanceTimersByTimeAsync(3000);
  expect(socket.close).not.toHaveBeenCalled();expect(client.sessionId).toBe('stable');expect(sent.some(m=>m.type==='heartbeat')).toBe(true);
  await client.disconnect();
});
