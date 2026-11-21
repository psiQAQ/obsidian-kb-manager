import {segments} from '../fs/segments.ts';
import {tr} from '../i18n.ts';

export const legacyTemplateRule='/(^|[/])Templates[/]/';

export function exclusionFolders(value:unknown,field:string):string[] {
	const invalid=()=>new Error(tr('排除目录字段无效：','Invalid excluded folders: ')+field);
	if(!Array.isArray(value))throw invalid();
	const seen=new Set<string>();
	for(const folder of value as unknown[]){
		if(typeof folder!=='string')throw invalid();
		segments(folder);
		const key=folder.normalize('NFC').toLowerCase();
		if(seen.has(key))throw invalid();
		seen.add(key);
	}
	return value as string[];
}

export function confirmExcludedFolders(suggested:readonly string[]|undefined,selected:readonly string[]){
	const folders=exclusionFolders(selected,'manager.excludedFolders');
	if(folders.some(folder=>!suggested?.includes(folder)))throw new Error(tr('排除目录已变化，请重新预览。','The excluded folders changed. Open a new preview.'));
	return suggested===undefined && !folders.length?undefined:[...folders];
}

export function templateFolderRule(root:string,folder:string) {
	const parts=[...segments(root),...segments(folder)];
	const pattern=parts.map(part=>part.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('[/]');
	return '/^'+pattern+'(?:[/]|$)/';
}

interface Owner {root:string; rules:string[]}
interface ObservedRule {rule:string; count:number}
export interface ExclusionPlan {
	id:string;
	source?:string;
	destination:string;
	folders:string[];
	before:Owner|null;
	after:Owner|null;
	observed:ObservedRule[];
	add:string[];
	remove:string[];
	warnings:string[];
}
export interface ExclusionState {owner:Owner|null; pending?:ExclusionPlan}
export interface ExclusionStore {
	readRules():Promise<string[]>;
	writeRules(before:string[],after:string[]):Promise<void>;
	readOwnership(id:string):Promise<ExclusionState|null>;
	writeOwnership(id:string,before:ExclusionState|null,after:ExclusionState|null):Promise<void>;
}

const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const countRule=(rules:string[],rule:string)=>rules.filter(value=>value===rule).length;
const changed=()=>new Error(tr('Vault 排除规则或其归属已变化，请复核设置。','Vault exclusions or their ownership changed. Review the vault settings.'));
const legacyWarning=(rules:string[])=>rules.includes(legacyTemplateRule)?[tr(
	'Vault 仍保留旧版全局 Templates 排除规则。它会继续影响整个 Vault，可在 Obsidian 设置中手动调整。',
	'The legacy global Templates exclusion still affects the entire vault. You can adjust it manually in Obsidian Settings.')]:[];
const observe=(rules:string[],scope:string[])=>[...new Set(scope)].map(rule=>({rule,count:countRule(rules,rule)}));

export function planNewExclusions(rules:string[],destination:string,folders:readonly string[]):ExclusionPlan {
	const candidates=folders.map(folder=>templateFolderRule(destination,folder));
	const add=candidates.filter(rule=>!rules.includes(rule));
	return {id:'',destination,folders:[...folders],before:null,after:add.length?{root:destination,rules:add}:null,
		observed:observe(rules,candidates),add,remove:[],warnings:legacyWarning(rules)};
}

export async function planMovedExclusions(store:ExclusionStore,id:string,source:string,destination:string,folders:readonly string[]):Promise<ExclusionPlan> {
	const [rules,state]=await Promise.all([store.readRules(),store.readOwnership(id)]);
	if(state?.pending)throw changed();
	const before=state?.owner??null;
	const warnings=legacyWarning(rules);
	const scope:string[]=[],add:string[]=[],remove:string[]=[];
	const warn=(folder:string)=>warnings.push(folder+' · '+tr('请在 Vault 设置中核对手动、重复或已更改的规则。','Review manual, duplicate or edited rules in the vault settings.'));
	for(const folder of folders){
		const current=templateFolderRule(source,folder),next=templateFolderRule(destination,folder);
		scope.push(current,next);
		if(before?.root!==source || !before.rules.includes(current) || countRule(rules,current)!==1){
			warn(folder);continue;
		}
		remove.push(current);
		if(!rules.includes(next))add.push(next);
	}
	if(before?.root===source && before.rules.some(rule=>!scope.includes(rule)))
		warnings.push(tr('库清单中的排除目录已变化，请核对旧路径的规则。','The manifest exclusions changed. Review the rules at the old path.'));
	const after=before?.root!==source?before:add.length?{root:destination,rules:add}:null;
	return {id,source,destination,folders:[...folders],before,after,observed:observe(rules,scope),add,remove,warnings};
}

export function assertMoveExclusionScope(plan:ExclusionPlan,id:string,source:string,destination:string,folders:readonly string[]) {
	const old=folders.map(folder=>templateFolderRule(source,folder));
	const next=folders.map(folder=>templateFolderRule(destination,folder));
	const counts=new Map(plan.observed.map(({rule,count})=>[rule,count]));
	if(plan.id!==id || plan.source!==source || plan.destination!==destination || !equal(plan.folders,folders) ||
		counts.size!==plan.observed.length || counts.size!==new Set([...old,...next]).size ||
		[...counts.values()].some(count=>!Number.isSafeInteger(count) || count<0) ||
		[...old,...next].some(rule=>!counts.has(rule)))throw changed();
	const owned=plan.before?.root===source?plan.before.rules:[];
	const remove=old.filter(rule=>owned.includes(rule) && counts.get(rule)===1);
	const add=next.filter((rule,i)=>remove.includes(old[i]!) && counts.get(rule)===0);
	const after=plan.before?.root!==source?plan.before:add.length?{root:destination,rules:add}:null;
	if(!equal(plan.add,add) || !equal(plan.remove,remove) || !equal(plan.after,after))throw changed();
}

function settingsMatch(rules:string[],plan:ExclusionPlan,applied=false){
	return plan.observed.every(({rule,count})=>countRule(rules,rule)===count+
		(applied?Number(plan.add.includes(rule))-Number(plan.remove.includes(rule)):0));
}

function outcome(state:ExclusionState|null,rules:string[],plan:ExclusionPlan,allowApplied:boolean){
	const owner=state?.owner??null;
	if(state?.pending && (!allowApplied || !equal(plan,state.pending)))throw changed();
	const before=equal(owner,plan.before),after=equal(owner,plan.after);
	const isBefore=settingsMatch(rules,plan);
	if(allowApplied && settingsMatch(rules,plan,true)){
		if(state?.pending && before)return 'written';
		if(!state?.pending && after && (!before || isBefore))return 'complete';
	}
	if(before && isBefore)return 'ready';
	throw changed();
}

export async function assertExclusionPlan(store:ExclusionStore,plan:ExclusionPlan,allowApplied=false) {
	outcome(await store.readOwnership(plan.id),await store.readRules(),plan,allowApplied);
}

export async function applyExclusionPlan(store:ExclusionStore,plan:ExclusionPlan) {
	let state=await store.readOwnership(plan.id);
	let rules=await store.readRules();
	const status=outcome(state,rules,plan,true);
	if(status==='complete')return;
	if(status==='ready' && (plan.add.length || plan.remove.length)){
		if(!state?.pending){
			// Settings and plugin data save separately. Journal the approved edit before touching settings.
			const pending={owner:plan.before,pending:plan};
			await store.writeOwnership(plan.id,state,pending);
			state=pending;
		}
		rules=await store.readRules();
		if(!settingsMatch(rules,plan))throw changed();
		const updated=[...rules.filter(rule=>!plan.remove.includes(rule)),...plan.add];
		await store.writeRules(rules,updated);
		if(!settingsMatch(await store.readRules(),plan,true))throw changed();
	}
	await store.writeOwnership(plan.id,state,plan.after?{owner:plan.after}:null);
}
