export const historyRowHeight=32;
const overscan=10;

export function historyWindow(scrollTop:number,height:number,count:number) {
	const start=Math.min(count,Math.max(0,Math.floor(scrollTop/historyRowHeight)-overscan));
	const end=Math.min(count,Math.ceil((scrollTop+height)/historyRowHeight)+overscan);
	return {start,end};
}

/** Keep the scrollbar's full height while mounting only the nearby rows. */
export class HistoryWindow {
	private readonly list:HTMLElement;
	private readonly createRow:(index:number)=>HTMLButtonElement;
	private readonly baseLabel:string;
	private readonly approachingEnd:()=>void;
	private readonly top:HTMLElement;
	private readonly rows:HTMLElement;
	private readonly bottom:HTMLElement;
	private readonly observer:ResizeObserver;
	private mounted=new Map<number,HTMLButtonElement>();
	private frame=0;
	private count=0;
	private selected=-1;
	private base='';
	private focusIndex=0;

	constructor(
		list:HTMLElement,createRow:(index:number)=>HTMLButtonElement,baseLabel:string,approachingEnd:()=>void,
	){
		this.list=list;this.createRow=createRow;this.baseLabel=baseLabel;this.approachingEnd=approachingEnd;
		this.top=list.createDiv({attr:{'aria-hidden':'true'}});
		this.rows=list.createDiv();
		this.bottom=list.createDiv({attr:{'aria-hidden':'true'}});
		this.observer=new ResizeObserver(this.schedule);
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

	mark(index:number,base:string){
		this.selected=index;
		this.base=base;
		if(index>=0)this.focusIndex=index;
		this.paint();
	}

	reveal(index:number,focus=false){
		const y=index*historyRowHeight;
		if(y<this.list.scrollTop)this.list.scrollTop=y;
		else if(y+historyRowHeight>this.list.scrollTop+this.list.clientHeight)
			this.list.scrollTop=y+historyRowHeight-this.list.clientHeight;
		this.paint();
		if(focus)this.mounted.get(index)?.focus({preventScroll:true});
	}

	focusVisible(){
		this.paint();
		for(const node of this.mounted.values())if(node.tabIndex===0){node.focus({preventScroll:true});return;}
		this.list.focus({preventScroll:true});
	}

	private readonly schedule=()=>{
		if(this.frame)return;
		this.frame=this.list.win.requestAnimationFrame(()=>{
			this.frame=0;
			this.paint();
			if(this.list.scrollTop+this.list.clientHeight>=this.count*historyRowHeight-6*historyRowHeight)
				this.approachingEnd();
		});
	};

	private paint(){
		const {start,end}=historyWindow(this.list.scrollTop,this.list.clientHeight,this.count);
		this.top.setCssProps({height:start*historyRowHeight+'px'});
		this.bottom.setCssProps({height:(this.count-end)*historyRowHeight+'px'});
		const next=new Map<number,HTMLButtonElement>();
		const visibleStart=Math.floor(this.list.scrollTop/historyRowHeight);
		const visibleEnd=Math.ceil((this.list.scrollTop+this.list.clientHeight)/historyRowHeight);
		const tabStop=this.focusIndex>=visibleStart && this.focusIndex<visibleEnd?this.focusIndex:visibleStart;
		for(const [index,node] of this.mounted)if(index<start || index>=end)node.remove();
		for(let index=start;index<end;index++){
			const node=this.mounted.get(index)??this.createRow(index);
			node.setAttribute('aria-pressed',String(index===this.selected));
			const base=!!this.base && node.dataset.oid===this.base;
			node.toggleAttribute('data-comparison-base',base);
			if(base)node.setAttribute('aria-description',this.baseLabel);
			else node.removeAttribute('aria-description');
			node.tabIndex=index===tabStop?0:-1;
			if(!node.parentElement)this.rows.insertBefore(node,this.rows.children[index-start]??null);
			next.set(index,node);
		}
		this.mounted=next;
	}
}
