import { tr } from '../i18n.ts';
import { amendRegistry, parseRegistry, registryDataPath, registryPath, serializeRegistry } from './paths.ts';

type Data = Record<string, unknown>;

export interface PluginDataIO {
	load(): Promise<unknown>;
	save(data: Data): Promise<void>;
}

export interface LegacyRegistryIO {
	read(): Promise<string | null>;
	remove(expected: string): Promise<void>;
}

export interface RegistryMigration {
	raw: string | null;
	legacyRaw: string;
	legacyPaths: string[];
	currentPaths: string[];
	paths: string[];
}

function registryField(data: Data) {
	return 'registeredLibraries' in data ? JSON.stringify(data.registeredLibraries, null, 2) + '\n' : null;
}

function changed() {
	return new Error(tr('登记已更改，请重新预览。','The registry changed. Open a new preview.'));
}

/** One writer per loaded plugin for the document shared by settings and the registry. */
export class PluginDataRegistry {
	private pending: Promise<void> = Promise.resolve();
	private readonly configDir: string;
	private readonly io: PluginDataIO;
	private readonly legacy: LegacyRegistryIO;

	constructor(configDir: string, io: PluginDataIO, legacy: LegacyRegistryIO) {
		this.configDir = configDir;
		this.io = io;
		this.legacy = legacy;
	}

	private async document(): Promise<Data> {
		const data = await this.io.load();
		if (data == null) return {};
		if (typeof data !== 'object' || Array.isArray(data)) {
			throw new Error(tr('插件 data.json 必须包含 JSON 对象。','Plugin data.json must contain a JSON object.'));
		}
		return data as Data;
	}

	private enqueue(action: () => Promise<void>) {
		const task = this.pending.then(action);
		this.pending = task.catch(() => {});
		return task;
	}

	async readRaw(): Promise<string | null> {
		return registryField(await this.document()) ?? await this.legacy.read();
	}

	async read() {
		const raw = await this.readRaw();
		return {raw, paths: raw === null ? [] : parseRegistry(raw, this.configDir)};
	}

	private async writableDocument() {
		if (await this.legacy.read() !== null) {
			throw new Error(tr('请先在知识库登记中确认迁移旧登记表。','Confirm the legacy registry migration in Registry first.'));
		}
		return this.document();
	}

	async assertWritable() {
		const raw = registryField(await this.writableDocument());
		if (raw !== null) parseRegistry(raw, this.configDir);
	}

	savePreferences(prefs: {language: unknown; defaults: unknown}) {
		return this.enqueue(async () => {
			const data = await this.document();
			const next = {...data, language: prefs.language, defaults: prefs.defaults} as Data;
			// Callers have already transferred the retired device settings and verified pending overrides.
			for (const key of ['parents','templates','grants','moves','saves','known','pendingLibraryPreferences','libraries','prefs','author','email']) {
				delete next[key];
			}
			if (JSON.stringify(next) !== JSON.stringify(data)) await this.io.save(next);
		});
	}

	private async savePaths(before: string | null, paths: readonly string[], prepare?: () => Promise<void>) {
		const next = serializeRegistry(paths, this.configDir);
		const check = async () => {
			const data = await this.writableDocument();
			if (registryField(data) !== before) throw changed();
			return data;
		};
		let data = await check();
		if (prepare) {
			await prepare();
			data = await check();
		}
		if (before !== next) await this.io.save({...data, registeredLibraries: parseRegistry(next, this.configDir)});
	}

	write(before: string | null, paths: readonly string[], prepare?: () => Promise<void>) {
		const target = [...paths];
		return this.enqueue(() => this.savePaths(before, target, prepare));
	}

	update(change: (paths: string[]) => string[]) {
		return this.enqueue(async () => {
			const {raw, paths} = await this.read();
			await this.savePaths(raw, change(paths));
		});
	}

	async previewMigration(): Promise<RegistryMigration | null> {
		const legacyRaw = await this.legacy.read();
		if (legacyRaw === null) return null;
		const raw = registryField(await this.document());
		let legacyPaths: string[];
		try { legacyPaths = parseRegistry(legacyRaw, this.configDir); }
		catch (error) {
			throw new Error(tr('请修复旧登记文件后重新预览','Repair the legacy registry file and reopen the preview') + ' · ' + registryPath + ' · ' + String(error));
		}
		let currentPaths: string[];
		try { currentPaths = raw === null ? [] : parseRegistry(raw, this.configDir); }
		catch (error) {
			throw new Error(tr('请修复目标文件的 registeredLibraries 字段后重新预览','Repair registeredLibraries in the destination file and reopen the preview') + ' · ' + registryDataPath(this.configDir) + ' · ' + String(error));
		}
		const paths = amendRegistry(currentPaths, {add: legacyPaths}, this.configDir);
		return {raw, legacyRaw, legacyPaths, currentPaths, paths};
	}

	migrate(preview: RegistryMigration, prepare?: () => Promise<void>) {
		return this.enqueue(async () => {
			const expected = serializeRegistry(preview.paths, this.configDir);
			const checked = async () => {
				const legacy = await this.legacy.read();
				const data = await this.document();
				const current = registryField(data);
				if (legacy === null && current === expected) return null;
				if (legacy !== preview.legacyRaw || (current !== preview.raw && current !== expected)) throw changed();
				return data;
			};
			let data = await checked();
			if (!data) return;
			if (prepare) {
				await prepare();
				data = await checked();
				if (!data) return;
			}
			if (registryField(data) !== expected) await this.io.save({...data, registeredLibraries: parseRegistry(expected, this.configDir)});
			if (registryField(await this.document()) !== expected) {
				throw new Error(tr('未能回读验证新登记表。旧登记表已保留。','Could not verify the saved registry. The legacy registry was retained.'));
			}
			await this.legacy.remove(preview.legacyRaw);
		});
	}
}
