import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { renderKepano, rebindKepano } from '../src/kb/kepano.ts';
import { kepanoBindingAssets, kepanoTemplate } from '../src/kb/template-core.ts';

const dir = new URL('../assets/templates/collections/kepano/', import.meta.url);
function entries(subdirectory = '') {
	return readdirSync(new URL(subdirectory, dir), { withFileTypes: true }).flatMap(file => {
		const name = subdirectory + file.name;
		return file.isDirectory() ? entries(name + '/') : [[name, readFileSync(new URL(name, dir), 'utf8')]];
	});
}
const skeleton = Object.fromEntries(entries());
const previous = "Libraries/一号 Allen's $&";
const destination = 'Collections/二号';
const instance = root => Object.fromEntries(kepanoTemplate(skeleton, root).files.map(({name,bytes}) => [name, new TextDecoder().decode(bytes)]));
const rendered = instance(previous);
const moved = instance(destination);
const metadata = (text, path) => parse(/^---\r?\n([\s\S]*?)\r?\n---/u.exec(text[path])[1]);

test('built-in Kepano edition contains the pinned templates, categories, examples and MIT license', () => {
	const names = Object.keys(skeleton);
	assert.equal(names.filter(n => /^Templates\/[^/]+\.md$/u.test(n)).length, 52);
	assert.equal(names.filter(n => /^Categories\/[^/]+\.md$/u.test(n)).length, 21);
	assert.equal(names.filter(n => n.endsWith('.base')).length, 30);
	assert.ok(['README.md','Clippings/Buy wisely.md','Daily/2023-09-12.md','Notes/2023 Japan Trip.md','References/Out of Control.md','Attachments/.gitkeep'].every(n => names.includes(n)));
	assert.ok(names.every(n => ['Bindings.v5.json','kb-template.json','checks/category-links.mjs'].includes(n) || n.split('/').every(part => !part.startsWith('.') || part === '.gitkeep') && /(?:\.md|\.base|\.gitkeep)$/u.test(n)));
	assert.match(skeleton['LICENSE.md'], /Copyright \(c\) 2023 Steph Ango/u);
	assert.match(skeleton['LICENSE.md'], /473697347a0eaac790a6596229c741b3915f3b77/u);
	for (const [name, text] of Object.entries(skeleton)) {
		if (name.startsWith('Clippings/')) assert.match(text, /\r?\n---\r?\n\r?\n\[Read the source\]\(https:\/\/[^)]+\)\r?\n$/u);
		assert.doesNotMatch(text, /!\[[^\]]*\]\(https?:/u);
	}
});

test('new Kepano fields feed the instance views without carrying example-only values', () => {
	const base = name => parse(rendered['Templates/Bases/' + name + '.base']);
	const template = name => metadata(rendered, 'Templates/' + name + ' Template.md');
	assert.ok('monthlyUses' in template('Product'));
	assert.ok(base('Products').views.find(view => view.name === 'Cost per use').filters.and.includes('note.monthlyUses > 0'));
	assert.ok('pages' in template('Book'));
	assert.ok(base('Books').views.find(view => view.name === 'Books').order.includes('pages'));
	assert.equal(metadata(rendered,'References/Out of Control.md').pages, 528);
	assert.deepEqual(template('Podcast Episode').guests, []);
	assert.deepEqual(base('Podcast episodes').views.find(view => view.name === 'Guest').filters.and, ['list(guests).contains(this)']);
	assert.ok(metadata(rendered,'References/Well Made 145 Kevin Kelly.md').guests.includes(`[[${previous}/References/Kevin Kelly]]`));
	assert.equal(base('Clippings').views.find(view => view.name === 'Author').sort[0].property, 'created');
	assert.equal(metadata(rendered,'Clippings/Buy wisely.md').created, '2023-11-18');
	assert.deepEqual(template('City').coordinates, []);
	assert.deepEqual(template('Monthly Note').aliases, []);
	assert.equal(template('Monthly Note').previous, null);
	assert.equal(template('Monthly Note').next, null);
	for (const person of ['Actor','Author','Musician']) {
		assert.deepEqual(template(person).categories, [`[[${previous}/Categories/People]]`]);
	}
	assert.equal(template('Movie').last, null);
	assert.ok(['plot','scoreImdb','scoreRT','watchlist'].every(field => field in template('Movie')));
	assert.doesNotMatch(rendered['Templates/Bases/Movies.base'], /ratingImdb/u);
	assert.ok(base('Attachments').views.some(view => view.name === 'Unused attachments'));
});

test('old Kepano bindings retain scalar categories and historical month links after moves', () => {
	for (const version of ['1','2','3','4','5']) {
		const historical = kepanoBindingAssets(skeleton, version);
		const before = renderKepano(historical, previous);
		const month = 'Templates/Monthly Note Template.md';
		const actor = 'Templates/Actor Template.md';
		assert.equal(metadata(before,month).previous, `[[${previous}/Daily/2023-06]]`);
		assert.equal(metadata(before,actor).categories, `[[${previous}/Categories/People]]`);
		for (const file of [month,actor]) {
			const after = rebindKepano(file, before[file], previous, destination, historical);
			assert.deepEqual(after.manual, []);
			assert.equal(after.content, before[file].replaceAll(previous, destination));
		}
	}
});

test('two instances resolve every generated link, view and category without borrowing another library', () => {
	for (const [root, collection] of [[previous,rendered],[destination,moved]]) {
		for (const [name, text] of Object.entries(collection)) {
			assert.ok(!text.includes('__KB_ROOT__'), name);
			if (name.endsWith('.base')) {
				const base = parse(text);
				assert.equal(base.filters.and[0], 'file.path.startsWith(' + JSON.stringify(root + '/') + ')', name);
				for (const match of text.matchAll(/\blink\("([^"]+)"\)/gu)) {
					assert.ok(match[1].startsWith(root + '/Categories/'), name);
					assert.ok(collection[match[1].slice(root.length + 1) + '.md'], name);
				}
			} else if (name.endsWith('.md')) {
				const metadata = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
				if (metadata) parse(metadata[1]);
				for (const match of text.matchAll(/\[\[([^|#\]]+)(?:#([^|\]]+))?(?:\|[^\]]+)?\]\]/gu)) {
					assert.ok(match[1].startsWith(root + '/'), name + ': ' + match[0]);
					const path = match[1].slice(root.length + 1);
					assert.ok(collection[path] || collection[path + '.md'], name + ': ' + path);
					if (match[2] && path.endsWith('.base')) {
						assert.ok(parse(collection[path]).views.some(view => view.name === match[2]), name + ': ' + match[0]);
					}
				}
			}
		}
	}
	assert.equal(parse(rendered['Templates/Bases/Daily.base']).filters.and[1].or.length, 5);
	for (const root of ['KB/Bad#name', 'KB/Bad^name', 'KB/[Bad]', '../escape']) assert.throws(() => renderKepano(skeleton, root));
});

test('a clean move rebinds every declared field and running it twice is idempotent', () => {
	for (const [name, source] of Object.entries(rendered)) {
		const result = rebindKepano(name, source, previous, destination, skeleton);
		assert.deepEqual(result.manual, [], name);
		assert.equal(result.content, moved[name], name);
		const second = rebindKepano(name, result.content, previous, destination, skeleton);
		assert.deepEqual(second, { content: result.content, edits: [], manual: [] }, name);
	}
});

test('rebind preserves edited and additional YAML fields, comments, Markdown and fenced examples', () => {
	const base = 'Templates/Bases/Posts.base';
	const change = text => text.replace('list(categories).contains(link("' + previous + '/Categories/Posts"))',
		'list(categories).contains(link("My posts"))').replace(/and:(\r?\n)/u, 'and:$1    - file.ext == "md" # added$1');
	const custom = change(rendered[base]);
	const result = rebindKepano(base, custom, previous, destination, skeleton);
	assert.equal(result.edits.length, 1);
	assert.equal(result.manual.length, 1);
	assert.equal(result.content, custom.replace('file.path.startsWith("' + previous + '/")',
		'file.path.startsWith("' + destination + '/")'));

	const file = 'Categories/Podcasts.md';
	const link = '![[' + previous + '/Templates/Bases/Podcasts.base]]';
	const userText = '\n~~~md\n' + link + '\n~~~\n' + previous + ' personal note\n';
	const source = rendered[file].replace('related:', 'renamed:') + userText;
	const note = rebindKepano(file, source, previous, destination, skeleton);
	assert.equal(note.content, source.replace(link, '![[' + destination + '/Templates/Bases/Podcasts.base]]'));
	assert.equal(note.manual.length, 1);
	assert.ok(note.content.endsWith(userText));
	const duplicate = rebindKepano(file, source + link + '\n', previous, destination, skeleton);
	assert.equal(duplicate.content, source + link + '\n');
	assert.deepEqual(rebindKepano('Notes/Personal.md', source, previous, destination, skeleton),
		{ content: source, edits: [], manual: [] });
});
