import {randomBytes,randomUUID,randomInt,timingSafeEqual} from 'node:crypto';
type Challenge={id:string;secret:string;code:string;expires:number;approved:boolean;failures:number};
const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Local confirmation capability is deliberately separate from the MCP token. */
export class QuickPairing{
  private challenges=new Map<string,Challenge>();
  constructor(private token:string,private approvalSecret:string){
    if(token.length<32||approvalSecret.length<32)throw Error('Invalid pairing credentials');
  }
  private prune(){for(const [id,p]of this.challenges)if(p.expires<=Date.now())this.challenges.delete(id);}
  start(){
    this.prune();if(this.challenges.size>=8)throw Error('PAIR_CAPACITY');
    const p={id:randomUUID(),secret:randomBytes(32).toString('hex'),code:String(randomInt(100000,1000000)),expires:Date.now()+120000,approved:false,failures:0};
    this.challenges.set(p.id,p);return {id:p.id,secret:p.secret,code:p.code,expires:p.expires};
  }
  cancelRequest(id:string,secret:string){this.prune();const p=this.challenges.get(id);if(!p||!equal(secret,p.secret))throw Error('PAIR_NOT_FOUND');this.challenges.delete(id);}
  cancel(id:string){this.challenges.delete(id);}
  pending(){this.prune();return [...this.challenges.values()].filter(p=>!p.approved).map(({id,code,expires})=>({id,code,expires}));}
  private failed(p:Challenge){if(++p.failures>=5)this.challenges.delete(p.id);}
  approve(id:string,code:string,secret:string){
    if(!equal(secret,this.approvalSecret))throw Error('UNAUTHORIZED');
    this.prune();const p=this.challenges.get(id);if(!p)throw Error('PAIR_NOT_FOUND');
    if(!equal(code,p.code)){this.failed(p);throw Error('PAIR_CODE_MISMATCH');}p.approved=true;
  }
  poll(id:string,secret:string){
    this.prune();const p=this.challenges.get(id);if(!p)throw Error('PAIR_NOT_FOUND');
    if(!equal(secret,p.secret)){this.failed(p);throw Error('PAIR_NOT_FOUND');}
    if(!p.approved)return {state:'pending' as const};
    this.challenges.delete(id);return {state:'paired' as const,token:this.token};
  }
}
