import {commonRuleSources, diagnosticEngineVersion} from './common-rules.ts';

declare const KB_OFFLINE_RUNNER:string;
export const checkKitVersion=diagnosticEngineVersion;
export function offlineRunner(){return KB_OFFLINE_RUNNER;}
export function checkKitFiles():Record<string,string>{
	return {'checks/kb-check.cjs':offlineRunner(),...commonRuleSources()};
}
