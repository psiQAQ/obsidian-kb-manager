import assert from 'node:assert/strict';
import test from 'node:test';
import {revealSourceTab} from '../src/ui/source-tabs.ts';

test('Git tabs coalesce concurrent opens, distinguish revisions and reveal restored tabs in place', async () => {
	const leaves = [];
	const revealed = [];
	const plugin = {app: {workspace: {
		getLeavesOfType: type => leaves.filter(leaf => leaf.getViewState().type === type),
		getLeaf: () => {
			let view = {};
			const leaf = {
				getViewState: () => view,
				setViewState: async next => {
					await Promise.resolve();
					assert.equal(view.type, undefined, 'An existing tab was re-rendered');
					view = next;
				},
			};
			leaves.push(leaf);
			return leaf;
		},
		revealLeaf: async leaf => { revealed.push(leaf); },
	}}};
	const diff = {id: 'a', file: '重复.md', staged: false};
	const open = target => revealSourceTab(plugin, 'diff', target);
	await Promise.all([open(diff), open(diff), open(diff)]);
	const original = leaves[0];
	assert.equal(leaves.length, 1);
	for (const target of [{...diff, staged: true}, {...diff, id: 'b'}, {...diff, commit: 'abcd'},
		{...diff, commit: 'abcd', parent: 'ef01'}]) await open(target);
	assert.equal(leaves.length, 5);
	await open(diff);
	assert.equal(revealed.at(-1), original);
	await revealSourceTab(plugin, 'history', {id: 'a'});
	await revealSourceTab(plugin, 'history', {id: 'a'});
	assert.equal(leaves.length, 6);
	const before={kind:'commit',oid:'1'.repeat(40)},after={kind:'working'};
	const compare={...diff,comparison:{before,after,oldFile:'old.md'}};
	await Promise.all([open(compare),open({...compare,comparison:{after,oldFile:'old.md',before}})]);
	await open({...compare,comparison:{before:after,after:before,oldFile:'old.md'}});
	await open({...compare,comparison:{before,after,oldFile:'other.md'}});
	assert.equal(leaves.length,9);
});
