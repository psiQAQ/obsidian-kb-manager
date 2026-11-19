import test from 'node:test';
import assert from 'node:assert/strict';
import {planTemplateFilter,templateIgnoreRule as rule} from '../src/ui/template-filter.ts';
test('only confirmed built-in creation appends the missing exclusion, retaining concurrent edits',async()=>{
 const rules=['README.md'];let writes=0,fail=true;
 const store={read:async()=>rules,append:async()=>{if(fail)throw Error('write failed');writes++;rules.push(rule);}};
 assert.equal(await planTemplateFilter('my/template',store),undefined);
 const plan=await planTemplateFilter('',store);assert.equal(plan.missing,true);assert.deepEqual(rules,['README.md']);
 await assert.rejects(plan.apply(),/write failed/);fail=false;rules.push('another');await plan.apply();await plan.apply();
 assert.deepEqual(rules,['README.md','another',rule]);assert.equal(writes,1);
 const existing=await planTemplateFilter('builtin:kepano',store);assert.equal(existing.missing,false);
 rules.pop();await assert.rejects(existing.apply());assert.equal(writes,1);
 const concurrent=await planTemplateFilter('builtin:kepano',store);rules.push(rule);await concurrent.apply();assert.equal(writes,1);
});
