import { expect, it } from 'vitest';
import { planSlideFrames, presentationName, resizeTracks, scaleForExport } from '../apps/figma-plugin/src/canvas-tools-model';
import { buildPresentation } from '../apps/figma-plugin/src/canvas-pptx';

it('supports portrait and custom artboard sizes, with matching export scaling',()=>{
  const [draft]=planSlideFrames(2,{x:0,y:0},1,{width:1080,height:1920});
  expect(draft).toMatchObject({width:1080,height:1920});
  expect(scaleForExport(1080,1920,'ultra')).toBe(2);
  expect(presentationName(' 答辩:定稿.PPTX ')).toBe('答辩_定稿.pptx');
});

it('resizes a table proportionally without losing individual track widths',()=>{
  expect(resizeTracks([120,80],300,32)).toEqual([180,120]);
  expect(resizeTracks([90,10],100,32)).toEqual([68,32]);
  expect(()=>resizeTracks([50,50],55,32)).toThrow();
});

it('creates native editable text and shapes in a 4:3 presentation',async()=>{
  const data=Buffer.from(await buildPresentation([{items:[
    {kind:'text',x:20,y:30,width:300,height:100,text:'可编辑标题',font:'Arial',fontSize:36,color:'121212',bold:true,italic:false,align:'left',valign:'top'},
    {kind:'shape',shape:'rect',x:10,y:200,width:300,height:100,fill:'ACAA99'},
  ]}],'标题',{width:1600,height:1200}));
  expect(data.includes(Buffer.from('可编辑标题'))).toBe(true);
  expect(data.includes('ppt/slides/slide1.xml')).toBe(true);
});
