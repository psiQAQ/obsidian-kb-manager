import { guardGit } from './guard.ts';
import { gitResult } from './network-native.ts';
import { headOid } from './repository.ts';

export interface GraphCommit {
	oid:string;
	parents:string[];
	author:string;
	timestamp:number;
	message:string;
}

export interface HistorySnapshot {
	tips:string[];
	labels:Map<string,GraphRef[]>;
	refs:GraphRef[];
	branch:string;
	head:string;
	detached:boolean;
}

export interface GraphRef {
	ref:string;
	name:string;
	kind:'head'|'local'|'remote'|'tag'|'stash';
	oid:string;
	tagOid?:string;
}

export type HistoryScope='current'|'all'|readonly string[];

export function historyRefKey(ref:GraphRef) {
	return ref.kind==='stash'?'stash:'+ref.oid:ref.ref;
}

function historyTips(snapshot:HistorySnapshot,scope:HistoryScope,currentStashes:ReadonlySet<string>):string[] {
	const tips=new Set<string>();
	const selected=typeof scope==='string'?undefined:new Set(scope);
	if(snapshot.head && typeof scope==='string')tips.add(snapshot.head);
	for(const ref of snapshot.refs){
		if(selected?.has(historyRefKey(ref)) || currentStashes.has(ref.oid) || scope==='all')tips.add(ref.oid);
	}
	return [...tips];
}

export async function snapshotHistory(dir:string,scope:HistoryScope|boolean='current',showStashes=false):Promise<HistorySnapshot> {
	const range=scope===true?'all':scope===false?'current':scope;
	const branch=await guardGit(dir,new Set(),true);
	const [head,refs,stashes]=await Promise.all([
		headOid(dir),
		gitResult(dir,['for-each-ref','--format=%(refname)%00%(symref)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
			'refs/heads/','refs/remotes/','refs/tags/']),
		showStashes?gitResult(dir,['stash','list','-z','--format=%H%x00%gd%x00%P']):undefined,
	]);
	const snapshot:HistorySnapshot={tips:[],labels:new Map(),refs:[],branch,head,detached:branch==='HEAD'};
	const add=(entry:GraphRef)=>{
		snapshot.refs.push(entry);
		const labels=snapshot.labels.get(entry.oid)??[];
		labels.push(entry);
		snapshot.labels.set(entry.oid,labels);
	};
	if(head && snapshot.detached)add({ref:'HEAD',name:'HEAD',kind:'head',oid:head});
	for(const line of refs.stdout.toString('utf8').trimEnd().split('\n')){
		const [ref,symbolic,object,objectType,peeled,peeledType]=line.split('\0');
		if(!object || !ref || symbolic)continue;
		const kind=ref.startsWith('refs/heads/')?'local':ref.startsWith('refs/remotes/')?'remote':'tag';
		let oid=objectType==='commit'?object:peeledType==='commit'?peeled:undefined;
		if(kind==='tag' && peeledType==='tag'){
			// for-each-ref dereferences one tag layer. Handle tags on tags without trusting a ref name in the command.
			const resolved=await gitResult(dir,['rev-parse','--verify','--quiet',object+'^{commit}'],{allowedExitCodes:[0,1]});
			oid=resolved.stdout.toString('ascii').trim() || undefined;
		}
		if(!oid)continue;
		add({ref,name:ref.split('/').slice(2).join('/'),kind,oid,...(objectType==='tag'?{tagOid:object}:{})});
	}
	const entries=stashes?.stdout.toString('utf8').split('\0')??[];
	const currentStashes=new Set<string>(),reachable=new Map<string,boolean>([[head,!!head]]);
	for(let i=0;i+2<entries.length;i+=3){
		const [oid,ref,parents]=entries.slice(i,i+3);
		if(!oid || !ref || !/^stash@\{\d+\}$/u.test(ref))continue;
		add({ref,name:ref,kind:'stash',oid});
		const base=parents?.split(' ')[0];
		if(range!=='current' || !head || !base || !/^[0-9a-f]{40}$/u.test(base))continue;
		if(!reachable.has(base)){
			const {code}=await gitResult(dir,['merge-base','--is-ancestor',base,head],{allowedExitCodes:[0,1]});
			reachable.set(base,code===0);
		}
		if(reachable.get(base))currentStashes.add(oid);
	}
	snapshot.tips=historyTips(snapshot,range,currentStashes);
	return snapshot;
}

export async function historyWorktree(dir:string):Promise<{staged:number;unstaged:number}|undefined> {
	await guardGit(dir,new Set(),false,false,'detached');
	const {stdout}=await gitResult(dir,['status','--porcelain=v1','-z','--no-renames','--untracked-files=all','--ignore-submodules=all']);
	let staged=0,unstaged=0;
	for(const row of stdout.toString('utf8').split('\0').filter(Boolean)){
		if(row[0]!==' ' && row[0]!=='?')staged++;
		if(row[1]!==' ')unstaged++;
	}
	return staged || unstaged?{staged,unstaged}:undefined;
}

/** Each request traverses the same immutable tips, including both sides of merges. */
export async function readGraphPage(dir:string,tips:readonly string[],offset:number,size:number):Promise<GraphCommit[]> {
	if(!tips.length)return [];
	if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(size)||size<1||tips.some(t=>!/^[a-f0-9]{40}$/u.test(t)))
		throw new Error('Invalid history page');
	return logCommits(dir,tips,['--topo-order','--skip='+offset,'--max-count='+size]);
}

async function logCommits(dir:string,revs:readonly string[],order:string[]):Promise<GraphCommit[]> {
	if(!revs.length)return [];
	const result=await gitResult(dir,['log','--no-show-signature','--no-notes',...order,
		'-z','--format=%H%x00%P%x00%an%x00%at%x00%B','--stdin','--'],{stdin:Buffer.from(revs.join('\n')+'\n')});
	const fields=result.stdout.toString('utf8').split('\0');
	const commits:GraphCommit[]=[];
	for(let i=0;i<fields.length-1;i+=5){
		const [oid,parent,author,seconds,message]=fields.slice(i,i+5);
		if(!oid||parent===undefined||author===undefined||!seconds||message===undefined)throw new Error('Invalid Git log record');
		commits.push({oid,parents:parent.split(' ').filter(Boolean),author,timestamp:Number(seconds),message});
	}
	return commits;
}

export interface Lane { oid:string; color:number }
export interface Rail { from:number; to:number; color:number; startColor?:number }
export interface GraphRow {
	commit:GraphCommit;
	lane:number;
	color:number;
	width:number;
	incoming:boolean;
	rails:Rail[];
	parents:Rail[];
}

export const historyTrackColors=8;

/** The frontier contains the parents expected by rows above the next commit. */
export class HistoryLanes {
	private active:Lane[]=[];
	private nextColor=0;
	private allocateColor(lanes:Lane[]){
		const used=new Set(lanes.map(lane=>lane.color%historyTrackColors));
		let color=this.nextColor++;
		if(used.size<historyTrackColors){
			while(used.has(color%historyTrackColors))color=this.nextColor++;
		}
		return color;
	}
	append(commit:GraphCommit):GraphRow {
		const before=this.active;
		const found=before.findIndex(t=>t.oid===commit.oid);
		const lane=found<0?before.length:found;
		const color=before[lane]?.color??this.allocateColor(before);
		const after=before.filter(t=>t.oid!==commit.oid);
		let insert=lane;
		for(const oid of commit.parents){
			if(after.some(t=>t.oid===oid))continue;
			after.splice(insert,0,{oid,color:insert===lane?color:this.allocateColor(after)});
			insert++;
		}
		const rail=(from:number,oid:string):Rail=>{
			const to=after.findIndex(t=>t.oid===oid);
			return {from,to,color:after[to]!.color};
		};
		const rails=before.flatMap((t,i)=>t.oid===commit.oid?[]:[rail(i,t.oid)]);
		const parents=commit.parents.map(oid=>rail(lane,oid));
		if(parents[0] && !parents.some(parent=>parent.color===color))parents[0].startColor=color;
		this.active=after;
		return {commit,lane,color,width:Math.max(lane+1,before.length,after.length),incoming:found>=0,rails,parents};
	}
}

export class GraphHistory {
	readonly rows:GraphRow[]=[];
	readonly indices=new Map<string,number>();
	readonly children=new Map<string,string[]>();
	width=0;
	private readonly lanes=new HistoryLanes();
	private pending?:Promise<void>;
	private order?:string[];
	complete=false;
	private dir:string;
	readonly snapshot:HistorySnapshot;
	readonly workingRow?:GraphRow;
	constructor(dir:string,snapshot:HistorySnapshot,showWorktree=false){
		this.dir=dir;this.snapshot=snapshot;
		if(showWorktree){
			const parents=snapshot.tips.includes(snapshot.head)?[snapshot.head]:[];
			this.workingRow=this.lanes.append({oid:'worktree',parents,author:'',timestamp:0,message:''});
			this.width=this.workingRow.width;
		}
	}
	async load(count:number,active=()=>true){
		while(active() && !this.complete && this.rows.length<count){
			this.pending??=this.fetch(Math.min(800,count-this.rows.length)).finally(()=>{this.pending=undefined;});
			await this.pending;
		}
	}
	private async fetch(size:number){
		// Use bounded native pages at startup. For deep history, walk once and load metadata by object ID.
		const offset=this.rows.length;
		if(!this.order && offset>=128){
			const result=await gitResult(this.dir,['rev-list','--topo-order','--stdin','--'],
				{stdin:Buffer.from(this.snapshot.tips.join('\n')+'\n')});
			this.order=result.stdout.toString('ascii').trim().split('\n').filter(Boolean);
		}
		const commits=this.order?await logCommits(this.dir,this.order.slice(offset,offset+size),['--no-walk=unsorted']):
			await readGraphPage(this.dir,this.snapshot.tips,offset,size);
		for(const commit of commits){
			const row=this.lanes.append(commit);
			this.width=Math.max(this.width,row.width);
			this.indices.set(commit.oid,this.rows.length);
			this.rows.push(row);
			for(const parent of commit.parents){
				const children=this.children.get(parent)??[];
				children.push(commit.oid);
				this.children.set(parent,children);
			}
		}
		this.complete=commits.length<size;
	}
}
