import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MainMessage, type FileContext } from '@bridge/protocol';
import { reduceDeleteState, type LocalDeleteState } from './confirmation-ui';
import { PluginConnection } from './connection';
import {PairingSession,type PairingView} from './pairing';
import {QuickPairingClient,type QuickPairView} from './quick-pairing-client';
import {PanelView} from './panel-view';
import './ui.css';
function App() {
  const [compact,setCompact]=useState(false),[panelNotice,setPanelNotice]=useState('');
  const setPanel=(compact:boolean)=>parent.postMessage({pluginMessage:{type:'panel-mode',compact}},'*');
  const [pairingView,setPairingView]=useState<PairingView>({token:'',mode:'ws',remember:true,saved:false,notice:''});
  const {token}=pairingView;const pairing=useRef<PairingSession>(undefined);
  const quick=useRef<QuickPairingClient>(undefined),[quickView,setQuickView]=useState<QuickPairView>({waiting:false,notice:''});
  const [status, setStatus] = useState('未连接'), [file, setFile] = useState<FileContext>();
  const [deleteState, setDeleteState] = useState<LocalDeleteState>({notice:''});
  const confirmation=deleteState.confirmation;
  const context = useRef<FileContext>(undefined), client = useRef<PluginConnection>(undefined);
  useEffect(() => {
    const sendMain = (message: unknown) => parent.postMessage({ pluginMessage: message }, '*');
    let paired:PairingSession;
    const c = new PluginConnection(() => { if (!context.current) throw new Error('等待 Figma 文件信息'); return context.current; }, sendMain, setStatus,undefined,(token,mode)=>paired.connectionEstablished(token,mode));
    client.current = c;
    paired=new PairingSession(c,sendMain,setPairingView);pairing.current=paired;
    const q=new QuickPairingClient(async(token,signal)=>{
      if(signal.aborted)return;
      const cancel=()=>{void paired.disconnect().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
      try{paired.setToken(token);await paired.connect();}finally{signal.removeEventListener('abort',cancel);}
    },setQuickView);quick.current=q;
    const listener = (event: MessageEvent) => {
      // Desktop Figma relays messages through its host window, not always the immediate parent.
      if (event.source !== parent && event.origin !== 'https://www.figma.com') return;
      const result = MainMessage.safeParse(event.data?.pluginMessage);
      if (!result.success) return;
      if (result.data.type === 'context') { context.current = result.data.context; setFile(result.data.context);paired.contextReady(); }
      else if(result.data.type==='panel-state'){setCompact(result.data.compact);setPanelNotice(result.data.error?'本次窗口可用，但无法记住折叠偏好。':'');}
      else if(result.data.type==='pairing-state'){paired.receive(result.data);}
      else if(result.data.type==='progress'){void c.progress(result.data);}
      else { const message=result.data;setDeleteState(state=>reduceDeleteState(state,message));if(message.type==='result')void c.send(message); }
    };
    window.addEventListener('message', listener);
    sendMain({ type: 'context-request' });
    sendMain({type:'panel-load'});
    paired.start();
    const timer = setInterval(() => sendMain({ type: 'context-request' }), 3000);
    return () => { q.cancel();clearInterval(timer); window.removeEventListener('message', listener); void paired.disconnect(); };
  }, []);
  const online=status.startsWith('在线');
  const pair=()=>{void(async()=>{await pairing.current?.disconnect();await quick.current?.start();})().catch(()=>setStatus('连接未能建立，请重试'));};
  const reconnect=()=>{quick.current?.cancel();void pairing.current?.connect().catch(()=>setStatus('连接未能建立，请检查本机服务后重试'));};
  const notices=[panelNotice,deleteState.notice,...(!online?[quickView.notice]:[]),...(/失败|未能|无法/.test(pairingView.notice)?[pairingView.notice]:[])].filter(Boolean);
  return <PanelView compact={compact} status={status} file={file} hasPair={token.length>=32} savedPair={pairingView.saved} remember={pairingView.remember} waiting={quickView.waiting} code={quickView.code} notices={notices} deletion={deleteState} actions={{
    toggle:setPanel,edit:enabled=>parent.postMessage({pluginMessage:{type:'set-write',enabled}},'*'),pair,reconnect,cancel:()=>quick.current?.cancel(),remember:enabled=>pairing.current?.setRemember(enabled),repair:pair,
    fallback:()=>{quick.current?.cancel();pairing.current?.setMode('http');reconnect();},forget:()=>{quick.current?.cancel();void pairing.current?.forget().catch(()=>setStatus('清除配对失败，请重试'));},
    confirm:approved=>{if(confirmation)parent.postMessage({pluginMessage:{type:'confirm-delete',requestId:confirmation.requestId,confirmationId:confirmation.confirmationId,approved}},'*');}
  }}/>;
}
createRoot(document.getElementById('root')!).render(<App />);
