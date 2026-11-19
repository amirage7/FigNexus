import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasCommand, CanvasSelection, CanvasResponse, type SlidePage } from './canvas-tools-model';
import { buildPresentation, PPTX_MIME } from './canvas-pptx';
import type { CanvasInput } from './canvas-panel';

export function useCanvasPanel() {
  const [selection,setSelection]=useState<CanvasSelection>();
  const [status,setStatus]=useState('');
  const [failed,setFailed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [download,setDownload]=useState<{url:string;fileName:string}>();
  const active=useRef<{id:string;pages:SlidePage[];total:number;editable:boolean}>(undefined);
  const next=useRef(0);
  const url=useRef<string>(undefined);
  const timer=useRef<ReturnType<typeof setTimeout>>(undefined);

  function run(command:CanvasInput) {
    if(!selection||active.current) return;
    if(url.current){URL.revokeObjectURL(url.current);url.current=undefined;}
    setDownload(undefined);
    setFailed(false);
    setBusy(true);
    setStatus(command.type==='canvas-export'?'正在渲染画板，请保持 Figma 在前台。':'正在处理…');
    const id='canvas-'+Date.now()+'-'+(++next.current);
    active.current={id,pages:[],total:command.type==='canvas-export'?command.frameIds.length:0,editable:command.type==='canvas-export'&&command.mode==='editable'};
    const parsed=CanvasCommand.safeParse({...command,id,pageId:selection.pageId});
    if(!parsed.success){
      active.current=undefined;
      setBusy(false);
      setFailed(true);
      setStatus('请检查尺寸、文件名或所选画板。');
      return;
    }
    parent.postMessage({pluginMessage:parsed.data},'*');
    if(command.type==='canvas-export') timer.current=setTimeout(()=>{
      if(active.current?.id!==id) return;
      parent.postMessage({pluginMessage:{type:'canvas-abandon',id}},'*');
      active.current=undefined;
      setBusy(false);
      setFailed(true);
      setStatus('等待超时。请保持 Figma 在前台，检查画布后重试。');
    },180_000);
  }

  const receive=useCallback((value:unknown)=>{
    const selected=CanvasSelection.safeParse(value);
    if(selected.success){setSelection(selected.data);return true;}
    const parsed=CanvasResponse.safeParse(value);
    if(!parsed.success) return false;
    const result:CanvasResponse=parsed.data,operation=active.current;
    if(!operation||result.id!==operation.id) return true;
    const finish=(text:string,error=false)=>{
      if(active.current!==operation) return;
      clearTimeout(timer.current);
      active.current=undefined;
      setStatus(text);
      setFailed(error);
      setBusy(false);
    };

    if(result.type==='canvas-progress'){
      if(result.total!==operation.total||result.done!==operation.pages.length+1) return true;
      operation.pages.push(result.slide);
      setStatus('正在导出 '+result.done+' / '+result.total+' 张画板');
    }else if(result.type==='canvas-error'){
      finish(result.message,true);
    }else if(result.fileName){
      if(operation.pages.length!==operation.total){finish('未收到全部画板，请重新导出。',true);return true;}
      const fileName=result.fileName;
      setStatus('正在生成 PowerPoint 文件…');
      void buildPresentation(operation.pages,fileName.slice(0,-5),result.size).then(data=>{
        if(active.current!==operation) return;
        const href=URL.createObjectURL(new Blob([data],{type:PPTX_MIME}));
        url.current=href;
        setDownload({url:href,fileName});
        const items=operation.pages.flatMap(page=>page.items);
        const vectors=items.filter(item=>item.kind==='svg').length;
        const native=items.filter(item=>item.kind!=='image'&&item.kind!=='svg').length;
        const detail=operation.editable?'保留 '+native+' 个可编辑对象、'+vectors+' 个 SVG 矢量对象。':'';
        finish('已生成 '+operation.total+' 页。'+detail+'点击保存 PPTX。');
      }).catch(error=>finish(error instanceof Error?error.message:'PowerPoint 文件生成失败。',true));
    }else{
      finish(result.message);
    }
    return true;
  },[]);

  useEffect(()=>()=>{clearTimeout(timer.current);active.current=undefined;if(url.current) URL.revokeObjectURL(url.current);},[]);
  return {selection,status,failed,busy,download,run,receive};
}
