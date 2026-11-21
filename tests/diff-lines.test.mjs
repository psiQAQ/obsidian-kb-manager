import assert from 'node:assert/strict';
import test from 'node:test';
import { structuredPatch } from 'diff';
import { numberedLines, pairedLines } from '../src/ui/diff-lines.ts';

function lines(a, b) {
	return structuredPatch('before', 'after', a, b, undefined, undefined, {context: 1}).hunks.map(numberedLines);
}

test('split replacements align at the same line and only pad the shorter side', () => {
	const [hunk] = lines('start\n旧句\nend\n', 'start\n新句\n第二句\nend\n');
	const pairs = [...pairedLines(hunk)];
	assert.deepEqual(pairs.map(([a,b])=>[a?.text,b?.text]), [
		['start','start'], ['旧句','新句'], [undefined,'第二句'], ['end','end'],
	]);
	assert.deepEqual(hunk.map(x=>[x.kind,x.oldNumber,x.newNumber]), [
		['context',1,1], ['removed',2,undefined], ['added',undefined,2], ['added',undefined,3], ['context',3,4],
	]);
});

test('added, deleted and unterminated lines retain side, line numbers and end-of-file information', () => {
	for (const [a,b,oldText,newText] of [['','new',undefined,'new'],['old','','old',undefined],['a','b','a','b']]) {
		const [[before,after]] = pairedLines(lines(a,b)[0]);
		assert.equal(before?.text,oldText);
		assert.equal(after?.text,newText);
		if(before) assert.deepEqual([before.oldNumber,before.noNewline],[1,true]);
		if(after) assert.deepEqual([after.newNumber,after.noNewline],[1,true]);
	}
	const [hunk] = lines('same\n', 'same');
	assert.deepEqual(hunk.map(x=>[x.kind,x.noNewline]), [['removed',false],['added',true]]);
	assert.deepEqual(lines('',''), []);
});

test('line numbers restart from each hunk and preserve blank lines and carriage returns', () => {
	const [first,second] = lines('a\r\n\r\n2\n3\n4\n5\n6\n7\nz\n', 'b\r\n\r\n2\n3\n4\n5\n6\n7\ny\n');
	assert.equal(first[0].text,'a\r');
	assert.equal(first.at(-1).text,'\r');
	assert.equal(second[0].oldNumber,8);
	assert.equal(second.at(-1).newNumber,9);
});
