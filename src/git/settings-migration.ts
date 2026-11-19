import { clearLegacyAuthors } from '../preferences.ts';
import { readGrants } from './network-automation.ts';

function fields(value:unknown):Record<string,unknown> {
	return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

/** Rewrite only the settings retired by the platform Git migration. */
export function migrateGitSettings(saved:unknown):boolean {
	const data=fields(saved), prefs=fields(data.prefs);
	let changed=clearLegacyAuthors(saved);
	for(const entry of [prefs.defaults,...Object.values(fields(prefs.libraries))]){
		const overrides=fields(entry);
		if(Object.prototype.hasOwnProperty.call(overrides,'backend')){delete overrides.backend;changed=true;}
	}
	if(Object.prototype.hasOwnProperty.call(data,'grants')){
		const clean=readGrants(data.grants);
		if(JSON.stringify(clean)!==JSON.stringify(data.grants)){data.grants=clean;changed=true;}
	}
	return changed;
}
