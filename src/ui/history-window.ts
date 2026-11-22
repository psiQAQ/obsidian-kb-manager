export const historyRowHeight=32;
const overscan=10;

interface DetailSize { index:number; height:number }
interface HistoryAnchor { index:number; offset:number }

function rowSpace(y:number,detail?:DetailSize){
	if(!detail)return y;
	const endOfRow=(detail.index+1)*historyRowHeight;
	return y-Math.min(detail.height,Math.max(0,y-endOfRow));
}

export function historyWindow(scrollTop:number,height:number,count:number,detail?:DetailSize) {
	const start=Math.min(count,Math.max(0,Math.floor(rowSpace(scrollTop,detail)/historyRowHeight)-overscan));
	const end=Math.min(count,Math.ceil(rowSpace(scrollTop+height,detail)/historyRowHeight)+overscan);
	return {start,end};
}

/** Keep the scrollbar's full height while mounting only the nearby rows. */
export class HistoryWindow {
	private readonly list:HTMLElement;
	private readonly createRow:(index:number)=>HTMLButtonElement;
	private readonly baseLabel:string;
	private readonly approachingEnd:()=>void;
	private readonly peerLabel:string;
	private readonly dockedDetailId?:string;
	private readonly top:HTMLElement;
	private readonly rows:HTMLElement;
	private readonly bottom:HTMLElement;
	private readonly detailGap:HTMLElement;
	private readonly observer:ResizeObserver;
	private mounted=new Map<number,HTMLButtonElement>();
	private detail?:DetailSize & {element:HTMLElement};
	private frame=0;
	private count=0;
	private selected=-1;
	private base='';
	private peer='';
	private focusIndex=0;
	private lastScrollTop=0;

	constructor(
		list:HTMLElement,createRow:(index:number)=>HTMLButtonElement,baseLabel:string,
		approachingEnd:()=>void,peerLabel='',dockedDetailId?:string,
	){
		this.list=list;
		this.createRow=createRow;
		this.baseLabel=baseLabel;
		this.approachingEnd=approachingEnd;
		this.peerLabel=peerLabel;
		this.dockedDetailId=dockedDetailId;
		this.rows=list.createDiv();
		this.top=this.rows.createDiv({attr:{'aria-hidden':'true'}});
		this.detailGap=this.rows.createDiv({attr:{'aria-hidden':'true'}});
		this.bottom=this.rows.createDiv({attr:{'aria-hidden':'true'}});
		const Observer=list.ownerDocument.defaultView?.ResizeObserver??ResizeObserver;
		this.observer=new Observer(this.schedule);
		this.observer.observe(list);
		list.addEventListener('scroll',this.schedule,{passive:true});
	}

	destroy(){
		this.observer.disconnect();
		this.list.removeEventListener('scroll',this.schedule);
		this.list.win.cancelAnimationFrame(this.frame);
	}

	update(count:number,lanes:number){
		this.count=count;
		this.list.setCssProps({'--kb-history-lanes':String(lanes),'--kb-history-row-height':historyRowHeight+'px'});
		this.paint();
	}

	mark(index:number,base:string,peer=''){
		this.selected=index;
		this.base=base;
		this.peer=peer;
		if(index>=0)this.focusIndex=index;
		this.paint();
	}

	setDetail(index:number,element?:HTMLElement){
		const previous=this.detail;
		const next=index>=0 && element?{index,element,height:0}:undefined;
		if(previous?.index===next?.index && previous?.element===next?.element){this.refresh();return;}
		const anchor=this.anchor();
		if(previous){
			this.observer.unobserve(previous.element);
			if(previous.element!==next?.element)previous.element.remove();
		}
		this.detail=next;
		if(this.detail){
			this.paint(this.anchorOffset(anchor));
			this.measureDetail();
			this.observer.observe(this.detail.element,{box:'border-box'});
		}
		this.restoreAnchor(anchor);
	}

	anchor():HistoryAnchor{
		return this.anchorAt(this.list.scrollTop);
	}

	restore(index:number,offset:number){
		this.measureDetail();
		this.restoreAnchor({index,offset});
	}

	reveal(index:number,focus=false,inline=false){
		this.refresh();
		const y=this.rowOffset(index);
		const preview=inline && this.detail?.index===index?Math.min(this.detail.height,80):0;
		const bottom=y+historyRowHeight+preview;
		if(y<this.list.scrollTop)this.list.scrollTop=y;
		else if(bottom>this.list.scrollTop+this.list.clientHeight)this.list.scrollTop=Math.min(y,bottom-this.list.clientHeight);
		this.paint();
		if(focus)this.mounted.get(index)?.focus({preventScroll:true});
	}

	focusVisible(){
		this.refresh();
		for(const node of this.mounted.values())if(node.tabIndex===0){node.focus({preventScroll:true});return;}
		this.list.focus({preventScroll:true});
	}

	private rowOffset(index:number){
		return index*historyRowHeight+(this.detail && index>this.detail.index?this.detail.height:0);
	}

	private anchorAt(y:number):HistoryAnchor{
		const detail=this.detail,index=Math.floor(rowSpace(y,detail)/historyRowHeight);
		const withinDetail=detail && index===detail.index+1 && y<this.rowOffset(index);
		const row=withinDetail?detail.index:index;
		return {index:row,offset:y-this.rowOffset(row)};
	}

	private anchorOffset({index,offset}:HistoryAnchor){
		const room=historyRowHeight+(this.detail?.index===index?this.detail.height:0);
		return this.rowOffset(index)+(offset<room?offset:room-1);
	}

	private restoreAnchor(anchor:HistoryAnchor){
		const limit=Math.max(0,this.rowOffset(this.count)-this.list.clientHeight);
		const y=Math.max(0,Math.min(this.anchorOffset(anchor),limit));
		this.paint(y);
	}

	private measureDetail(){
		if(this.detail)this.detail.height=this.detail.element.getBoundingClientRect().height;
	}

	private refresh(){
		const detail=this.detail,height=detail?.element.getBoundingClientRect().height;
		if(detail && height!==undefined && height!==detail.height){
			const scroll=this.list.scrollTop;
			// The browser can clamp scrollTop before ResizeObserver reports a shorter panel.
			const clamped=height<detail.height && scroll<this.lastScrollTop &&
				scroll>=this.list.scrollHeight-this.list.clientHeight-1;
			const anchor=this.anchorAt(clamped?this.lastScrollTop:scroll);
			detail.height=height;
			this.restoreAnchor(anchor);
		}else this.paint();
	}

	private readonly schedule=()=>{
		if(this.frame)return;
		this.frame=this.list.win.requestAnimationFrame(()=>{
			this.frame=0;
			this.refresh();
			if(this.list.scrollTop+this.list.clientHeight>=this.rowOffset(this.count)-6*historyRowHeight)
				this.approachingEnd();
		});
	};

	private paint(scrollTop=this.list.scrollTop){
		const detail=this.detail,viewportEnd=scrollTop+this.list.clientHeight;
		const {start,end}=historyWindow(scrollTop,this.list.clientHeight,this.count,detail);
		const visibleStart=Math.floor(rowSpace(scrollTop,detail)/historyRowHeight);
		const visibleEnd=Math.ceil(rowSpace(viewportEnd,detail)/historyRowHeight);
		const tabStop=visibleStart>=visibleEnd?-1:
			this.focusIndex>=visibleStart && this.focusIndex<visibleEnd?this.focusIndex:visibleStart;
		const focused=this.list.doc.activeElement;
		const next=new Map<number,HTMLButtonElement>();
		let moveFocus=false;
		for(const [index,node] of this.mounted)if(index<start || index>=end){
			if(node.contains(focused))moveFocus=true;
			node.remove();
		}

		const split=detail?detail.index+1:undefined;
		const topRows=split===undefined?start:Math.min(start,split);
		const bottomRows=split===undefined?end:Math.max(end,split);
		this.top.setCssProps({height:topRows*historyRowHeight+'px'});
		this.bottom.setCssProps({height:(this.count-bottomRows)*historyRowHeight+'px'});
		const children:HTMLElement[]=[this.top];
		if(detail && split!==undefined && split<=start){
			this.detailGap.setCssProps({height:(start-split)*historyRowHeight+'px'});
			children.push(detail.element,this.detailGap);
		}
		for(let index=start;index<end;index++){
			const node=this.mounted.get(index)??this.createRow(index);
			this.markRow(node,index);
			node.tabIndex=index===tabStop?0:-1;
			children.push(node);
			if(detail && split===index+1)children.push(detail.element);
			next.set(index,node);
		}
		if(detail && split!==undefined && split>end){
			this.detailGap.setCssProps({height:(split-end)*historyRowHeight+'px'});
			children.push(this.detailGap,detail.element);
		}
		children.push(this.bottom);
		if(detail && split!==undefined){
			const inert=split<start || split>end;
			if(inert && !detail.element.inert && detail.element.contains(focused))moveFocus=true;
			detail.element.inert=inert;
		}
		// Keep the detail in flow so it can resize while its commit button is outside the window.
		if(!children.includes(this.detailGap))this.detailGap.remove();
		let cursor=this.rows.firstElementChild;
		for(const child of children){
			if(child!==cursor)this.rows.insertBefore(child,cursor);
			cursor=child.nextElementSibling;
		}
		this.mounted=next;
		if(moveFocus)(next.get(tabStop)??this.list).focus({preventScroll:true});
		// A temporarily shorter DOM can clamp the viewport during row and spacer replacement.
		if(this.list.scrollTop!==scrollTop)this.list.scrollTop=scrollTop;
		this.lastScrollTop=this.list.scrollTop;
	}

	private markRow(node:HTMLButtonElement,index:number){
		node.setAttribute('aria-pressed',String(index===this.selected));
		const expanded=this.dockedDetailId?index===this.selected:this.detail?.index===index;
		const controls=this.detail?.element.id || this.dockedDetailId;
		node.setAttribute('aria-expanded',String(expanded));
		if(expanded && controls)node.setAttribute('aria-controls',controls);
		else node.removeAttribute('aria-controls');
		const base=!!this.base && node.dataset.oid===this.base,peer=!!this.peer && node.dataset.oid===this.peer;
		node.toggleAttribute('data-comparison-base',base);
		node.toggleAttribute('data-comparison-peer',peer);
		const description=[base?this.baseLabel:'',peer?this.peerLabel:''].filter(Boolean).join(' · ');
		if(description)node.setAttribute('aria-description',description);
		else node.removeAttribute('aria-description');
	}
}
