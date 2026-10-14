import {expect,it} from 'vitest';
import {serializeBindings} from '../apps/figma-plugin/src/binding-summary';
import {BoundVariablesSchema} from '../packages/protocol/src/design';
const alias={type:'VARIABLE_ALIAS',id:'VariableID:1:1'};
it('serializes native component property aliases and bounds arrays without failing a valid node',()=>{
  const value=serializeBindings({componentProperties:{'Label#1':alias},fills:Array(8).fill(alias)});
  expect(value.bindings.componentProperties).toEqual({'Label#1':alias});expect(value.bindings.fills).toHaveLength(4);expect(value.truncated).toBe(true);expect(BoundVariablesSchema.safeParse(value.bindings).success).toBe(true);
});
it('bounds keys and JSON size so a large native binding map remains readable',()=>{
  const native=Object.fromEntries(Array.from({length:100},(_,i)=>['field'+i,{type:'VARIABLE_ALIAS',id:'v'.repeat(120)}]));
  const value=serializeBindings(native);expect(JSON.stringify(value.bindings).length).toBeLessThanOrEqual(2048);expect(value.truncated).toBe(true);expect(BoundVariablesSchema.safeParse(value.bindings).success).toBe(true);
});
