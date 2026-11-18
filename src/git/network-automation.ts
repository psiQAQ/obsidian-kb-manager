import type {AutomationGrant} from './network.ts';
import picomatch from 'picomatch';

// Adapted from Obsidian Git 2.43.0, src/autoCommitGlobs.ts (MIT).
export function selectPaths(mode:'include'|'exclude',setting:string,files:string[]){
	const globs=setting.split('\n').map(s=>s.trim()).filter(Boolean);
	const patterns=globs.map(glob=>{
		const pattern=glob.replace(/\/+$/u,'').replace(/\\.|[()]/gu,s=>s.length===1?'\\'+s:s);
		return {match:picomatch(pattern,{dot:true,nobrace:true,noext:true,nonegate:true,posix:true}),
			directoryOnly:glob.endsWith('/'),literal:!/[?*[]/u.test(glob)};
	});
	return files.filter(file=>{
		const parts=file.split('/');
		const matched=patterns.some(p=>(!p.directoryOnly && p.match(file)) ||
			(p.literal && parts.some((_,i)=>i>0 && p.match(parts.slice(0,i).join('/')))));
		return mode==='include'?matched:!matched;
	});
}

export function readGrants(input:unknown):Record<string,AutomationGrant>{
	const result:Record<string,AutomationGrant>={};
	if(!input || typeof input!=='object' || Array.isArray(input))return result;
	for(const [id,value] of Object.entries(input as Record<string,unknown>)){
		if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(id) || !value || typeof value!=='object')continue;
		const g=value as Record<string,unknown>;
		const {location,branch,remote,url,remoteBranch,backend,commit,pull,push,paused}=g;
		if(typeof location!=='string' || !location || typeof branch!=='string' || !branch ||
			typeof remote!=='string' || typeof url!=='string' || typeof remoteBranch!=='string' ||
			(backend!=='builtin' && backend!=='native') || typeof commit!=='number' || typeof pull!=='number' ||
			typeof push!=='number' || ![commit,pull,push].every(v=>Number.isSafeInteger(v)&&v>=0) ||
			(paused!==undefined && typeof paused!=='string'))continue;
		const {autoGlobs,autoGlobMode,autoAfterEdits,autoFromLastCommit,autoPullOnStart}=g;
		if(typeof autoGlobs!=='string' || (autoGlobMode!=='include' && autoGlobMode!=='exclude') ||
			typeof autoAfterEdits!=='boolean' || typeof autoFromLastCommit!=='boolean' || typeof autoPullOnStart!=='boolean')continue;
		result[id]={location,branch,remote,url,remoteBranch,backend,commit,pull,push,autoGlobs,autoGlobMode,autoAfterEdits,autoFromLastCommit,autoPullOnStart};
		if(paused)result[id].paused=paused;
	}
	return result;
}

export const operations=['commit','pull','push'] as const;
type Operation=(typeof operations)[number];
export class AutomationClock {
	private last=new WeakMap<AutomationGrant,Record<Operation,number>>();
	private edits=new WeakMap<AutomationGrant,number>();
	edited(grant:AutomationGrant,now:number){this.edits.set(grant,now);}
	due(grant:AutomationGrant,now:number,latestCommit?:number,startup=false):Operation[]{
		let last=this.last.get(grant);
		if(!last){last={commit:grant.autoFromLastCommit ? Math.min(latestCommit??now,now):now,pull:now,push:now};this.last.set(grant,last);}
		if(grant.paused)return [];
		return operations.filter(op=>{
			if(op==='pull' && startup && grant.autoPullOnStart)return true;
			if(!grant[op])return false;
			let base=last[op];
			if(op==='commit'){
				if(grant.autoFromLastCommit && latestCommit!==undefined)base=Math.max(base,Math.min(now,latestCommit));
				if(grant.autoAfterEdits){
					const edited=this.edits.get(grant);
					if(edited===undefined)return false;
					base=grant.autoFromLastCommit?Math.max(edited,base):edited;
				}
			}
			return now-base>=grant[op]*60000;
		});
	}
	completed(grant:AutomationGrant,op:Operation,now:number){
		const last=this.last.get(grant);
		if(last)last[op]=now;
		if(op==='commit')this.edits.delete(grant);
	}
}
