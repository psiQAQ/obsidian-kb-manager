import type { Repair } from './maintenance.ts';

export const auditChecks = ['identity','properties','links','index','ingestion','bindings'] as const;
export type AuditCheck = typeof auditChecks[number];

export interface AuditResult {
	check: AuditCheck;
	status: 'clean' | 'findings' | 'not-applicable' | 'failed';
	findings: AuditFinding[];
	repairs: Repair[];
	reason?: string;
	details?: string[];
}

export interface AuditNote {
	metadata: Record<string, unknown>;
	body: string;
}

export interface AuditFinding {
	level: 'error' | 'review';
	code: string;
	file: string;
	message: string;
}

export type AuditReport = (level: AuditFinding['level'], code: string, file: string, message: string) => void;

export function within(file: string, directory: string) {
	return file === directory || file.startsWith(directory + '/');
}
