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
