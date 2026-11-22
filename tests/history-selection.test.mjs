import assert from 'node:assert/strict';
import test from 'node:test';
import { activateHistorySelection, closedHistorySelection, historyGesture, historyMenuSelection, validateHistorySelection } from '../src/ui/history-selection.ts';

test('ordinary activation toggles an open commit and switches to a different commit',()=>{
	const a=activateHistorySelection(closedHistorySelection,'A','toggle');
	assert.deepEqual(a,{anchor:'A',peer:''});
	assert.equal(activateHistorySelection(a,'A','toggle'),closedHistorySelection);
	const comparison=activateHistorySelection(a,'B','compare');
	assert.deepEqual(activateHistorySelection(comparison,'C','toggle'),{anchor:'C',peer:''});
});

test('modifier activations keep the original anchor, replace a peer, and toggle that peer off',()=>{
	const a=activateHistorySelection(closedHistorySelection,'A','compare');
	const aToB=activateHistorySelection(a,'B','compare');
	assert.deepEqual(aToB,{anchor:'A',peer:'B'});
	const aToC=activateHistorySelection(aToB,'C','compare');
	assert.deepEqual(aToC,{anchor:'A',peer:'C'});
	assert.deepEqual(activateHistorySelection(aToC,'C','compare'),a);
	assert.equal(activateHistorySelection(aToB,'A','compare'),closedHistorySelection);
});

test('navigation to the open row is idempotent and navigation to another row ends a gesture',()=>{
	const comparison={anchor:'A',peer:'B'};
	assert.equal(activateHistorySelection(comparison,'A','navigate'),comparison);
	assert.deepEqual(activateHistorySelection(comparison,'B','navigate'),{anchor:'B',peer:''});
});

test('comparison direction follows graph order, including the worktree row',()=>{
	const rows=['worktree','A','C','B'];
	const indexOf=oid=>rows.indexOf(oid);
	assert.deepEqual(historyGesture({anchor:'A',peer:'B'},indexOf),{from:'B',to:'A'});
	assert.deepEqual(historyGesture({anchor:'B',peer:'A'},indexOf),{from:'B',to:'A'});
	assert.deepEqual(historyGesture({anchor:'worktree',peer:'C'},indexOf),{from:'C',to:'worktree'});
	assert.equal(historyGesture({anchor:'A',peer:''},indexOf),undefined);
});

test('row menu compares from the requested origin regardless of graph order',()=>{
	const indexOf=oid=>['A','B'].indexOf(oid);
	const temporary=historyMenuSelection('B','A','');
	assert.equal(temporary.anchor,'B');
	assert.deepEqual(historyGesture(temporary,indexOf),{from:'A',to:'B'});
	const pinned=historyMenuSelection('B','A','A');
	assert.deepEqual(pinned,{anchor:'B',peer:''});
	assert.equal(historyGesture(pinned,indexOf),undefined);
});

test('restoring a selection keeps visible endpoints and removes missing ones',()=>{
	const rows=['A','B'];
	const indexOf=oid=>rows.indexOf(oid);
	const comparison={anchor:'A',peer:'B'};
	assert.equal(validateHistorySelection(comparison,indexOf),comparison);
	assert.deepEqual(validateHistorySelection({anchor:'A',peer:'worktree'},indexOf),{anchor:'A',peer:''});
	assert.equal(validateHistorySelection({anchor:'worktree',peer:'A'},indexOf),closedHistorySelection);
});
