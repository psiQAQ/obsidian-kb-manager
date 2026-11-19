import {readGrants} from '../git/network-automation.ts';
import {readPendingLibraryPreferences,readPreferences} from '../preferences.ts';
import type {GitPreferences,Language} from '../preferences.ts';
import type {BindingPreview} from './bindings.ts';

export type Saved={language:Language;defaults:Partial<GitPreferences>};
export type Device=Record<string,unknown>&{parents:string[];templates:string[];bindingRepairs?:Record<string,BindingPreview>;pendingLibraryPreferences:Record<string,Partial<GitPreferences>>};

function fields(value:unknown){
	return value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};
}
function paths(value:unknown){
	return Array.isArray(value) && value.every((item:unknown)=>typeof item==='string')?value:undefined;
}

export function readMobileStorage(shared:unknown,local:unknown){
	const old=fields(shared),current=fields(local),prefs=readPreferences(old.prefs??old);
	const saved:Saved={language:prefs.language,defaults:prefs.defaults};
	const grants=readGrants(current.grants??old.grants);
	if(current.grants===undefined)for(const grant of Object.values(grants))grant.paused='review';
	const device:Device={
		...current,
		parents:paths(current.parents)??paths(old.parents)??['knowledge-base'],
		templates:paths(current.templates)??paths(old.templates)??[],
		grants,
		pendingLibraryPreferences:readPendingLibraryPreferences(current.pendingLibraryPreferences,old),
		moves:Object.fromEntries(Object.entries(fields(current.moves??old.moves)).filter(([,record])=>fields(record).phase!=='complete')),
		saves:Object.fromEntries(Object.entries(fields(current.saves??old.saves)).filter(([,record])=>!fields(record).committed || fields(record).problem)),
	};
	return {saved,device};
}
