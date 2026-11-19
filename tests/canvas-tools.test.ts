import { expect, it } from 'vitest';
import { parseTableText, planSlideFrames, orderSlideFrames } from '../apps/figma-plugin/src/canvas-tools-model';
import { connectorPath } from '../apps/figma-plugin/src/canvas-connectors';

it('reads quoted Excel cells, keeps empty cells, and pads shorter rows', () => {
  expect(parseTableText('名称\t备注\r\n试验\t"第一行\r\n第二行"\r\n空白\r\n')).toEqual([
    ['名称','备注'], ['试验','第一行\n第二行'], ['空白',''],
  ]);
  expect(parseTableText('项目,数值\n"样本, A",13')).toEqual([['项目','数值'],['样本, A','13']]);
  expect(() => parseTableText('"未结束')).toThrow();
});

it('accepts a 13-column sheet with an empty reviewer cell and a sparse title row',()=>{
  const headers=['序号','姓名','学号','类别',...Array.from({length:8},(_,i)=>'评委 '+(i+1)),'合计'];
  const cells=['1','测试学生','123456789012','测试类别','1','2','3','4','5','6','','8','29'];
  const markdown=[['测试奖学金'],Array(13).fill('---'),headers,cells].map(row=>'| '+row.join(' | ')+' |').join('\n');
  for(const text of [markdown,['测试奖学金',headers.join('\t'),cells.join('\t')].join('\n')]){
    const parsed=parseTableText(text);
    expect(parsed).toHaveLength(3);
    expect(parsed.every(row=>row.length===13)).toBe(true);
    expect(parsed[0]).toEqual(['测试奖学金',...Array(12).fill('')]);
    expect(parsed[2][10]).toBe('');
    expect(parsed[2][12]).toBe('29');
  }
});

it('creates numbered widescreen frames and orders numeric names before canvas position', () => {
  const planned = planSlideFrames(5, { x: 100, y: 200 }, 9);
  expect(planned.map(frame => frame.name)).toEqual(['09 幻灯片','10 幻灯片','11 幻灯片','12 幻灯片','13 幻灯片']);
  expect(planned[0]).toMatchObject({ x: 100, y: 200, width: 1920, height: 1080 });
  expect(planned[4].y).toBeGreaterThan(planned[0].y);
  expect(orderSlideFrames([{id:'b',name:'10 正文',x:0,y:0},{id:'a',name:'2 封面',x:20,y:0}]).map(f=>f.id)).toEqual(['a','b']);
});

it('anchors both sides of an elbow and moves the arrowhead when reversed', () => {
  const from = {x:0,y:0,width:100,height:60}, to = {x:220,y:100,width:100,height:60};
  const forward = connectorPath(from,to,'elbow');
  const reverse = connectorPath(to,from,'elbow');
  expect(forward.points).toEqual([{x:100,y:30},{x:160,y:30},{x:160,y:130},{x:220,y:130}]);
  expect(reverse.points).toEqual([...forward.points].reverse());
  expect(forward.arrow[1]).toEqual({x:220,y:130});
  expect(reverse.arrow[1]).toEqual({x:100,y:30});
});
