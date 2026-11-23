import assert from 'node:assert/strict';
import test from 'node:test';
import {overviewFindings} from '../src/ui/diagnostic-overview.ts';

test('a report overview lists each positioned dynamic block once and retains its contributing checks',()=>{
	const block={severity:'info',code:'dynamic-block-skipped',file:'Views.md',line:5,message:'Dataview query skipped'};
	const next={...block,line:15};
	const checks=['links','anchors','portability'].map(id=>({id,diagnostics:[block,next]}));
	const raw=JSON.stringify(checks);
	const overview=overviewFindings(checks);
	assert.deepEqual(overview,[block,next].map(item=>({item,checks:['links','anchors','portability']})));
	assert.equal(JSON.stringify(checks),raw);
	assert.deepEqual(overviewFindings(JSON.parse(raw)),overview);
});

test('different sources, reasons, warnings and unlocated legacy findings retain their own entries',()=>{
	const block={severity:'info',code:'dynamic-block-skipped',file:'Views.md',line:5,message:'Dataview query skipped'};
	const items=[block,{...block,file:'Other.md'},{...block,message:'Different reason'},{...block,column:3},
		{...block,code:'link-unresolved'},{...block,code:'link-unresolved'},
		{...block,severity:'warning'},{...block,severity:'warning'},{...block,line:undefined},{...block,line:undefined}];
	assert.deepEqual(overviewFindings([{id:'links',diagnostics:items}]).map(({item})=>item),items);
});
