import type {Diagnostic, DiagnosticCheckResult, DiagnosticReport} from './types.ts';

interface ComparedFinding {checkId:string; diagnostic:Diagnostic}

function fullyChecked(check: DiagnosticCheckResult | undefined): check is DiagnosticCheckResult {
	return !!check && check.coverage.unknown === 0 && ['passed','findings','skipped'].includes(check.status);
}

function problemKey(item: Diagnostic) {
	return JSON.stringify([item.code,item.file,item.evidence]);
}

export function compareDiagnosticReports(previous: DiagnosticReport, current: DiagnosticReport) {
	const introduced: ComparedFinding[] = [];
	const resolved: ComparedFinding[] = [];
	const remaining: ComparedFinding[] = [];
	const unavailableChecks: string[] = [];
	const changedRules: string[] = [];
	const before = new Map(previous.checks.map(check => [check.id,check]));
	const after = new Map(current.checks.map(check => [check.id,check]));
	const sameEnvironment = previous.environment === current.environment;
	const sameLibrary = !previous.library.id || !current.library.id || previous.library.id === current.library.id;
	for (const checkId of new Set([...after.keys(),...before.keys()])) {
		const oldCheck = before.get(checkId), newCheck = after.get(checkId);
		if (oldCheck?.rule && newCheck?.rule && JSON.stringify(oldCheck.rule) !== JSON.stringify(newCheck.rule)) changedRules.push(checkId);
		if (!sameEnvironment || !sameLibrary || !fullyChecked(oldCheck) || !fullyChecked(newCheck)) {
			unavailableChecks.push(checkId);
			continue;
		}
		const priorFindings = new Map<string,Diagnostic[]>();
		for (const diagnostic of oldCheck.diagnostics) {
			if (diagnostic.severity === 'info') continue;
			const key = problemKey(diagnostic);
			const occurrences = priorFindings.get(key) ?? [];
			occurrences.push(diagnostic);
			priorFindings.set(key,occurrences);
		}
		for (const diagnostic of newCheck.diagnostics) {
			if (diagnostic.severity === 'info') continue;
			const matches = priorFindings.get(problemKey(diagnostic));
			(matches?.pop() ? remaining : introduced).push({checkId,diagnostic});
		}
		for (const occurrences of priorFindings.values())
			for (const diagnostic of occurrences) resolved.push({checkId,diagnostic});
	}
	return {introduced,resolved,remaining,unavailableChecks,changedRules};
}
