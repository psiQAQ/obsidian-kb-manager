import test from 'node:test';
import assert from 'node:assert/strict';
import {parseConflictBlocks,resolveBlock} from '../src/git/index-conflicts.ts';

test('conflict editor uses exact standard and diff3 block offsets and retains unrelated text',()=>{
	const text='before\r\n<<<<<<< HEAD\r\nlocal\r\n||||||| parent\r\nbase\r\n=======\r\nremote\r\n>>>>>>> other\r\nafter\r\n<<<<<<< HEAD\r\n=======\r\nonly remote\r\n>>>>>>> other';
	const [first,second,...more]=parseConflictBlocks(text);
	assert.deepEqual(more,[]);
	assert.equal(resolveBlock(first,'base'),'base\r\n');
	assert.equal(resolveBlock(first,'ours'),'local\r\n');
	assert.equal(resolveBlock(first,'theirs'),'remote\r\n');
	assert.equal(text.slice(0,first.from)+resolveBlock(first,'both')+text.slice(first.to),
		'before\r\nlocal\r\nremote\r\nafter\r\n<<<<<<< HEAD\r\n=======\r\nonly remote\r\n>>>>>>> other');
	assert.equal(resolveBlock(second,'ours'),'');
	assert.equal(second.to,text.length);
	assert.equal(second.base,undefined);
});

test('incomplete, nested or repeated conflict markers cannot produce resolution controls',()=>{
	const invalid=[
		'<<<<<<< HEAD\nours\n=======\ntheirs\n',
		'<<<<<<< HEAD\nours\n>>>>>>> other\n',
		'=======\ntheirs\n>>>>>>> other\n',
		'<<<<<<< HEAD\n||||||| base\n||||||| base\n=======\n>>>>>>> other\n',
		'<<<<<<< HEAD\n=======\n=======\n>>>>>>> other\n',
		'<<<<<<< HEAD\n<<<<<<< nested\n=======\n>>>>>>> nested\n=======\n>>>>>>> outer\n',
	];
	for(const text of invalid)assert.deepEqual(parseConflictBlocks(text),[]);
});
