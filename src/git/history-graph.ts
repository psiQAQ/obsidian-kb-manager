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
	labels:Map<string,string[]>;
	branch:string;
}

export async function snapshotHistory(dir:string,allBranches:boolean):Promise<HistorySnapshot> {
	const branch=await guardGit(dir,new Set(),true);
	const [head,refs]=await Promise.all([
		headOid(dir),
		gitResult(dir,['for-each-ref','--format=%(objectname) %(refname) %(symref)','refs/heads/','refs/remotes/']),
	]);
	const tips=new Set<string>(head?[head]:[]);
	const labels=new Map<string,string[]>();
	for(const line of refs.stdout.toString('utf8').trimEnd().split('\n')){
		const [oid,ref,symbolic]=line.split(' ');
		if(!oid || !ref || symbolic)continue;
		const name=ref.replace(/^refs\/(heads|remotes)\//u,'');
		const names=labels.get(oid)??[];
		names.push(ref==='refs/heads/'+branch?'HEAD · '+name:name);
		labels.set(oid,names);
		if(allBranches)tips.add(oid);
	}
	return {tips:[...tips],labels,branch};
}

/** Each request traverses the same immutable tips, including both sides of merges. */
export async function readGraphPage(dir:string,tips:readonly string[],offset:number,size:number):Promise<GraphCommit[]> {
	if(!tips.length)return [];
	if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(size)||size<1||tips.some(t=>!/^[a-f0-9]{40}$/u.test(t)))
		throw new Error('Invalid history page');
	const result=await gitResult(dir,['log','--no-show-signature','--no-notes','--topo-order','--skip='+offset,'--max-count='+size,
		'-z','--format=%H%x00%P%x00%an%x00%at%x00%B','--stdin','--'],{stdin:Buffer.from(tips.join('\n')+'\n')});
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
export interface Rail { from:number; to:number; color:number }
export interface GraphRow {
	commit:GraphCommit;
	lane:number;
	color:number;
	width:number;
	incoming:boolean;
	rails:Rail[];
	parents:Rail[];
}

/** The frontier contains the parents expected by rows above the next commit. */
export class HistoryLanes {
	private active:Lane[]=[];
	private nextColor=0;
	append(commit:GraphCommit):GraphRow {
		const before=this.active;
		const found=before.findIndex(t=>t.oid===commit.oid);
		const lane=found<0?before.length:found;
		const color=before[lane]?.color??this.nextColor++;
		const after=before.filter(t=>t.oid!==commit.oid);
		let insert=lane;
		for(const [index,oid] of commit.parents.entries()){
			if(after.some(t=>t.oid===oid))continue;
			after.splice(insert++,0,{oid,color:index===0?color:this.nextColor++});
		}
		const rail=(from:number,oid:string):Rail=>{
			const to=after.findIndex(t=>t.oid===oid);
			return {from,to,color:after[to]!.color};
		};
		const rails=before.flatMap((t,i)=>t.oid===commit.oid?[]:[rail(i,t.oid)]);
		const parents=commit.parents.map(oid=>rail(lane,oid));
		this.active=after;
		return {commit,lane,color,width:Math.max(lane+1,before.length,after.length),incoming:found>=0,rails,parents};
	}
}

export class GraphHistory {
	readonly rows:GraphRow[]=[];
	private readonly lanes=new HistoryLanes();
	private pending?:Promise<void>;
	complete=false;
	private dir:string;
	readonly snapshot:HistorySnapshot;
	constructor(dir:string,snapshot:HistorySnapshot){this.dir=dir;this.snapshot=snapshot;}
	async load(count:number){
		while(!this.complete && this.rows.length<count){
			this.pending??=this.fetch(Math.min(200,count-this.rows.length)).finally(()=>{this.pending=undefined;});
			await this.pending;
		}
	}
	private async fetch(size:number){
		const commits=await readGraphPage(this.dir,this.snapshot.tips,this.rows.length,size);
		for(const commit of commits)this.rows.push(this.lanes.append(commit));
		this.complete=commits.length<size;
	}
}
