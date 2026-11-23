import type {Diagnostic, DiagnosticCheckResult} from '../diagnostics/types.ts';

interface OverviewFinding {item:Diagnostic; checks:string[]}

/** Group only positioned coverage notices. Keep the underlying per-check reports intact. */
export function overviewFindings(checks:readonly DiagnosticCheckResult[]) {
	const findings:OverviewFinding[]=[];
	const blocks=new Map<string,OverviewFinding>();
	for(const check of checks) for(const item of check.diagnostics){
		if(item.code==='dynamic-block-skipped' && item.severity==='info' && item.file && item.line){
			const key=JSON.stringify([item.file,item.line,item.column,item.field,item.evidence,item.message]);
			const previous=blocks.get(key);
			if(previous){
				if(!previous.checks.includes(check.id))previous.checks.push(check.id);
				continue;
			}
			const group={item,checks:[check.id]};
			blocks.set(key,group);
			findings.push(group);
		} else findings.push({item,checks:[check.id]});
	}
	return findings;
}
