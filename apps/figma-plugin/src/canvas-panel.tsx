import React, { useEffect, useState } from 'react';
import { MAX_SLIDES, SlidePresets, orderSlideFrames, sameAspect, type ExportQuality, type CanvasCommand, type CanvasSelection } from './canvas-tools-model';
import { CanvasTablePanel } from './canvas-table-panel';

export type CanvasInput<T=CanvasCommand> = T extends CanvasCommand ? Omit<T,'id'|'pageId'> : never;
type Props = {
  selection?:CanvasSelection;
  busy:boolean;
  status:string;
  failed:boolean;
  download?:{url:string;fileName:string};
  run:(command:CanvasInput)=>void;
};
type Tab='slides'|'export'|'table'|'link';

export function CanvasPanel({selection,busy,status,failed,download,run}:Props) {
  const [tab,setTab]=useState<Tab>();
  const [slideCount,setSlideCount]=useState(6);
  const [template,setTemplate]=useState(false);
  const [preset,setPreset]=useState('wide');
  const [customWidth,setCustomWidth]=useState(1920);
  const [customHeight,setCustomHeight]=useState(1080);
  const [title,setTitle]=useState('');
  const [quality,setQuality]=useState<ExportQuality>('high');
  const [mode,setMode]=useState<'image'|'editable'>('image');
  const [kind,setKind]=useState<'elbow'|'straight'>('elbow');
  const [reverse,setReverse]=useState(false);
  const [manualOrder,setManualOrder]=useState<{key:string;ids:string[]}>();
  const frames=selection?.frames??[];
  const count=selection?.count??0;
  const selectionKey=(selection?.pageId??'')+' '+frames.map(frame=>frame.id).sort().join(' ');
  const byId=new Map(frames.map(frame=>[frame.id,frame]));
  const ordered=manualOrder?.key===selectionKey?manualOrder.ids.flatMap(id=>byId.get(id)??[]):orderSlideFrames(frames);
  const canExport=count>0&&count<=MAX_SLIDES&&count===frames.length&&frames.every(frame=>!frame.rotated&&sameAspect(frame,frames[0]));
  const oneFrame=count===1&&frames.length===1&&!frames[0].rotated;
  const presetSize=SlidePresets.find(item=>item.id===preset);
  const size=presetSize?{width:presetSize.width,height:presetSize.height}:{width:customWidth,height:customHeight};
  useEffect(()=>{setManualOrder(undefined);},[selectionKey]);

  const move=(index:number,direction:number)=>{
    const ids=ordered.map(frame=>frame.id),next=index+direction;
    [ids[index],ids[next]]=[ids[next],ids[index]];
    setManualOrder({key:selectionKey,ids});
  };
  const tabs=[['link','连线'],['slides','建画板'],['export','导出 PPTX'],['table','表格']] as const;

  return <section className="canvas-tools" aria-label="画布工具">
    <div className="canvas-tools-grid" role="group" aria-label="选择画布工具">
      {tabs.map(([value,label])=><button key={value} type="button" className="canvas-tool" aria-pressed={tab===value}
        aria-controls="canvas-tools-body" onClick={()=>setTab(value)}>
        <span className={'canvas-tool-icon canvas-tool-icon--'+value} aria-hidden="true"><i/></span>
        {label}
      </button>)}
    </div>
    <div id="canvas-tools-body" className="canvas-tools-body" hidden={!tab}>
      {tab==='link'&&<form onSubmit={event=>{event.preventDefault();run({type:'canvas-connect',kind,reverse});}}>
        {count!==2&&!selection?.connector&&<p>选中两个图层后连线。</p>}
        {count===2&&<><div className="canvas-controls">
          <label>线型 <select value={kind} onChange={event=>setKind(event.target.value==='straight'?'straight':'elbow')}><option value="elbow">折线</option><option value="straight">直线</option></select></label>
          <label className="canvas-check"><input type="checkbox" checked={reverse} onChange={event=>setReverse(event.target.checked)}/>反向</label>
        </div>
        <button className="button button-primary" disabled={busy}>连接选中图层</button></>}
        {selection?.connector&&<button className="button" type="button" disabled={busy} onClick={()=>run({type:'canvas-reverse'})}>反转箭头</button>}
      </form>}
      {tab==='slides'&&<form onSubmit={event=>{event.preventDefault();run({type:'canvas-slides',count:slideCount,template:template&&oneFrame,size:template&&oneFrame?undefined:size});}}>
        <div className="canvas-controls">
          <label>页数 <input type="number" required min="1" max={MAX_SLIDES} value={slideCount||''} onChange={event=>setSlideCount(Number(event.target.value))}/></label>
          <label>尺寸 <select aria-label="画板尺寸" value={preset} disabled={template&&oneFrame} onChange={event=>setPreset(event.target.value)}>
            {SlidePresets.map(item=><option key={item.id} value={item.id}>{item.label} · {item.width} × {item.height}</option>)}
            <option value="custom">自定义</option>
          </select></label>
        </div>
        {preset==='custom'&&!(template&&oneFrame)&&<div className="canvas-controls canvas-table-sizing">
          <label>宽 (px) <input type="number" required min="64" max="7680" value={customWidth||''} onChange={event=>setCustomWidth(Number(event.target.value))}/></label>
          <label>高 (px) <input type="number" required min="64" max="7680" value={customHeight||''} onChange={event=>setCustomHeight(Number(event.target.value))}/></label>
        </div>}
        {oneFrame&&<div className="canvas-controls"><label className="canvas-check"><input type="checkbox" checked={template}
          onChange={event=>setTemplate(event.target.checked)}/>复制选中画板</label></div>}
        <button className="button button-primary" disabled={busy||!selection}>创建画板</button>
      </form>}
      {tab==='export'&&(!canExport?<p>选择 1–30 张比例一致且未旋转的画板。</p>:<>
        <div className="canvas-controls">
          <label>版本 <select aria-label="PPTX 版本" value={mode} onChange={event=>setMode(event.target.value==='editable'?'editable':'image')}>
            <option value="image">图片版</option><option value="editable">可编辑版</option>
          </select></label>
        </div>
        {mode==='editable'&&<p>文字、基础形状和表格可编辑。复杂图层优先保留为 SVG。</p>}
        <details className="canvas-export-options"><summary>文件名与清晰度</summary>
          <label className="canvas-text-label">文件名<input type="text" maxLength={120} value={title} onChange={event=>setTitle(event.target.value)} placeholder="默认使用 Figma 文件名"/></label>
          <label>图片清晰度 <select value={quality} onChange={event=>setQuality(event.target.value as ExportQuality)}>
            <option value="standard">标准 · 1280 px</option><option value="high">高清 · 1920 px</option><option value="ultra">超清 · 3840 px</option>
          </select></label>
        </details>
        {ordered.length>1&&<ol className="canvas-slide-order" aria-label="PPTX 页序">{ordered.map((frame,index)=><li key={frame.id}>
          <span title={frame.name}>{frame.name}</span>
          <button type="button" className="button" aria-label={'上移 '+frame.name} disabled={busy||index===0} onClick={()=>move(index,-1)}>↑</button>
          <button type="button" className="button" aria-label={'下移 '+frame.name} disabled={busy||index===ordered.length-1} onClick={()=>move(index,1)}>↓</button>
        </li>)}</ol>}
        <button className="button button-primary" disabled={busy} onClick={()=>run({type:'canvas-export',frameIds:ordered.map(frame=>frame.id),title,quality,mode})}>生成 PPTX</button>
      </>)}
      {tab==='table'&&<CanvasTablePanel selection={selection} busy={busy} run={run}/>}
    </div>
    {status&&<p className={'canvas-status'+(failed?' canvas-status-error':'')} role={failed?'alert':'status'}>{status}</p>}
    {download&&<a className="button canvas-download" href={download.url} download={download.fileName}>保存 PPTX</a>}
  </section>;
}
