export type Language = 'system' | 'zh' | 'en';

export interface GitPreferences {
	tree: boolean;
	lineAuthor: boolean;
	conflictResolutionMode: 'source'|'live-preview'|'both'|'disabled';
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
	hunkStatusBar: 'disabled' | 'plain' | 'colored';
	showFileMenu: boolean;
	showStatusBar: boolean;
	showBranchStatusBar: boolean;
	changedFilesInStatusBar: boolean;
	diffStyle: 'split' | 'unified';
	diffTimeout: number;
	commitMessage: string;
	autoCommitMessage: string;
	autoStageOnEmptyIndex: boolean;
	listChangedFilesInMessageBody: boolean;
	commitDateFormat: string;
	commitHostname: string;
	historyAuthor: 'hidden' | 'initials' | 'full';
	historyDate: boolean;
	refreshSourceControl: boolean;
	refreshSourceControlTimer: number;
	backend: 'builtin' | 'native';
	syncMethod: 'ff-only' | 'merge' | 'rebase';
	mergeStrategy: 'none'|'ours'|'theirs';
	pullBeforePush: boolean;
	disablePush: boolean;
	squashCommitsBeforePush: boolean;
	showInfoNotices: boolean;
	showErrorNotices: boolean;
	showNoChangesNotices: boolean;
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
	tree: false, lineAuthor: false, hunkCommands: false, showFileMenu: true, diffStyle: 'split', commitMessage: '',
	commitDateFormat: 'YYYY-MM-DD HH:mm:ss', commitHostname: '', historyAuthor: 'full', historyDate: true,
	autoCommitMessage: 'Knowledge base backup · {{date}}',
	autoStageOnEmptyIndex:true, listChangedFilesInMessageBody:false,
	hunkSigns: false, hunkStatusBar: 'disabled',
	conflictResolutionMode:'both',
	blameHash: false, blameIgnoreWhitespace: false, blameFollow: 'inactive', blameAuthor: 'initials',
	blameDate: 'date', blameFormat: 'YYYY-MM-DD HH:mm', blameTimezone: 'viewer', blameMaxDays: 365,
	blameOld: '#42dcff', blameNew: '#ff9696', blameText: 'var(--text-muted)',
	showStatusBar: true, showBranchStatusBar: true, changedFilesInStatusBar: false,
	diffTimeout: 50,
	pullBeforePush: true, disablePush: false,
	squashCommitsBeforePush:false, showInfoNotices:true, showErrorNotices:true, showNoChangesNotices:true,
	refreshSourceControl: true, refreshSourceControlTimer: 7000,
	backend: 'builtin', syncMethod: 'ff-only',
	mergeStrategy:'none',
	autoCommitMinutes: 0, autoPullMinutes: 0, autoPushMinutes: 0,
	autoGlobMode:'exclude', autoGlobs:'', autoAfterEdits:false, autoFromLastCommit:false, autoPullOnStart:false,
};

function record(value: unknown): Record<string,unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

function readGit(value: unknown): Partial<GitPreferences> {
	const raw = record(value);
	const result: Partial<GitPreferences> = {};
	for (const key of ['commitMessage','autoCommitMessage','commitDateFormat','commitHostname','blameFormat','autoGlobs'] as const) {
		if (typeof raw[key] === 'string') result[key] = raw[key];
	}
	for (const key of ['tree','lineAuthor','hunkCommands','hunkSigns','showFileMenu','showStatusBar','showBranchStatusBar','changedFilesInStatusBar',
		'historyDate','refreshSourceControl','pullBeforePush','disablePush','squashCommitsBeforePush','showInfoNotices','showErrorNotices','showNoChangesNotices',
		'blameHash','blameIgnoreWhitespace','autoAfterEdits','autoFromLastCommit','autoPullOnStart','autoStageOnEmptyIndex','listChangedFilesInMessageBody'] as const) {
		if (typeof raw[key] === 'boolean') result[key] = raw[key];
	}
	if (typeof raw.historyAuthor === 'boolean') result.historyAuthor = raw.historyAuthor ? 'full' : 'hidden';
	else if (raw.historyAuthor === 'hidden' || raw.historyAuthor === 'initials' || raw.historyAuthor === 'full') result.historyAuthor = raw.historyAuthor;
	if (typeof raw.hunkStatusBar === 'boolean') result.hunkStatusBar = raw.hunkStatusBar ? 'plain' : 'disabled';
	else if (raw.hunkStatusBar === 'disabled' || raw.hunkStatusBar === 'plain' || raw.hunkStatusBar === 'colored') result.hunkStatusBar = raw.hunkStatusBar;
	if (raw.diffStyle === 'split' || raw.diffStyle === 'unified') result.diffStyle = raw.diffStyle;
	if (typeof raw.diffTimeout === 'number' && Number.isInteger(raw.diffTimeout) && raw.diffTimeout >= 1 && raw.diffTimeout <= 10000)
		result.diffTimeout = raw.diffTimeout;
	if (raw.backend === 'builtin' || raw.backend === 'native') result.backend = raw.backend;
	if (raw.autoGlobMode === 'include' || raw.autoGlobMode === 'exclude') result.autoGlobMode = raw.autoGlobMode;
	if (raw.conflictResolutionMode === 'source' || raw.conflictResolutionMode === 'live-preview' || raw.conflictResolutionMode === 'both' || raw.conflictResolutionMode === 'disabled') result.conflictResolutionMode = raw.conflictResolutionMode;
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
	if (raw.mergeStrategy === 'none' || raw.mergeStrategy === 'ours' || raw.mergeStrategy === 'theirs') result.mergeStrategy = raw.mergeStrategy;
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

/** Remove only formerly persisted Git identities; leave all other saved state intact. */
export function clearLegacyAuthors(saved: unknown): boolean {
	const data=record(saved), prefs=record(data.prefs);
	let changed=false;
	for(const fields of [data,record(prefs.defaults),...Object.values(record(prefs.libraries)).map(record)]){
		for(const key of ['author','email']){
			if(Object.prototype.hasOwnProperty.call(fields,key)){delete fields[key];changed=true;}
		}
	}
	return changed;
}

export function effectivePreferences(store: PreferenceStore, id?: string): GitPreferences {
	return {...gitDefaults, ...store.defaults, ...(id && store.libraries[id])};
}

export function renderCommitMessage(prefs: Pick<GitPreferences,'commitMessage'|'commitHostname'>, date: string, hostname: string, files: readonly string[]) {
	const values = {date, hostname: prefs.commitHostname || hostname, numFiles: String(files.length), files: files.join(', ')};
	return prefs.commitMessage.replace(/\{\{(date|hostname|numFiles|files)\}\}/gu,
		(_, key: keyof typeof values) => values[key]);
}
