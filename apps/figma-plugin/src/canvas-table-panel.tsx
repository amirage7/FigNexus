import React, { useEffect, useState } from 'react';
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, resizeTracks, type CanvasSelection } from './canvas-tools-model';
import type { CanvasInput } from './canvas-panel';
import { MIN_COLUMN, MIN_ROW } from './canvas-table-layout';

type Props={
  selection?:CanvasSelection;
  busy:boolean;
  run:(command:CanvasInput)=>void;
};
const sum=(values:readonly number[])=>values.reduce((total,value)=>total+value,0);
const round=(value:number)=>Math.round(value*100)/100;

export function CanvasTablePanel({selection,busy,run}:Props){
  const table=selection?.table;
  const [rows,setRows]=useState(4);
  const [columns,setColumns]=useState(3);
  const [header,setHeader]=useState(true);
  const [text,setText]=useState('');
  const [width,setWidth]=useState(0);
  const [height,setHeight]=useState(0);
  const [fill,setFill]=useState(false);
  const [color,setColor]=useState('#eeeeee');
  const [columnSizes,setColumnSizes]=useState<number[]>([]);
  const [rowSizes,setRowSizes]=useState<number[]>([]);
  const [individual,setIndividual]=useState({width:false,height:false});
  const tableKey=table?[table.id,...table.columns,...table.rows,table.fill].join('|'):'';
  useEffect(()=>{
    setWidth(table?Math.round(sum(table.columns)):0);
    setHeight(table?Math.round(sum(table.rows)):0);
    setColumnSizes(table?.columns.map(round)??[]);
    setRowSizes(table?.rows.map(round)??[]);
    setFill(!!table?.fill);
    setColor(table?.fill??'#eeeeee');
    setIndividual({width:false,height:false});
  // Identical Figma selection updates must not reset values being edited.
  },[tableKey]);

  const count=selection?.count??0;
  const oneFrame=count===1&&selection?.frames.length===1;
  function trackInput(axis:'width'|'height',index:number,value:number){
    const changes=(axis==='width'?columnSizes:rowSizes).map((size,i)=>i===index?value:size);
    if(axis==='width'){setColumnSizes(changes);setWidth(Math.round(sum(changes)));}
    else{setRowSizes(changes);setHeight(Math.round(sum(changes)));}
    setIndividual(current=>({...current,[axis]:true}));
  }
  function totalInput(axis:'width'|'height',value:number){
    if(axis==='width') setWidth(value);
    else setHeight(value);
    const original=axis==='width'?table?.columns:table?.rows;
    if(!original) return;
    const set=axis==='width'?setColumnSizes:setRowSizes;
    const minimum=axis==='width'?MIN_COLUMN:MIN_ROW;
    try{set(resizeTracks(original,value,minimum).map(round));}catch{/* Invalid total remains visible for correction. */}
    setIndividual(current=>({...current,[axis]:false}));
  }
  const tracks=(sizes:number[],axis:'width'|'height',label:string,minimum:number)=>sizes.map((value,index)=>
    <label key={index}>{label} {index+1}<input type="number" required min={minimum} max={7680} step="any"
      value={value||''} onChange={event=>trackInput(axis,index,Number(event.target.value))}/></label>
  );

  return <form onSubmit={event=>{
    event.preventDefault();
    const size={width:width||undefined,height:height||undefined,fill:fill?color:null};
    if(table) run({type:'canvas-table-update',tableId:table.id,...size,
      columnWidths:individual.width?columnSizes:undefined,rowHeights:individual.height?rowSizes:undefined});
    else run({type:'canvas-table',rows,columns,text,header,...size});
  }}>
    {table?<p>调整总尺寸会按比例缩放行列。</p>:<>
      <label className="canvas-text-label">粘贴 Excel、CSV 或 Markdown
        <textarea rows={3} maxLength={80000} value={text} onChange={event=>setText(event.target.value)} placeholder="留空时创建空白表格"/>
      </label>
      {!text&&<div className="canvas-controls">
        <label>行 <input type="number" required min="1" max={MAX_TABLE_ROWS} value={rows||''} onChange={event=>setRows(Number(event.target.value))}/></label>
        <label>列 <input type="number" required min="1" max={MAX_TABLE_COLUMNS} value={columns||''} onChange={event=>setColumns(Number(event.target.value))}/></label>
      </div>}
      <label className="canvas-check"><input type="checkbox" checked={header} onChange={event=>setHeader(event.target.checked)}/>首行文字加粗</label>
    </>}
    <div className="canvas-controls canvas-table-sizing">
      <label>总宽 (px) <input type="number" min={table?table.columns.length*MIN_COLUMN:64} max="7680" required={!!table} value={width||''}
        onChange={event=>totalInput('width',Number(event.target.value))} placeholder="自动"/></label>
      <label>总高 (px) <input type="number" min={table?table.rows.length*MIN_ROW:64} max="7680" required={!!table} value={height||''}
        onChange={event=>totalInput('height',Number(event.target.value))} placeholder="自动"/></label>
    </div>
    {table&&<details className="canvas-tracks"><summary>单独调整列宽、行高</summary>
      <div className="canvas-track-list">{tracks(columnSizes,'width','列宽',MIN_COLUMN)}</div>
      <div className="canvas-track-list">{tracks(rowSizes,'height','行高',MIN_ROW)}</div>
    </details>}
    <div className="canvas-controls">
      <label className="canvas-check"><input type="checkbox" checked={fill} onChange={event=>setFill(event.target.checked)}/>添加底纹</label>
      {fill&&<input type="color" aria-label="底纹颜色" value={color} onChange={event=>setColor(event.target.value)}/>}
    </div>
    {!table&&count>0&&!oneFrame&&<p>选中一个画板，或取消选择后插入表格。</p>}
    <button className="button button-primary" disabled={busy||!selection||(count>0&&!oneFrame)}>{table?'应用设置':oneFrame?'插入到画板':'插入表格'}</button>
  </form>;
}
