import assert from 'node:assert/strict';
import test from 'node:test';
import {baseExpressionLine} from '../src/diagnostics/base-expression-location.ts';

test('matches a grouped filter in its own view and refuses stale or ambiguous matches',()=>{
	const source='filters: isActive\r\nviews:\r\n  - name: A\r\n    filters: isActive\r\n  - name: B\r\n    filters:\r\n      or:\r\n        - isActive\r\n        - isNew\r\n';
	const locate=(scope,expression,text=source)=>baseExpressionLine(text,{file:'List.base',scope,expression});
	assert.equal(locate('全局筛选','isActive'),1);
	assert.equal(locate('View filter · A','isActive'),4);
	assert.equal(locate('视图筛选 · B','or (isActive, isNew)'),8);
	assert.equal(locate('视图筛选 · B','or (isActive, isOld)'),undefined);
	assert.equal(locate('View filter · A','isActive',source+'  - name: A\n    filters: isActive\n'),undefined);
});

test('resolves formula positions inside the reported Markdown fence',()=>{
	const base='~~~base\nformulas:\n  total: cost * units\n~~~\n';
	const entry={file:'Note.md',scope:'formulas.total',expression:'cost * units'};
	assert.equal(baseExpressionLine(base+base,{...entry,line:5}),7);
	assert.equal(baseExpressionLine(base+base,entry),undefined);
});
