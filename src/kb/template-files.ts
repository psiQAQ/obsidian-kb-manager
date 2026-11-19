import type { DataAdapter } from 'obsidian';
import { segments } from '../fs/segments.ts';
import { tr } from '../i18n.ts';
import { compareRegistryPaths, registryKey, sameOrBelow } from '../registry/paths.ts';
import { renderKepano } from './kepano.ts';
import type { Identity } from './identity-core.ts';
import type { Mapping } from './mapping.ts';
import { isKepano, kepanoBinding } from './template-core.ts';
import type { BuiltinKind } from './template-core.ts';

export const libraryBoundaries = ['.git', 'kb.toml', 'kb-manager.json'];
type Disk = Pick<DataAdapter, 'list' | 'stat' | 'read' | 'mkdir' | 'write' | 'copy' | 'remove'>;
type Check = (path: string) => Promise<void>;
export interface TemplateAccess { disk: Disk; configDir: string; checkPath?: Check }
export interface Preset { path: string; bundledPath: string; content: string }

function occupied(path: string) {
	return new Error(tr('模板位置已被占用或不可访问', 'Template path is occupied or inaccessible') + ' · ' + path);
}

export function localTemplateFolder(location: string, kind: string, mapping?: Mapping) {
	const relative = mapping?.templates ?? (kind === 'kepano' ? 'Templates' : 'templates');
	const key = registryKey(relative);
	if (mapping && !mapping.templates && [mapping.raw, mapping.wiki, mapping.reports, mapping.clippings, mapping.notes]
		.some(folder => folder && (sameOrBelow(key, registryKey(folder)) || sameOrBelow(registryKey(folder), key)))) {
		throw new Error(tr('默认模板目录与现有目录映射重叠', 'The default template folder overlaps existing path mappings') + ' · ' + relative);
	}
	return location + '/' + relative;
}

export async function hasLibraryBoundary(disk: Disk, path: string) {
	const { files, folders } = await disk.list(path);
	const markers = new Set(libraryBoundaries.map(name => registryKey(path + '/' + name)));
	return [...files, ...folders].some(name => markers.has(registryKey(name)))
		|| (await Promise.all(libraryBoundaries.map(name => disk.stat(path + '/' + name)))).some(Boolean);
}

function pathLookup(access: TemplateAccess) {
	const listings = new Map<string, ReturnType<Disk['list']>>();
	return async (path: string, boundary?: string) => {
		let parent = '';
		const parts = path.split('/');
		for (const [index, part] of parts.entries()) {
			const current = parent ? parent + '/' + part : part;
			let listing = listings.get(parent);
			if (!listing) {
				listing = access.disk.list(parent);
				listings.set(parent, listing);
			}
			const { files, folders } = await listing;
			const key = registryKey(current);
			if ([...folders, ...files].some(name => registryKey(name) === key && name !== current)) throw occupied(current);
			const type = folders.includes(current) ? 'folder' : files.includes(current) ? 'file' : (await access.disk.stat(current))?.type;
			if (!type) return undefined;
			await access.checkPath?.(current);
			if (type === 'folder' && boundary !== undefined && current !== boundary &&
				(!boundary || sameOrBelow(current, boundary)) && await hasLibraryBoundary(access.disk, current)) {
				throw new Error(tr('模板路径属于其他知识库或 Git 仓库', 'Template path belongs to another library or Git repository') + ' · ' + current);
			}
			if (index === parts.length - 1) return type;
			if (type !== 'folder') throw occupied(current);
			parent = current;
		}
		return undefined;
	};
}

export async function legacyTemplateFolder(access: TemplateAccess, kind: BuiltinKind) {
	const { configDir, disk } = access;
	segments(configDir.startsWith('.') ? configDir.slice(1) : configDir);
	const settings = configDir + '/templates.json';
	const lookup = pathLookup(access);
	const type = await lookup(settings);
	if (type && type !== 'file') throw occupied(settings);
	const raw: unknown = type ? JSON.parse((await disk.read(settings)).replace(/^\uFEFF/u, '')) : {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw occupied(settings);
	const value: unknown = 'folder' in raw ? raw.folder : undefined;
	if (value !== undefined && value !== null && typeof value !== 'string') throw occupied(settings);
	const root = (value || 'Templates').replace(/\/+$/u, '');
	segments(root);
	const key = registryKey(root), config = registryKey(configDir);
	if (sameOrBelow(key, config) || sameOrBelow(config, key)) throw occupied(root);
	const folder = root + (kind === 'kepano' ? '/Kepano' : '/融合 LLM Wiki');
	if ((await lookup(folder, '')) === 'file') throw occupied(folder);
	return folder;
}

export async function listTemplateFiles(access: TemplateAccess, folder: string, libraryRoot: string) {
	segments(folder);
	const lookup = pathLookup(access), files = new Set<string>();
	async function visit(directory: string) {
		const listing = await access.disk.list(directory);
		const prefix = directory + '/';
		const child = (path: string) => path.startsWith(prefix) && /^[^./][^/]*$/u.test(path.slice(prefix.length));
		for (const path of listing.files) {
			if (child(path) && /\.(?:md|base)$/iu.test(path)) files.add(path.slice(folder.length + 1));
		}
		for (const path of listing.folders.filter(child)) {
			segments(path);
			await access.checkPath?.(path);
			if (!await hasLibraryBoundary(access.disk, path)) await visit(path);
		}
	}
	const type = await lookup(folder, libraryRoot);
	if (type === 'file') throw occupied(folder);
	if (type) await visit(folder);
	return files;
}

export async function checkTemplateFile(access: TemplateAccess, path: string, boundary: string) {
	segments(path);
	if (await pathLookup(access)(path, boundary) !== 'file') throw occupied(path);
}

export async function previewTemplateRestore(access: TemplateAccess, kind: BuiltinKind, library: string, folder: string,
	skeleton: Record<string, string>, sharedFiles: ReadonlySet<string>): Promise<Preset[]> {
	if (!folder.startsWith(library + '/')) throw occupied(folder);
	segments(folder);
	const prefix = kind === 'kepano' ? 'Templates/' : 'templates/';
	const lookup = pathLookup(access);
	const rendered = kind === 'kepano' ? renderKepano(skeleton, library) : skeleton;
	const presets: Preset[] = [];
	for (const [bundledPath, content] of Object.entries(rendered)) {
		if (!bundledPath.startsWith(prefix) || !/\.(?:md|base)$/iu.test(bundledPath)) continue;
		const relative = bundledPath.slice(prefix.length);
		segments(relative);
		const path = folder + '/' + relative;
		if (sharedFiles.has(relative) || await lookup(path, library)) continue;
		presets.push({ path, bundledPath, content });
	}
	return presets.sort((a, b) => compareRegistryPaths(a.path, b.path));
}

export async function restoreTemplateFile(access: TemplateAccess, preset: Preset, library: string) {
	const { disk } = access;
	if (!preset.path.startsWith(library + '/')) throw occupied(preset.path);
	segments(preset.path);
	let parent = library;
	const parts = preset.path.slice(library.length + 1).split('/');
	parts.pop();
	for (const part of parts) {
		parent += '/' + part;
		const type = await pathLookup(access)(parent, library);
		if (!type) await disk.mkdir(parent);
		else if (type !== 'folder') throw occupied(parent);
	}
	if (await pathLookup(access)(preset.path, library)) throw occupied(preset.path);
	// DataAdapter.copy is exclusive, so a same-name file arriving after the check wins.
	const temp = parent + '/.kb-manager-template-' + crypto.randomUUID() + '.tmp';
	try {
		await disk.write(temp, preset.content);
		await disk.copy(temp, preset.path);
	} finally {
		if (await disk.stat(temp)) await disk.remove(temp);
	}
}

export async function restoredTemplateBindings(identity: Identity, files: Preset[], root: string,
	skeleton: Record<string, string>, hash: (content: string) => string | Promise<string>) {
	if (!isKepano(identity.template)) return undefined;
	const updates = new Map<string, Identity['managed'][number]>();
	for (const { path, bundledPath, content } of files) {
		if (path !== root + '/' + bundledPath || !kepanoBinding(skeleton, bundledPath)) continue;
		const old = identity.managed.find(item => registryKey(item.path) === registryKey(bundledPath));
		if (old && (old.path !== bundledPath || old.role !== 'kepano-bindings')) continue;
		updates.set(bundledPath, { path: bundledPath, root, fingerprint: await hash(content), role: 'kepano-bindings' });
	}
	if (!updates.size) return undefined;
	const existing = identity.managed.map(item => {
		const update = updates.get(item.path);
		updates.delete(item.path);
		return update ?? item;
	});
	return [...existing, ...updates.values()];
}
