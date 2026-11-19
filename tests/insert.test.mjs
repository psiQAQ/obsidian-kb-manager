import test from 'node:test';
import assert from 'node:assert/strict';
import {insertTemplate} from '../src/kb/insert.ts';
const render=(note,template,cursor=note.length)=>insertTemplate(note,template,cursor,'My note',(kind,pattern)=>pattern || kind);
test('template preview preserves existing property text, values and cursor context',()=>{
	const note='---\r\n# retain this comment\r\nrating: 2\r\n---\r\nbefore after';
	const tpl='---\nrating: 5\ncreated: "{{date:YYYY-MM-DD}}"\n---\n{{title}}';
	const p=render(note,tpl,note.indexOf(' after'));
	assert.deepEqual(p.conflicts,['rating']);
	assert.equal(p.text,'---\r\n# retain this comment\r\nrating: 2\r\ncreated: YYYY-MM-DD\r\n---\r\nbeforeMy note after');
	assert.equal(p.text.slice(p.cursor),' after');
});
test('template variables work in plain notes and malformed properties block insertion',()=>{
	assert.equal(render('hi',' {{time}} {{date}}').text,'hi time date');
	assert.equal(render('Body','---\ntags: [meeting]\n---\nHi').text,'---\ntags:\n  - meeting\n---\nBodyHi');
	assert.throws(()=>render('---\ninvalid','hello'));
	assert.throws(()=>render('ok','---\nx: 1\nx: 2\n---'));
});
