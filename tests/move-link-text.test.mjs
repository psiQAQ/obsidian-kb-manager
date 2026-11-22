import assert from 'node:assert/strict';
import test from 'node:test';
import {moveVaultPath, relocateCanvasReferences, relocateMarkdownReference} from '../src/kb/move-link-text.ts';

const source = 'Books/A';
const destination = 'New shelf/Topic/A2';
const from = 'Books/B/Home.md';
const target = 'Books/A/Idea (1).md';
const rewrite = (token, note = from, file = target) =>
	relocateMarkdownReference(token, note, file, source, destination);

test('moves only the complete vault path prefix', () => {
	assert.equal(moveVaultPath(source, source, destination), destination);
	assert.equal(moveVaultPath('Books/Alpha/a', source, destination), 'Books/Alpha/a');
});

test('moves wiki targets while keeping embed sizes, block fragments and table aliases', () => {
	assert.equal(rewrite('[[Books/A/Idea (1)#^block\\|Read]]'), '[[New shelf/Topic/A2/Idea (1)#^block\\|Read]]');
	assert.equal(rewrite('![[photo.png|320]]', from, 'Books/A/photo.png'), '![[New shelf/Topic/A2/photo.png|320]]');
	assert.equal(rewrite('[[Idea (1)]]', 'Books/A/Home.md'), '[[Idea (1)]]');
	assert.equal(rewrite('[[#Local heading]]', target, target), '[[#Local heading]]');
	assert.equal(rewrite('[[../A/Idea (1).md]]'), '[[../../New shelf/Topic/A2/Idea (1).md]]');
	assert.equal(rewrite('[[Books/A/Bad#name]]', from, 'Books/A/Bad#name.md'), undefined);
});

test('moves Markdown paths relative to the new source and retains labels, encoding, fragments and titles', () => {
	assert.equal(rewrite('[A [nested] label](../A/Idea%20%281%29.md#Heading "some title")'),
		'[A [nested] label](../../New%20shelf/Topic/A2/Idea%20%281%29.md#Heading "some title")');
	assert.equal(rewrite('![picture](<../A/pic 1.png> "caption")', from, 'Books/A/pic 1.png'),
		'![picture](<../../New%20shelf/Topic/A2/pic%201.png> "caption")');
	assert.equal(rewrite('[local](./Idea%20%281%29.md#^b)', 'Books/A/Home.md'),
		'[local](./Idea%20%281%29.md#^b)');
	assert.equal(rewrite('[outside](../B/Home.md)', 'Books/A/Home.md', from), '[outside](../../../Books/B/Home.md)');
	assert.equal(rewrite('[same](#same)', target, target), '[same](#same)');
	assert.equal(rewrite('[root](/Books/A/Idea%20(1).md?flag#here)'),
		'[root](/New%20shelf/Topic/A2/Idea%20%281%29.md?flag#here)');
	assert.equal(rewrite('[reference][id]'), undefined);
	assert.equal(rewrite('[external](https://test.invalid/file)'), undefined);
});

test('updates only Canvas file node targets while preserving layout, escapes and line endings', () => {
	const canvas = '{\r\n  "nodes": [\r\n' +
		'    {"file":"Books/A/Idea (1).md","type":"file","subpath":"#^keep"},\r\n' +
		'    {"type":"text","text":"Books/A/Idea (1).md"},\r\n' +
		'    {"type":"file","file":"Books\\/A\\/photo.png","extra":{"file":"Books/A/x"}},\r\n' +
		'    {"type":"file","file":"Books/Alpha/Home.md"}\r\n  ], "edges": []\r\n}';
	const expected = canvas.replace('"file":"Books/A/Idea (1).md"', '"file":"New shelf/Topic/A2/Idea (1).md"')
		.replace('"Books\\/A\\/photo.png"', '"New shelf/Topic/A2/photo.png"');
	assert.equal(relocateCanvasReferences(canvas, source, destination), expected);
	assert.equal(relocateCanvasReferences(expected, source, destination), expected);
	assert.throws(() => relocateCanvasReferences('{bad}', source, destination));
	assert.throws(() => relocateCanvasReferences('{"nodes":[{"type":"file","file":"x","file":"Books/A/y"}]}', source, destination));
});
