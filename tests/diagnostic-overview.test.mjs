import assert from 'node:assert/strict';
import test from 'node:test';
import {overviewFindings} from '../src/ui/diagnostic-overview.ts';
import {compareDiagnosticReports} from '../src/diagnostics/comparison.ts';

test('excluding a previously broken source does not count its finding as repaired',()=>{
	const file='Templates/Page.md';
	const row={id:'links',coverage:{checked:1,skipped:0,unknown:0},status:'findings',
		diagnostics:[{file,code:'missing-embed',severity:'error'}]};
	const report=check=>({environment:'desktop',library:{id:'example'},checks:[check]});
	const later={...row,status:'passed',diagnostics:[],coverage:{...row.coverage,skipped:1},
		templateExcludedSources:[{file,matches:['folders:Templates']}]};
	const comparison=compareDiagnosticReports(report(row),report(later));
	assert.deepEqual(comparison.resolved,[]);
	assert.deepEqual(comparison.unavailableChecks,['links']);
	const sameSources={...later,templateExcludedSources:[{file,matches:['files:'+file]}]};
	assert.deepEqual(compareDiagnosticReports(report(later),report(sameSources)).unavailableChecks,[]);
});

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
