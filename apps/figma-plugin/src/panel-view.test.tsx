import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {expect,it,vi} from 'vitest';import {PanelView,type PanelViewProps} from './panel-view';import {PairingSession} from './pairing';
const actions={toggle:vi.fn(),pair:vi.fn(),reconnect:vi.fn(),cancel:vi.fn(),remember:vi.fn(),repair:vi.fn(),fallback:vi.fn(),forget:vi.fn(),confirm:vi.fn()};
const base:PanelViewProps={compact:false,status:'在线 · ws · private-session',file:{instanceId:'i',document:{id:'0',name:'Untitled'},page:{id:'15:2',name:'Page 2'},writeEnabled:true},hasPair:true,remember:true,waiting:false,notices:[],deletion:{notice:''},actions};
const render=(patch:Partial<PanelViewProps>={})=>renderToStaticMarkup(<PanelView {...base} {...patch}/>);
it('online daily view shows the file without edit controls, redundant connection buttons, or secrets',()=>{const html=render();expect(html).toContain('已连接');expect(html).toContain('Untitled');for(const value of ['允许创建和编辑','role="switch"','连接 / 检测网络','手动令牌','type="password"','private-session','localhost:3055','figma_get_status'])expect(html).not.toContain(value);});
it('puts the conversation first and gives local canvas tools a separate view',()=>{
 const html=render({chat:<p>Chat fixture</p>,canvas:<p>Canvas fixture</p>});
 expect(html).toMatch(/aria-pressed="true"[^>]*>Codex 对话/);
 expect(html).toMatch(/aria-pressed="false"[^>]*>画布工具/);
 expect(html.indexOf('Chat fixture')).toBeLessThan(html.indexOf('Canvas fixture'));
 for(const value of ['连接画布，开始协作','本机连接正常','保持插件运行即可协作'])expect(html).not.toContain(value);
});
it('first pairing and saved offline reconnection have one appropriate primary action',()=>{expect(render({status:'未连接',hasPair:false})).toContain('配对本机');expect(render({status:'未连接'})).toContain('重新连接');});
it('pairing exposes the human code and a cancel action',()=>{const html=render({status:'未连接',waiting:true,code:'123456'});expect(html).toContain('123456');expect(html).toContain('取消配对');expect(html).toContain('disabled');});
it('recovery options remain in collapsed settings without a manual token form',()=>{const html=render();expect(html).toContain('<details');for(const label of ['连接设置','重新配对','尝试备用连接','清除本机配对','下次自动连接'])expect(html).toContain(label);expect(html).not.toContain('通信方式');});
it('compact view shows status and expand while keeping the full workspace hidden',()=>{
 const html=render({compact:true,chat:<p>Draft fixture</p>});
 expect(html).toMatch(/<main class="compact-panel">[^]*?已连接[^]*?展开[^]*?<\/main>/);
 expect(html).toContain('<main class="expanded-panel" hidden=""');
 expect(html).toContain('Draft fixture');
});
it('pending deletion is visible even if a compact state arrives late',()=>{const html=render({compact:true,deletion:{notice:'',confirmation:{type:'confirmation',requestId:'r',confirmationId:'c',targets:['42:1']}}});expect(html).toContain('确认并执行删除');expect(html).toContain('42:1');expect(html).not.toContain('compact-panel');});
it('permits retrying a failed saved-pair deletion after the in-memory token is cleared',async()=>{const messages:any[]=[],connection={connect:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{})};let view:any;const pair=new PairingSession(connection,m=>messages.push(m),v=>{view=v;});pair.start();pair.receive({type:'pairing-state',requestId:messages[0].requestId,action:'load',saved:true,token:'t'.repeat(64),mode:'ws'});await pair.forget();pair.receive({type:'pairing-state',requestId:messages.at(-1).requestId,action:'forget',error:'STORAGE_UNAVAILABLE'});const html=render({status:'未连接',hasPair:view.token.length>=32,savedPair:view.saved,notices:[view.notice]});const clear=html.match(/<button([^>]*)>清除本机配对<\/button>/);expect(clear).not.toBeNull();expect(clear![1]).not.toContain('disabled');});
