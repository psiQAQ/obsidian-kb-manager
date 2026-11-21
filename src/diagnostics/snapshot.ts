import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parse} from 'smol-toml';
import {isScalar, parseDocument, visit} from 'yaml';
import {tr} from '../i18n.ts';
import {segments} from '../fs/segments.ts';
import {key, statIfPresent} from '../fs/vault.ts';
import {readManifest} from '../kb/identity-core.ts';
import {declaration} from '../kb/template-declaration.ts';
import type {CheckDeclaration, Declaration as TemplateDeclaration} from '../kb/template-declaration.ts';
import {generalIds, isRecord, printable} from './types.ts';
import type {CheckContext, DiagnosticOptions, SpecialCheck, TemplateIdentity} from './types.ts';

export type Declaration = TemplateDeclaration & TemplateIdentity;
export interface DeclaredCheck extends SpecialCheck { source?: Buffer; linkEvidence?: CheckDeclaration['linkEvidence'] }
export interface TemplateSnapshot { template?: Declaration; checks: DeclaredCheck[]; reason?: string; missing?: boolean }
const bytesPerFile = 2 * 1024 * 1024;
const bytesPerLibrary = 24 * 1024 * 1024;
const templateFile = 'kb-template.json';
export const checkIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
// Obsidian callers supply Vault.configDir. Only the standalone CLI defaults to this conventional name.
export const defaultConfigDir = '.obsidian';
const decoder = new TextDecoder('utf-8', {fatal: true});
export const decode = (data: Uint8Array) => decoder.decode(data);
export const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

export function relativePath(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 2048) return false;
	try {segments(value); return true;} catch {return false;}
}

export function validConfigDir(value: string) {
	return printable(value, 128) && value.trim() === value && value !== '.' && value !== '..' && !/[<>:"/\\|?*]/u.test(value);
}

export async function libraryLocation(options: Pick<DiagnosticOptions,'libraryRoot'|'vaultRoot'|'configDir'>) {
	const requested = path.resolve(options.libraryRoot);
	const stat = await fs.lstat(requested);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid-root');
	const root = await fs.realpath(requested);
	const configDir = options.configDir ?? defaultConfigDir;
	if (!validConfigDir(configDir)) throw new Error('invalid-config-directory');
	const identifiedVault = options.vaultRoot ? await fs.realpath(options.vaultRoot) :
		// The CLI can discover a conventional ancestor by checking the directory name alone.
		('configDir' in options ? await findVault(root, configDir) : undefined);
	const vault = identifiedVault ?? root;
	const relative = path.relative(vault, root).split(path.sep).join('/');
	if (relative && (!relativePath(relative) || relative.split('/').some(part => key(part) === key(configDir))))
		throw new Error('outside-vault');
	return {root, vault, relative, configDir, identifiedVault: identifiedVault !== undefined};
}

async function findVault(root: string, configDir: string) {
	let dir = root;
	while (true) {
		const marker = await statIfPresent(path.join(dir, configDir)).catch(() => undefined);
		if (marker?.isDirectory() && !marker.isSymbolicLink()) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export async function readRelative(root: string, relative: string, limit = bytesPerFile): Promise<Buffer> {
	const parts = segments(relative);
	const target = path.join(root, ...parts);
	let filename = root;
	for (const part of parts) {
		filename = path.join(filename, part);
		const stat = await fs.lstat(filename);
		if (stat.isSymbolicLink() || (filename !== target && !stat.isDirectory())) throw new Error('linked-path');
	}
	const before = await fs.lstat(filename);
	if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('unsafe-file');
	if (await fs.realpath(filename) !== target) throw new Error('linked-path');
	const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit || await fs.realpath(filename) !== target)
			throw new Error('changed-file');
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const {bytesRead} = await file.read(buffer, offset, buffer.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		const after = await file.stat();
		if (offset !== stat.size || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw new Error('changed-file');
		return buffer.subarray(0, offset);
	} finally {await file.close();}
}

function readDeclaration(raw: string): TemplateSnapshot {
	const parsed = declaration(raw);
	const checks = parsed.checks ?? [];
	if (checks.length > 64 || checks.some(check => !checkIdPattern.test(check.id) || generalIds.has(check.id) ||
		!printable(check.name, 160) || !relativePath(check.path) || (check.description && !printable(check.description, 512))))
		throw new Error('invalid-check-declaration');
	if (printable(parsed.id, 512) && printable(parsed.version, 512))
		return {template: {...parsed, id: parsed.id, version: parsed.version}, checks: checks.map(check => ({...check}))};
	if (checks.length) throw new Error('missing-template-identity');
	return {checks: []};
}

export async function templateSnapshot(root: string, withScripts: boolean): Promise<TemplateSnapshot> {
	try {
		if (!await statIfPresent(path.join(root, templateFile))) return {checks: [], missing: true};
		const snapshot = readDeclaration(decode(await readRelative(root, templateFile)));
		if (withScripts) for (const check of snapshot.checks) {
			try {
				check.source = await readRelative(root, check.path, 512 * 1024);
				decode(check.source);
				check.digest = hash(check.source);
			} catch {check.reason = tr('专项脚本不可读，或不符合独立 UTF-8 文件要求。','Check that the script is a readable, standalone UTF-8 file.');}
		}
		return snapshot;
	} catch {return {checks: [], reason: tr('模板声明或专项检查列表无效。','Review the template declaration and its check list. They contain an invalid field.')};}
}

export interface NoteRecord {
	path: string;
	body: string;
	properties?: Record<string, unknown>;
	lineOffset: number;
	problem?: {line: number; code: string; dynamic?: boolean};
}

function noteProperties(yaml: string) {
	const document = parseDocument(yaml);
	const error = document.errors[0];
	if (error) throw error;
	visit(document, {Pair(_, pair) {
		if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('invalid-property-key');
	}});
	const data: unknown = document.toJS();
	if (data != null && !isRecord(data)) throw new Error('properties-not-a-mapping');
	return JSON.parse(JSON.stringify(data ?? {})) as Record<string, unknown>;
}

function noteRecord(file: string, raw: string): NoteRecord {
	const lines = raw.split(/\r?\n/u);
	const hasHeader = /^(?:\uFEFF)?---[ \t]*$/u.test(lines[0] ?? '');
	const closing = hasHeader ? lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(line)) : -1;
	const lineOffset = closing + 1;
	if (!hasHeader) return {path:file, body:raw, properties:{}, lineOffset};
	const yaml = lines.slice(1,closing).join('\n');
	try {
		if (closing < 0) throw new Error('missing-end-marker');
		// Round-trip YAML values to plain JSON data before sharing with a checker.
		const properties = noteProperties(yaml);
		return {path: file, body: lines.slice(lineOffset).join('\n'), properties, lineOffset};
	} catch (error) {
		const positions = isRecord(error) ? error.linePos : undefined;
		const first: unknown = Array.isArray(positions) ? positions[0] : undefined;
		const line = isRecord(first) && typeof first.line === 'number' ? first.line + 1 : 1;
		let dynamic = false;
		let placeholder = 0;
		const replaced = yaml.replace(/\{\{[^{}\n]+\}\}|<%[\s\S]*?%>/gu, () => `template-value-${++placeholder}`);
		if (closing >= 0 && placeholder) {
			try {noteProperties(replaced); dynamic = true;} catch {/* The original YAML also has a static error. */}
		}
		return {path: file, body: closing >= 0 ? lines.slice(lineOffset).join('\n') : '', lineOffset,
			problem: {line, code: closing < 0 ? 'unclosed-frontmatter' : 'invalid-frontmatter', dynamic}};
	}
}

export interface Inventory {
	files: Set<string>;
	directories: Set<string>;
	excluded: Set<string>;
	notes: NoteRecord[];
	unreadable: string[];
	unreadableDirectories: Set<string>;
	skipped: number;
}

export async function inventory(root: string, configDir: string): Promise<Inventory> {
	const found: Inventory = {files: new Set(), directories: new Set(), excluded: new Set(), notes: [], unreadable: [],
		unreadableDirectories: new Set(), skipped: 0};
	let remaining = bytesPerLibrary;
	async function visit(relative: string) {
		const directory = path.join(root, relative);
		let entries;
		try {
			const stat = await fs.lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {found.excluded.add(relative); found.skipped++; return;}
			entries = await fs.readdir(directory, {withFileTypes: true});
		} catch (error) {
			if (!relative) throw error;
			found.unreadableDirectories.add(relative);
			return;
		}
		entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		if (relative && entries.some(entry => ['.git','kb.toml','kb-manager.json'].includes(key(entry.name)))) {
			found.excluded.add(relative); found.skipped++; return;
		}
		found.directories.add(relative);
		for (const entry of entries) {
			const file = relative ? relative + '/' + entry.name : entry.name;
			if (!relativePath(file) || key(entry.name) === key(configDir) || ['node_modules','__pycache__'].includes(key(entry.name)) ||
				key(file) === 'checks' || entry.isSymbolicLink()) {found.excluded.add(file); found.skipped++; continue;}
			if (entry.isDirectory()) await visit(file);
			if (!entry.isFile()) continue;
			found.files.add(file);
			if (!/\.md$/iu.test(file)) continue;
			try {
				const bytes = await readRelative(root, file, Math.min(remaining, bytesPerFile));
				remaining -= bytes.length;
				found.notes.push(noteRecord(file, decode(bytes)));
			} catch {found.unreadable.push(file);}
		}
	}
	await visit('');
	return found;
}

export async function manifestSnapshot(root: string) {
	try {
		const raw = decode(await readRelative(root, 'kb.toml'));
		const parsed = readManifest(raw);
		const {version, paths, variables} = parse(raw);
		const safePaths = isRecord(paths) ? Object.fromEntries(Object.entries(paths).filter(([,value]) => relativePath(value))) : undefined;
		if (variables !== undefined && (!isRecord(variables) || Object.entries(variables).some(([key, value]) =>
			!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || !(typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)))))
			return {reason: tr('本库 [variables] 须使用名称与字符串、有限数字或布尔值。','Use named strings, finite numbers, or booleans in [variables].')};
		return {parsed, version, paths: safePaths, variables};
	}
	catch {return {reason: tr('知识库清单缺失、无效或不可读。','Check that kb.toml exists, is readable, and contains a valid library manifest.')};}
}

export function checkContext(root: string, template: Declaration, manifest: Awaited<ReturnType<typeof manifestSnapshot>>, notes: NoteRecord[]): CheckContext {
	return {libraryRoot: root, template: {...template}, manifest: {version: manifest.version, paths: manifest.paths, manager: manifest.parsed?.identity,
		variables: manifest.variables, preferences: manifest.parsed?.preferences},
		notes: notes.flatMap(note => note.properties ? [{path: note.path, body: note.body, properties: note.properties}] : [])};
}
