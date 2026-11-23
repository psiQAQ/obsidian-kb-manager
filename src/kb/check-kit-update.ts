import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, mkdir, open, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {digest, statIfPresent} from '../fs/vault.ts';
import type {VaultDisk} from '../fs/vault.ts';
import {tr} from '../i18n.ts';
import {checkKitFiles, checkKitVersion} from './check-kit.ts';
import {courseworkDeclaration, courseworkLinkDeclaration, courseworkScript, courseworkTemplate, previousCourseworkDigests} from './coursework-check.ts';
import {identityFile, readManifest, writeCheckKit} from './identity-core.ts';
import {readManifestFile, replaceLibraryManifest} from './manifest-disk.ts';
import {previousTemplateCheckDigests} from './template-check-digests.ts';
import {isKepano, kepanoBindingAssets} from './template-core.ts';
import {declaration} from './template-declaration.ts';
import type {Declaration, DiagnosticExclusion} from './template-declaration.ts';
import {builtinPacks, officialCheckDigests, packText} from './template-pack.ts';
import type {PackDescriptor} from './template-pack.ts';

const byteLimit = 1024 * 1024;
const templateDeclarationFile = 'kb-template.json';

interface PresentFile {path: string; digest: string; bytes: Buffer; mode: number}
interface MissingFile {path: string; digest?: undefined}
async function readKitFile(disk: VaultDisk, location: string, name: string): Promise<PresentFile | MissingFile> {
	const relative = location + '/' + name;
	const path = await disk.path(relative);
	const initial = await statIfPresent(path);
	if (!initial) return {path};
	if (!initial.isFile() || initial.nlink !== 1 || initial.size > byteLimit)
		throw new Error(tr('需要独立的常规文件（最多 1 MiB）。','Expected a regular file with a single link (up to 1 MiB).'));
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await file.stat();
		if (!current.isFile() || current.nlink !== 1 || current.dev !== initial.dev || current.ino !== initial.ino)
			throw changed(name);
		const buffer = Buffer.alloc(initial.size + 1);
		let size = 0;
		while (size < buffer.length) {
			const {bytesRead} = await file.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		const final = await file.stat();
		if (size !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs ||
			final.ctimeMs !== initial.ctimeMs || final.nlink !== 1 || await disk.path(relative) !== path)
			throw changed(name);
		const entry = await statIfPresent(path);
		if (entry?.dev !== current.dev || entry.ino !== current.ino || entry.nlink !== 1 ||
			entry.mtimeMs !== final.mtimeMs || entry.ctimeMs !== final.ctimeMs) throw changed(name);
		const bytes = buffer.subarray(0, size);
		return {path,digest:digest(bytes),bytes,mode:current.mode};
	} finally { await file.close(); }
}

type Change = 'current' | 'add' | 'replace' | 'modified' | 'missing' | 'unavailable' | 'blocked';
interface KitFile {
	path: string;
	change: Change;
	before?: string;
	after?: string;
	installedDigest?: string;
	targetDigest?: string;
	reason?: string;
	exclusionDiff?: {local: string; bundled: string};
}
type EligibleFile = KitFile & {change: 'current' | 'add' | 'replace'; after: string; targetDigest: string};

function eligible(file: KitFile): file is EligibleFile {
	return (file.change === 'current' || file.change === 'add' || file.change === 'replace') && file.after !== undefined && !!file.targetDigest;
}

export interface CheckKitUpdate {
	location: string;
	manifestDigest: string;
	installedVersion: string;
	targetVersion: string;
	canApply: boolean;
	downgrade: boolean;
	files: KitFile[];
	courseworkFiles: KitFile[];
	templateFiles: KitFile[];
	templateDeclarationDigest?: string;
	mediaViews: KitFile[];
}

function changed(name: string) {
	return new Error(tr('检验工具文件已变化，请重新预览。','A check tool file changed. Preview again.') + ' · ' + name);
}

function versionIsNewer(installed: string, bundled: string) {
	if (![installed,bundled].every(version => /^\d+\.\d+\.\d+$/u.test(version))) return false;
	const target = bundled.split('.').map(BigInt);
	for (const [index, value] of installed.split('.').map(BigInt).entries()) {
		const expected = target[index]!;
		if (value !== expected) return value > expected;
	}
	return false;
}

async function inspectKitFile(disk: VaultDisk, location: string, path: string): Promise<KitFile> {
	try {
		const file = await readKitFile(disk, location, path);
		if (file.digest === undefined) return {path,change:'missing'};
		let before: string | undefined;
		if (!file.bytes.includes(0)) {
			try { before = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(file.bytes); }
			catch { /* Keep binary copies available for manual merge. */ }
		}
		return {path,change:'modified',before,installedDigest:file.digest};
	} catch (error) {
		return {path,change:'unavailable',reason:String(error)};
	}
}

function candidate(file: KitFile, after: string, change: Change): KitFile {
	const targetDigest = digest(after);
	if (file.installedDigest === targetDigest) return {...file,change:'current',before:undefined,after,targetDigest};
	return {...file,change,after,targetDigest};
}

function withDiagnosticExclusions(raw: string, rules: DiagnosticExclusion[]) {
	const [,newline,spaces] = /^\s*\{(\r?\n)([\t ]*)"/u.exec(raw) ?? [];
	const json = JSON.stringify(rules, null, spaces);
	const separator = newline ? newline + (spaces ?? '') : ' ';
	// Insert before the validated object's closing brace to preserve the rest of the file.
	const end = raw.trimEnd().slice(0,-1).trimEnd().length;
	return raw.slice(0,end) + ',' + separator + '"diagnosticExclusions": ' +
		json.replace(/\n/gu,separator) + raw.slice(end);
}

function previewExclusions(file: KitFile, bundled: PackDescriptor, version: string, updated = file.before): KitFile | undefined {
	const rules = bundled.diagnosticExclusions;
	if (!rules?.length) return;
	let spec: Declaration | undefined;
	try { if (file.before !== undefined) spec = declaration(file.before.replace(/^\uFEFF/u,'')); }
	catch (error) { return {...file,reason:String(error)}; }
	if (spec?.id !== bundled.id || spec.version !== version || updated === undefined)
		return {...file,reason:file.reason ?? tr('请核对本地模板声明与已登记的模板版本。','Check that the local template declaration matches the registered template version.')};
	if (spec.diagnosticExclusions === undefined) {
		const merged = withDiagnosticExclusions(updated,rules);
		declaration(merged.replace(/^\uFEFF/u,''));
		return candidate(file,merged,'replace');
	}
	const next = candidate(file,updated,'replace');
	if (isDeepStrictEqual(spec.diagnosticExclusions,rules)) return next;
	return {...next,exclusionDiff:{local:JSON.stringify(spec.diagnosticExclusions,null,2),bundled:JSON.stringify(rules,null,2)}};
}

function blockedCompanion(file: KitFile, companion: string): KitFile {
	if (file.change !== 'replace') return file;
	return {...file,change:'blocked',reason:tr('请先检查配套文件','Review the companion file first') + ' · ' + companion};
}

async function previewCourseworkFiles(disk: VaultDisk, location: string, bundled: PackDescriptor, version: string): Promise<KitFile[]> {
	const source = packText(courseworkTemplate)[courseworkScript];
	if (!source || !officialCheckDigests().includes(digest(source))) return [];
	const [script, descriptor] = await Promise.all([
		inspectKitFile(disk,location,courseworkScript),inspectKitFile(disk,location,courseworkDeclaration),
	]);
	const nextScript = candidate(script,source,script.installedDigest && previousCourseworkDigests.includes(script.installedDigest) ? 'replace' : script.change);
	let after: string | undefined;
	if (descriptor.before !== undefined) {
		try { after = courseworkLinkDeclaration(descriptor.before,version); }
		catch { /* The library's declaration needs manual review. */ }
	}
	const nextDescriptor = after === undefined ? descriptor : candidate(descriptor,after,'replace');
	const paired = eligible(nextScript) && eligible(nextDescriptor);
	const exclusions = previewExclusions(descriptor,bundled,version,paired ? after : descriptor.before);
	const courseScript = paired ? nextScript : blockedCompanion(nextScript,courseworkDeclaration);
	const courseDescriptor = paired ? nextDescriptor : blockedCompanion(nextDescriptor,courseworkScript);
	if (!exclusions) return [courseScript,courseDescriptor];
	if (!eligible(exclusions) || (exclusions.change === 'current' && exclusions.exclusionDiff))
		return [courseScript,{...courseDescriptor,reason:courseDescriptor.reason ?? exclusions.reason,exclusionDiff:exclusions.exclusionDiff}];
	return [courseScript,{...exclusions,reason:courseDescriptor.reason}];
}

async function previewTemplateFiles(disk: VaultDisk, location: string, bundled: PackDescriptor, version: string):
	Promise<Pick<CheckKitUpdate,'templateFiles'|'templateDeclarationDigest'>> {
	const template = bundled.id;
	const before = previousTemplateCheckDigests[template];
	const descriptor = await inspectKitFile(disk,location,templateDeclarationFile);
	const exclusions = previewExclusions(descriptor,bundled,version);
	let localChecks: Declaration['checks'];
	try {
		if (descriptor.before !== undefined) {
			const spec = declaration(descriptor.before.replace(/^\uFEFF/u,''));
			if (spec.id === template) localChecks = spec.checks;
		}
	}
	catch { /* An invalid local declaration needs manual review. */ }
	const sources = packText(template);
	const templateFiles: KitFile[] = [];
	for (const {id,path} of bundled.checks ?? []) {
		const previous = before?.[path], source = sources[path];
		if (!previous || !source || !officialCheckDigests().includes(digest(source)) ||
			!localChecks?.some(check => check.id === id && check.path === path)) continue;
		const file = await inspectKitFile(disk,location,path);
		templateFiles.push(candidate(file,source,file.installedDigest && previous.includes(file.installedDigest) ? 'replace' : file.change));
	}
	if (exclusions) templateFiles.push(exclusions);
	return {templateFiles,templateDeclarationDigest:templateFiles.length ? descriptor.installedDigest : undefined};
}

export async function previewCheckKitUpdate(disk: VaultDisk, location: string): Promise<CheckKitUpdate | undefined> {
	const filename = await disk.path(location + '/' + identityFile);
	if (!await statIfPresent(filename)) return;
	const manifest = await readManifestFile(filename);
	const {checkKit:kit, identity, templateFiles} = readManifest(manifest.raw);
	if (!kit) return;
	const version = identity?.template.version ?? '';
	const bundled = builtinPacks().find(pack => pack.id === identity?.template.id);
	const [files, courseworkFiles, templateUpdate] = await Promise.all([
		Promise.all(Object.entries(checkKitFiles()).map(async ([path, after]) => {
			const file = await inspectKitFile(disk, location, path);
			const recorded = kit.digests[path];
			return candidate(file,after,recorded && file.installedDigest === recorded ? 'replace' :
				file.change === 'missing' && !recorded ? 'add' : file.change);
		})),
		bundled?.id === courseworkTemplate ? previewCourseworkFiles(disk,location,bundled,version) : [],
		bundled && bundled.id !== courseworkTemplate ? previewTemplateFiles(disk,location,bundled,version) : {templateFiles:[]},
	]);
	const downgrade = versionIsNewer(kit.version,checkKitVersion);
	const mediaViews: KitFile[] = [];
	if (bundled?.id === 'kepano' && identity && isKepano(identity.template) && !identity.archived && !downgrade) {
		const sources = packText('kepano');
		const historical = kepanoBindingAssets(sources,version);
		for (const path of ['Templates/Bases/Attachments.base','Templates/Bases/Everything.base']) {
			const source = sources[path], previous = historical[path];
			if (!source || !previous || previous === source) continue;
			const file = await inspectKitFile(disk,location,path);
			const rendered = source.replaceAll('__KB_ROOT__',()=>location);
			const owned = identity.managed.some(binding=>binding.path===path) || !!templateFiles?.digests[path];
			const original = file.before === previous.replaceAll('__KB_ROOT__',()=>location);
			const view = candidate(file,rendered,original && owned ? 'blocked' : original ? 'replace' : file.change);
			if (original && owned && view.change === 'blocked') view.reason = tr(
				'此视图仍由旧清单跟踪。请同时核对文件和绑定记录，再手动合并。',
				'The older manifest still tracks this view. Review the file and its binding together before merging manually.');
			if (view.change !== 'current') mediaViews.push(view);
		}
	}
	const canApply = !downgrade && (files.some(file => file.change === 'add' || file.change === 'replace') ||
		files.some(file => file.change === 'current' && (kit.version !== checkKitVersion || kit.digests[file.path] !== file.targetDigest)) ||
		courseworkFiles.some(file => file.change === 'replace') || templateUpdate.templateFiles.some(file => file.change === 'replace'));
	return {location,manifestDigest:manifest.signature,installedVersion:kit.version,targetVersion:checkKitVersion,
		canApply,downgrade,files,courseworkFiles,mediaViews,...templateUpdate};
}

// Dashboard edits are independent of checker updates. The user chooses each view explicitly.
export async function applyMediaViewUpdate(disk: VaultDisk, location: string, approved: CheckKitUpdate, path: string, checkEditor: () => void) {
	const reviewed = approved.mediaViews.find(view=>view.path===path);
	if (approved.location !== location || !reviewed || reviewed.change !== 'replace') throw changed(path);
	const fresh = await previewCheckKitUpdate(disk,location);
	const file = fresh?.mediaViews.find(view=>view.path===path);
	if (!fresh || fresh.manifestDigest !== approved.manifestDigest || !file || !eligible(file) ||
		file.change !== 'replace' || !matchesApproval([file],[reviewed])) throw changed(path);
	await publishKitFile(disk,location,file,async()=>{
		if ((await readManifestFile(await disk.path(location+'/'+identityFile))).signature !== fresh.manifestDigest)
			throw changed(identityFile);
		checkEditor();
	});
	await assertFileDigest(disk,location,file,file.targetDigest);
}

async function publishKitFile(disk: VaultDisk, location: string,
	file: Pick<EligibleFile,'path'|'change'|'after'|'installedDigest'>, checkDeclaration?: () => Promise<void>) {
	const relative = location + '/' + file.path;
	const output = await disk.path(relative);
	if (file.change === 'add') {
		const parent = relative.slice(0, relative.lastIndexOf('/'));
		await mkdir(await disk.path(parent), {recursive:true});
	}
	const initial = await readKitFile(disk, location, file.path);
	if (initial.path !== output || initial.digest !== file.installedDigest) throw changed(file.path);
	const temporary = join(dirname(output),'.kb-check-' + randomUUID() + '.tmp');
	const handle = await open(temporary, 'wx', 'mode' in initial ? initial.mode & 0o777 : 0o666);
	try {
		try { await handle.writeFile(file.after,'utf8'); await handle.sync(); }
		finally { await handle.close(); }
		if (checkDeclaration) await checkDeclaration();
		const current = await readKitFile(disk, location, file.path);
		if (current.path !== output || current.digest !== initial.digest) throw changed(file.path);
		if (file.change === 'add') await copyFile(temporary, output, constants.COPYFILE_EXCL);
		else await rename(temporary, output);
	} finally { await rm(temporary, {force:true}); }
}

async function assertFileDigest(disk: VaultDisk, location: string, file: KitFile, expected: string | undefined) {
	if ((await readKitFile(disk,location,file.path)).digest !== expected) throw changed(file.path);
}

async function applyCourseworkFiles(disk: VaultDisk, location: string, files: KitFile[], checkManifest: () => Promise<void>) {
	const [script, descriptor] = files;
	if (!script || !descriptor || !eligible(descriptor)) return;
	if (eligible(script)) await assertFileDigest(disk,location,script,script.installedDigest);
	await assertFileDigest(disk,location,descriptor,descriptor.installedDigest);
	if (eligible(script) && script.change === 'replace') await publishKitFile(disk,location,script,async () => {
		await checkManifest();
		await assertFileDigest(disk,location,descriptor,descriptor.installedDigest);
	});
	const checkScript = async () => {
		if (eligible(script)) await assertFileDigest(disk,location,script,script.targetDigest);
	};
	try {
		await checkScript();
		if (descriptor.change === 'replace') await publishKitFile(disk,location,descriptor,async () => {
			await checkManifest();
			await checkScript();
		});
	} catch (error) {
		if (script.change === 'replace' && script.before !== undefined) {
			try {
				const installed = descriptor.change === 'replace' ? await readKitFile(disk,location,descriptor.path).catch(() => undefined) : undefined;
				const current = await readKitFile(disk,location,script.path);
				if (installed?.digest !== descriptor.targetDigest && current.digest === script.targetDigest) await publishKitFile(disk,location,{
					path:script.path,change:'replace',installedDigest:script.targetDigest,after:script.before,
				});
			} catch (rollback) {
				throw new AggregateError([error,rollback],tr('课程检查文件更新中断，请重新预览。',
					'The course check update was interrupted. Preview again.'));
			}
		}
		throw error;
	}
	await checkScript();
	await assertFileDigest(disk,location,descriptor,descriptor.targetDigest);
}

function matchesApproval(files: KitFile[], approved: KitFile[]) {
	return files.length === approved.length && files.every((file,index) => {
		const seen = approved[index];
		if (!seen || file.path !== seen.path || file.targetDigest !== seen.targetDigest ||
			!isDeepStrictEqual(file.exclusionDiff,seen.exclusionDiff)) return false;
		if (file.change === 'current' && (seen.change === 'replace' || seen.change === 'add')) return true;
		return file.change === seen.change && file.installedDigest === seen.installedDigest;
	});
}

export async function applyCheckKitUpdate(disk: VaultDisk, location: string, approved: CheckKitUpdate) {
	if (approved.location !== location || !approved.canApply) throw changed(location);
	const plan = await previewCheckKitUpdate(disk, location);
	const approvedDeclaration = approved.templateFiles.find(file => file.path === templateDeclarationFile && file.change === 'replace');
	if (!plan || plan.downgrade || plan.manifestDigest !== approved.manifestDigest || plan.targetVersion !== approved.targetVersion ||
		(plan.templateDeclarationDigest !== approved.templateDeclarationDigest &&
			(!approvedDeclaration || plan.templateDeclarationDigest !== approvedDeclaration.targetDigest)) ||
		!matchesApproval(plan.templateFiles,approved.templateFiles) ||
		!matchesApproval(plan.files,approved.files) || !matchesApproval(plan.courseworkFiles,approved.courseworkFiles)) throw changed(location);
	const readManifestNow = async () => readManifestFile(await disk.path(location + '/' + identityFile));
	const checkManifest = async () => {
		if ((await readManifestNow()).signature !== plan.manifestDigest) throw changed(identityFile);
	};
	const manifest = await readManifestNow();
	const kit = readManifest(manifest.raw).checkKit;
	if (!kit || plan.manifestDigest !== manifest.signature) throw changed(location);
	const digests = {...kit.digests};
	const managed = plan.files.filter(eligible);
	for (const file of managed) digests[file.path] = file.targetDigest;
	const next = writeCheckKit(manifest.raw, {...kit,version:plan.targetVersion,digests});
	for (const file of managed) {
		if (file.change === 'replace' || file.change === 'add') await publishKitFile(disk, location, file);
	}
	if (plan.courseworkFiles.some(file => file.change === 'replace'))
		await applyCourseworkFiles(disk,location,plan.courseworkFiles,checkManifest);
	for (const file of plan.templateFiles.filter(eligible)) {
		if (file.change !== 'replace') continue;
		await publishKitFile(disk,location,file,async () => {
			await checkManifest();
			if ((await readKitFile(disk,location,templateDeclarationFile)).digest !== plan.templateDeclarationDigest)
				throw changed(templateDeclarationFile);
		});
		await assertFileDigest(disk,location,file,file.targetDigest);
	}
	for (const file of managed) await assertFileDigest(disk,location,file,file.targetDigest);
	await replaceLibraryManifest(disk, location, plan.manifestDigest, next);
}
