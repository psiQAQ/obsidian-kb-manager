import {commonRuleSources} from './common-rules.ts';

declare const KB_OFFLINE_RUNNER:string;
export const checkKitVersion='3.3.0';
export function offlineRunner(){return KB_OFFLINE_RUNNER;}
export function checkKitFiles():Record<string,string>{
	return {'checks/kb-check.cjs':offlineRunner(),...commonRuleSources()};
}
