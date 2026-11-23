import assert from 'node:assert/strict';
import test from 'node:test';
import {instanceText,rebindSlots} from '../src/kb/instance-text.ts';
import {classifyPathBinding,literalRootOffsets} from '../src/kb/path-binding-ownership.ts';

const root='Libraries/My library';
const destination='Archive/Updated';
const vars={destination:root,description:'',displayName:'Library'};
const render=(file,source)=>instanceText(file,source,['kb_root'],vars);

test('only opaque root slots remain in a mixed note with frontmatter, links, and an inline Base',()=>{
	const file='Mixed.md';
	const lines=['---','relations:','  - "[[{{kb_root}}/Note]]"','plain: "{{kb_root}}/Literal"','---',
		'![[{{kb_root}}/Views/List.base#All]]','[Note](<{{kb_root}}/Note.md>)','[Invalid]({{kb_root}}/Note.md)',
		'[Reference][note]','[note]: <{{kb_root}}/Note.md>','`[[{{kb_root}}/Example]]`',
		'```base','filters: file.inFolder("{{kb_root}}/Notes")','```',
		'> ```js','> print("[[{{kb_root}}/Example]]");','> ```',
		'```js','const root = "{{kb_root}}";','```'];
	const source=lines.join('\r\n');
	const {content,offsets}=render(file,source);
	const rebound=rebindSlots(content,offsets,root,destination,file);
	assert.equal(rebound,lines.map((line,index)=>line.replaceAll('{{kb_root}}',
		[3,7,10,15,18].includes(index)?destination:root)).join('\r\n'));
	const allOffsets=literalRootOffsets(source,'{{kb_root}}');
	const legacy={path:file,root,role:'template-root',offsets:allOffsets,fingerprint:'historical'};
	assert.deepEqual(classifyPathBinding(legacy,content)?.opaque?.offsets,offsets);
	assert.equal(classifyPathBinding(legacy,'Unrelated text'),undefined);
});

test('Canvas file nodes and scoped Base paths are scanner-owned, unrelated fields remain bound',()=>{
	const canvas='{"nodes":[{"id":"a","type":"file","file":"{{kb_root}}/Note.md"},{"id":"b","type":"text","text":"{{kb_root}}/Note.md"}]}';
	const draw=render('Map.canvas',canvas);
	const nodes=JSON.parse(rebindSlots(draw.content,draw.offsets,root,destination,'Map.canvas')).nodes;
	assert.equal(nodes[0].file,root+'/Note.md');
	assert.equal(nodes[1].text,destination+'/Note.md');
	const template=['filters:', '  and:', '    - file.path.startsWith("{{kb_root}}/")',
		'    - categories.contains(link("{{kb_root}}/Categories/Books"))',
		'    - file.folder == "{{kb_root}}/Unparsed"',
		'    - file.path.startsWith("{{kb_root}}")'].join('\n');
	const {content,offsets}=render('Books.base',template);
	assert.deepEqual(rebindSlots(content,offsets,root,destination,'Books.base').split('\n').slice(2),[
		`    - file.path.startsWith("${root}/")`, `    - categories.contains(link("${root}/Categories/Books"))`,
		`    - file.folder == "${destination}/Unparsed"`, `    - file.path.startsWith("${destination}")`,
	]);
});

test('an old no-offset record only transfers when its complete original root use is understood',()=>{
	const path='Templates/Item.md';
	const binding={path,root,role:'kepano-bindings',fingerprint:'historical'};
	const template={id:'kepano',version:'8'};
	const link=`[[${root}/Categories/Items]]\n`;
	assert.deepEqual(classifyPathBinding(binding,link,template),{});
	assert.equal(classifyPathBinding(binding,link+'\n```js\nconst root = "'+root+'";\n```\n',template),undefined);
	assert.equal(classifyPathBinding(binding,link,{id:'third-party',version:'8'}),undefined);
});
