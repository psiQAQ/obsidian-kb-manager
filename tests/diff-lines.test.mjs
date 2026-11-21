import assert from 'node:assert/strict';
import test from 'node:test';
import { structuredPatch } from 'diff';
import { numberedLines, pairedLines } from '../src/ui/diff-lines.ts';
import { renderDiff } from '../src/ui/diff-table.ts';

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

test('jumping to an unrendered difference renders only a batch at the destination',()=>{
	class Element {
		children=[];
		constructor(tag,cls='',parent){this.tag=tag;this.classes=new Set(cls.split(' '));this.parent=parent;}
		createEl(tag,{cls,text}={}){
			const child=new Element(tag,cls,this);
			child.text=text;this.children.push(child);return child;
		}
		createDiv(options){return this.createEl('div',options);}
		createSpan(options){return this.createEl('span',options);}
		addClass(value){this.classes.add(value);}
		removeClass(value){this.classes.delete(value);}
		setText(value){this.text=value;}
		empty(){this.children=[];}
		remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
		scrollIntoView(){this.scrolled=true;}
		find(predicate){
			if(predicate(this))return this;
			for(const child of this.children){const match=child.find(predicate);if(match)return match;}
			return undefined;
		}
		querySelector(selector){return this.find(element=>element.classes.has(selector.slice(1)));}
	}
	const parent=new Element('div');
	const hunks=Array.from({length:500},(_,i)=>({oldStart:i+1,newStart:i+1,oldLines:1,newLines:1,lines:['-a','+b']}));
	renderDiff(parent,hunks,false,'old','new',0);
	const [previous,next,status,layout,start]=parent.children[0].children;
	const table=()=>parent.find(el=>el.tag==='tbody');
	const selected=()=>table().querySelector('.kb-diff-current');
	assert.equal(table().children.length,300);
	previous.onclick();
	assert.equal(status.text,'500 / 500');
	assert.equal(table().children.length,3);
	assert.equal(selected().children[0].text,'@@ -500,1 +500,1 @@');
	assert.equal(selected().scrolled,true);
	layout.onclick();
	assert.equal(table().children.length,2);
	assert.equal(selected().children[0].colSpan,2);
	next.onclick();
	assert.equal(status.text,'1 / 500');
	assert.equal(table().children.length,300);
	assert.equal(start.hidden,true);
});
