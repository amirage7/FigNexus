import {z} from 'zod';
const Challenge=z.object({id:z.string().uuid(),secret:z.string().min(64).max(64),code:z.string().regex(/^\d{6}$/),expires:z.number().int()}).strict();
const State=z.discriminatedUnion('state',[z.object({state:z.literal('pending')}).strict(),z.object({state:z.literal('paired'),token:z.string().min(32).max(256)}).strict()]);
export type QuickPairView={waiting:boolean;code?:string;notice:string};
function wait(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
  if(signal.aborted){reject(Error('Cancelled'));return;}
  const done=()=>{signal.removeEventListener('abort',cancel);resolve();};
  const timer=setTimeout(done,ms),cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(Error('Cancelled'));};
  signal.addEventListener('abort',cancel,{once:true});
});}
export class QuickPairingClient{
  private active?:AbortController;
  private challenge?:{id:string;secret:string};
  constructor(private accept:(token:string,signal:AbortSignal)=>Promise<void>,private render:(view:QuickPairView)=>void,private fetcher:typeof fetch=fetch,private pause:typeof wait=wait){}
  private revoke(challenge:{id:string;secret:string}){const c=new AbortController(),timer=setTimeout(()=>c.abort(),5000);void Promise.resolve().then(()=>this.fetcher.call(globalThis,'http://localhost:3055/v1/pair/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(challenge),signal:c.signal})).catch(()=>{}).finally(()=>clearTimeout(timer));}
  cancel(){if(this.challenge){this.revoke(this.challenge);this.challenge=undefined;}this.active?.abort();this.active=undefined;this.render({waiting:false,notice:''});}
  async start(){
    this.cancel();const controller=new AbortController();this.active=controller;
    const current=()=>this.active===controller&&!controller.signal.aborted;
    const post=async(path:string,body:unknown)=>{
      // Figma desktop may embed Chromium without AbortSignal.any. Compose
      // cancellation using the long-established AbortController API instead.
      const request=new AbortController(),cancel=()=>request.abort();
      controller.signal.addEventListener('abort',cancel,{once:true});
      const timeout=setTimeout(cancel,5000);if(controller.signal.aborted)cancel();
      try{
        const response=await this.fetcher.call(globalThis,'http://localhost:3055'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:request.signal});
        if(!response.ok)throw Error('Bridge pairing unavailable');return await response.json();
      }finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',cancel);}
    };
    let phase='发起配对';
    this.render({waiting:true,notice:'正在请求本机配对…'});
    try{
      const challenge=Challenge.parse(await post('/v1/pair/start',{}));if(!current()){this.revoke({id:challenge.id,secret:challenge.secret});return;}this.challenge={id:challenge.id,secret:challenge.secret};
      if(challenge.expires<=Date.now()||challenge.expires>Date.now()+125000)throw Error('Invalid pairing deadline');
      this.render({waiting:true,code:challenge.code,notice:'本机确认窗口会自动弹出，请核对相同数字并点击“是”。有效期两分钟。'});
      phase='等待本机确认';
      while(current()&&Date.now()<challenge.expires){
        const result=State.parse(await post('/v1/pair/poll',{id:challenge.id,secret:challenge.secret}));if(!current())return;
        if(result.state==='paired'){this.challenge=undefined;phase='建立连接';await this.accept(result.token,controller.signal);if(current())this.render({waiting:false,notice:'配对完成，已连接本机。'});return;}
        await this.pause(1000,controller.signal);
      }
      if(current())this.render({waiting:false,notice:'配对已过期，请重新开始。'});
    }catch{if(current())this.render({waiting:false,notice:`配对失败（${phase}），请确认本机服务已启动，或使用“开始使用”入口后重试。`});}
    finally{if(this.active===controller){if(this.challenge){this.revoke(this.challenge);this.challenge=undefined;}this.active=undefined;}}
  }
}
