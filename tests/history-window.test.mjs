import test from 'node:test';
import assert from 'node:assert/strict';
import {drawCommitGraphContinuation} from '../src/ui/history-graph-row.ts';
import {HistoryWindow,historyRowHeight} from '../src/ui/history-window.ts';

function fixture(t,dockedId){
	let frame,resize,scroll,pages=0,layoutChanged=()=>{};
	const win={
		requestAnimationFrame(callback){frame=callback;return 1;},
		cancelAnimationFrame(){frame=undefined;},
		ResizeObserver:class {
			constructor(callback){resize=callback;}
			observe(){}
			unobserve(){}
			disconnect(){resize=undefined;}
		},
	};
	const doc={activeElement:null,defaultView:win};
	class Element {
		children=[];
		parentElement=null;
		height=0;
		inert=false;
		id='';
		dataset={};
		attributes={};
		doc=doc;
		ownerDocument=doc;
		win=win;
		get firstElementChild(){return this.children[0]??null;}
		get nextElementSibling(){
			const siblings=this.parentElement?.children;
			return siblings?.[siblings.indexOf(this)+1]??null;
		}
		createDiv(){return this.createSvg('div',{});}
		createSvg(tag,{cls,attr}){
			const child=new Element();
			child.tag=tag;child.cls=cls;child.attributes={...attr};
			this.insertBefore(child,null);
			return child;
		}
		insertBefore(child,before){
			child.remove();
			this.children.splice(before?this.children.indexOf(before):this.children.length,0,child);
			child.parentElement=this;
			layoutChanged();
		}
		remove(){
			const siblings=this.parentElement?.children;
			if(siblings){
				siblings.splice(siblings.indexOf(this),1);
				layoutChanged();
			}
			this.parentElement=null;
		}
		contains(other){return other===this || this.children.some(child=>child.contains(other));}
		focus(){doc.activeElement=this;}
		setCssProps({height}){
			if(height!==undefined){this.height=Number.parseFloat(height);layoutChanged();}
		}
		getBoundingClientRect(){return {height:this.height};}
		get offsetHeight(){return this.height+this.children.reduce((sum,node)=>sum+node.offsetHeight,0);}
		addEventListener(type,handler){if(type==='scroll')scroll=handler;}
		removeEventListener(){scroll=undefined;}
		setAttribute(name,value){this.attributes[name]=value;}
		removeAttribute(name){delete this.attributes[name];}
		toggleAttribute(name,value){if(value)this.attributes[name]='';else this.removeAttribute(name);}
	}
	let position=0;
	const list=new Element();
	list.clientHeight=160;
	layoutChanged=()=>{position=Math.min(position,Math.max(list.offsetHeight-list.clientHeight,0));};
	Object.defineProperties(list,{
		scrollHeight:{get:()=>list.offsetHeight},
		scrollTop:{
			get(){layoutChanged();return position;},
			set(value){position=value;layoutChanged();},
		},
	});
	const window=new HistoryWindow(list,index=>{
		const node=new Element();
		node.dataset.oid=String(index);node.height=historyRowHeight;
		return node;
	},'Base',()=>{pages++;},'Other commit',dockedId);
	t.after(()=>window.destroy());
	const panel=new Element();
	panel.id='detail';
	const flush=()=>{const callback=frame;frame=undefined;callback?.();};
	const rows=()=>list.firstElementChild.children.filter(node=>node.dataset.oid!==undefined);
	const row=index=>rows().find(node=>node.dataset.oid===String(index));
	const move=y=>{list.scrollTop=y;scroll();flush();};
	return {window,list,panel,rows,row,move,resize(height){
		panel.height=height;resize();flush();
	},pages:()=>pages};
}

test('long inline detail keeps its real scroll height, tab order and comparison markers',t=>{
	const {window,list,panel,rows,row,move,resize}=fixture(t);
	const anchor=30,base=31,peer=32,rowY=anchor*historyRowHeight;
	window.update(100,3);
	panel.height=1000;
	window.mark(anchor,String(base),String(peer));
	window.setDetail(anchor,panel);
	window.reveal(anchor,true,true);
	assert.equal(list.scrollTop,rowY+32+80-list.clientHeight);
	assert.equal(row(anchor).nextElementSibling,panel);
	assert.equal(row(anchor).attributes['aria-controls'],panel.id);
	assert.equal(row(base).attributes['aria-description'],'Base');
	assert.equal(row(peer).attributes['aria-description'],'Other commit');
	assert.equal(list.doc.activeElement,row(anchor));
	assert.equal(row(anchor).tabIndex,0);

	move(rowY+500);
	assert.deepEqual(window.anchor(),{index:anchor,offset:500});
	assert.deepEqual(rows().filter(node=>node.tabIndex===0),[]);
	assert.equal(panel.inert,false);
	panel.focus();
	move(70*historyRowHeight+1000);
	assert.equal(row(anchor),undefined);
	assert.equal(panel.parentElement,list.firstElementChild);
	assert.equal(panel.inert,true);
	assert.equal(list.doc.activeElement,row(70));
	assert.equal(rows().length,25);
	resize(1260);
	assert.equal(list.scrollTop,70*historyRowHeight+1260);
	assert.equal(list.scrollHeight,100*historyRowHeight+1260);

	window.restore(anchor,530);
	assert.equal(list.scrollTop,rowY+530);
	assert.equal(panel.inert,false);
	window.setDetail(-1);
	window.focusVisible();
	assert.equal(list.scrollTop,rowY+31);
	assert.equal(list.scrollHeight,100*historyRowHeight);
	assert.equal(list.doc.activeElement,row(anchor));
	assert.equal(row(anchor).attributes['aria-expanded'],'false');
});

test('pagination sees the expanded height and asynchronous shrink preserves the row anchor',t=>{
	const {window,list,panel,move,resize,pages,row}=fixture(t);
	window.update(100,2);
	panel.height=1000;
	window.setDetail(99,panel);
	move(100*historyRowHeight+10);
	assert.equal(pages(),0);
	move(100*historyRowHeight+800);
	assert.equal(pages(),1);

	window.setDetail(30,panel);
	window.restore(94,2);
	resize(400);
	assert.equal(list.scrollTop,94*historyRowHeight+402);
	assert.deepEqual(window.anchor(),{index:94,offset:2});
	window.reveal(10);
	assert.equal(list.scrollTop,10*historyRowHeight);
	assert.equal(row(10).tabIndex,0);
});

test('scrolling to the end after each page preserves the requested viewport and loads the next page',t=>{
	const {window,list,panel,move,pages}=fixture(t);
	const initial=96,gap=453;
	window.update(initial,4);
	panel.height=gap;
	window.setDetail(17,panel);
	for(let page=1;page<=4;page++){
		const count=initial*page,end=count*historyRowHeight+gap-list.clientHeight;
		move(end);
		assert.equal(list.scrollTop,end);
		assert.equal(pages(),page);
		window.update(count+initial,4);
		assert.equal(list.scrollTop,end);
	}
});

test('docked detail retains ARIA controls while using the original fixed row heights',t=>{
	const {window,list,row}=fixture(t,'dock');
	window.update(15,1);
	window.mark(2,'','3');
	assert.equal(row(2).attributes['aria-controls'],'dock');
	assert.equal(row(2).attributes['aria-expanded'],'true');
	assert.equal(row(3).attributes['aria-expanded'],'false');
	assert.equal(list.scrollHeight,15*historyRowHeight);
});

test('inline graph continues each outgoing lane once using its color at the following row',t=>{
	const {panel}=fixture(t);
	drawCommitGraphContinuation(panel,{
		rails:[{from:3,to:0,color:9},{from:2,to:1,color:5}],
		parents:[{from:1,to:0,color:9,startColor:0},{from:1,to:2,color:6}],
	});
	const svg=panel.firstElementChild;
	assert.deepEqual(svg.cls,['kb-history-graph','kb-history-graph-continuation']);
	assert.deepEqual(svg.children.map(node=>[node.cls,node.attributes]),[
		['kb-track-1',{x1:8,x2:8,y1:0,y2:'100%'}],
		['kb-track-5',{x1:23,x2:23,y1:0,y2:'100%'}],
		['kb-track-6',{x1:38,x2:38,y1:0,y2:'100%'}],
	]);
});
