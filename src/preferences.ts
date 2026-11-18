export type Language = 'system' | 'zh' | 'en';

export interface GitPreferences {
	author: string;
	email: string;
	tree: boolean;
	lineAuthor: boolean;
	blameHash: boolean;
	blameIgnoreWhitespace: boolean;
	blameFollow: 'inactive'|'same-commit'|'all-commits';
	blameAuthor: 'hidden'|'initials'|'first'|'last'|'full';
	blameDate: 'hidden'|'date'|'datetime'|'relative'|'custom';
	blameFormat: string;
	blameTimezone: 'viewer'|'author'|'utc';
	blameMaxDays: number;
	blameOld: string;
	blameNew: string;
	blameText: string;
	hunkCommands: boolean;
	hunkSigns: boolean;
	hunkStatusBar: boolean;
	showFileMenu: boolean;
	showStatusBar: boolean;
	showBranchStatusBar: boolean;
	changedFilesInStatusBar: boolean;
	diffStyle: 'split' | 'unified';
	diffTimeout: number;
	commitMessage: string;
	autoCommitMessage: string;
	commitDateFormat: string;
	commitHostname: string;
	historyAuthor: boolean;
	historyDate: boolean;
	refreshSourceControl: boolean;
	refreshSourceControlTimer: number;
	backend: 'builtin' | 'native';
	syncMethod: 'ff-only' | 'merge' | 'rebase';
	pullBeforePush: boolean;
	disablePush: boolean;
	autoCommitMinutes: number;
	autoPullMinutes: number;
	autoPushMinutes: number;
	autoGlobMode: 'include'|'exclude';
	autoGlobs: string;
	autoAfterEdits: boolean;
	autoFromLastCommit: boolean;
	autoPullOnStart: boolean;
}

export interface PreferenceStore {
	language: Language;
	defaults: Partial<GitPreferences>;
	libraries: Record<string, Partial<GitPreferences>>;
}

export const gitDefaults: GitPreferences = {
	author: '', email: '', tree: false, lineAuthor: false, hunkCommands: false, showFileMenu: true, diffStyle: 'split', commitMessage: '',
	commitDateFormat: 'YYYY-MM-DD HH:mm:ss', commitHostname: '', historyAuthor: true, historyDate: true,
	autoCommitMessage: 'Knowledge base backup · {{date}}',
	hunkSigns: false, hunkStatusBar: false,
	blameHash: false, blameIgnoreWhitespace: false, blameFollow: 'inactive', blameAuthor: 'initials',
	blameDate: 'date', blameFormat: 'YYYY-MM-DD HH:mm', blameTimezone: 'viewer', blameMaxDays: 365,
	blameOld: '#42dcff', blameNew: '#ff9696', blameText: 'var(--text-muted)',
	showStatusBar: true, showBranchStatusBar: true, changedFilesInStatusBar: false,
	diffTimeout: 50,
	pullBeforePush: true, disablePush: false,
	refreshSourceControl: true, refreshSourceControlTimer: 7000,
	backend: 'builtin', syncMethod: 'ff-only',
	autoCommitMinutes: 0, autoPullMinutes: 0, autoPushMinutes: 0,
	autoGlobMode:'exclude', autoGlobs:'', autoAfterEdits:false, autoFromLastCommit:false, autoPullOnStart:false,
};

function record(value: unknown): Record<string,unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

function readGit(value: unknown): Partial<GitPreferences> {
	const raw = record(value);
	const result: Partial<GitPreferences> = {};
	for (const key of ['author','email','commitMessage','autoCommitMessage','commitDateFormat','commitHostname','blameFormat','autoGlobs'] as const) {
		if (typeof raw[key] === 'string') result[key] = raw[key];
	}
	for (const key of ['tree','lineAuthor','hunkCommands','hunkSigns','hunkStatusBar','showFileMenu','showStatusBar','showBranchStatusBar','changedFilesInStatusBar',
		'historyAuthor','historyDate','refreshSourceControl','pullBeforePush','disablePush','blameHash','blameIgnoreWhitespace','autoAfterEdits','autoFromLastCommit','autoPullOnStart'] as const) {
		if (typeof raw[key] === 'boolean') result[key] = raw[key];
	}
	if (raw.diffStyle === 'split' || raw.diffStyle === 'unified') result.diffStyle = raw.diffStyle;
	if (typeof raw.diffTimeout === 'number' && Number.isInteger(raw.diffTimeout) && raw.diffTimeout >= 1 && raw.diffTimeout <= 10000)
		result.diffTimeout = raw.diffTimeout;
	if (raw.backend === 'builtin' || raw.backend === 'native') result.backend = raw.backend;
	if (raw.autoGlobMode === 'include' || raw.autoGlobMode === 'exclude') result.autoGlobMode = raw.autoGlobMode;
	for (const key of ['blameOld','blameNew','blameText'] as const) {
		const color = raw[key];
		if (typeof color === 'string' && (/^#[0-9a-f]{6}$/iu.test(color) || (key === 'blameText' && color === gitDefaults.blameText))) result[key] = color;
	}
	if (typeof raw.blameMaxDays === 'number' && Number.isSafeInteger(raw.blameMaxDays) && raw.blameMaxDays > 0)
		result.blameMaxDays = raw.blameMaxDays;
	if (raw.blameFollow === 'inactive' || raw.blameFollow === 'same-commit' || raw.blameFollow === 'all-commits') result.blameFollow = raw.blameFollow;
	if (raw.blameAuthor === 'hidden' || raw.blameAuthor === 'initials' || raw.blameAuthor === 'first' || raw.blameAuthor === 'last' || raw.blameAuthor === 'full') result.blameAuthor = raw.blameAuthor;
	if (raw.blameDate === 'hidden' || raw.blameDate === 'date' || raw.blameDate === 'datetime' || raw.blameDate === 'relative' || raw.blameDate === 'custom') result.blameDate = raw.blameDate;
	if (raw.blameTimezone === 'viewer' || raw.blameTimezone === 'author' || raw.blameTimezone === 'utc') result.blameTimezone = raw.blameTimezone;
	if (raw.syncMethod === 'ff-only' || raw.syncMethod === 'merge' || raw.syncMethod === 'rebase') result.syncMethod = raw.syncMethod;
	if (typeof raw.refreshSourceControlTimer === 'number' && Number.isInteger(raw.refreshSourceControlTimer) &&
		raw.refreshSourceControlTimer >= 500 && raw.refreshSourceControlTimer <= 2147483647)
		result.refreshSourceControlTimer = raw.refreshSourceControlTimer;
	for (const key of ['autoCommitMinutes','autoPullMinutes','autoPushMinutes'] as const) {
		const interval = raw[key];
		if (typeof interval === 'number' && Number.isSafeInteger(interval) && interval >= 0) result[key] = interval;
	}
	return result;
}

export function readPreferences(value: unknown): PreferenceStore {
	const raw = record(value);
	const libraries: PreferenceStore['libraries'] = {};
	for (const [id, fields] of Object.entries(record(raw.libraries))) {
		if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) libraries[id] = readGit(fields);
	}
	return {
		language: raw.language === 'zh' || raw.language === 'en' ? raw.language : 'system',
		defaults: readGit(raw.defaults), libraries,
	};
}

export function effectivePreferences(store: PreferenceStore, legacy: Pick<GitPreferences,'author'|'email'>, id?: string): GitPreferences {
	return {...gitDefaults, author: legacy.author, email: legacy.email, ...store.defaults, ...(id && store.libraries[id])};
}

export function renderCommitMessage(prefs: Pick<GitPreferences,'commitMessage'|'commitHostname'>, date: string, hostname: string, files: readonly string[]) {
	const values = {date, hostname: prefs.commitHostname || hostname, numFiles: String(files.length), files: files.join(', ')};
	return prefs.commitMessage.replace(/\{\{(date|hostname|numFiles|files)\}\}/gu,
		(_, key: keyof typeof values) => values[key]);
}
