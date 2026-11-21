import { tr } from '../i18n.ts';
import { parseRegistry, serializeRegistry } from './paths.ts';
import type {ExclusionState} from '../kb/template-exclusions.ts';

type Data = Record<string, unknown>;

export interface PluginDataIO {
	load(): Promise<unknown>;
	save(data: Data): Promise<void>;
}

function registryField(data: Data) {
	return 'registeredLibraries' in data ? JSON.stringify(data.registeredLibraries, null, 2) + '\n' : null;
}

function changed() {
	return new Error(tr('登记已更改，请重新预览。','The registry changed. Open a new preview.'));
}

function exclusionOwnership(data:Data):Record<string,unknown> {
	const field=data.templateExclusionOwnership;
	if(field===undefined)return {};
	if(!field || typeof field!=='object' || Array.isArray(field))throw changed();
	return field as Record<string,unknown>;
}

/** One writer per loaded plugin for the document shared by settings and the registry. */
export class PluginDataRegistry {
	private pending: Promise<void> = Promise.resolve();
	private readonly configDir: string;
	private readonly io: PluginDataIO;

	constructor(configDir: string, io: PluginDataIO) {
		this.configDir = configDir;
		this.io = io;
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
		return registryField(await this.document());
	}

	async read() {
		const raw = await this.readRaw();
		return {raw, paths: raw === null ? [] : parseRegistry(raw, this.configDir)};
	}

	async assertWritable() {
		const raw = registryField(await this.document());
		if (raw !== null) parseRegistry(raw, this.configDir);
	}

	async readExclusionOwnership(id:string):Promise<ExclusionState|null> {
		const state=exclusionOwnership(await this.document())[id];
		if(state===undefined)return null;
		if(!state || typeof state!=='object' || !('owner' in state))throw changed();
		const {owner}=state;
		if(owner!==null && (!owner || typeof owner!=='object' || !('root' in owner) || typeof owner.root!=='string'
			|| !('rules' in owner) || !Array.isArray(owner.rules) || !owner.rules.every((rule:unknown)=>typeof rule==='string')))
			throw changed();
		return state as ExclusionState;
	}

	writeExclusionOwnership(id:string,before:ExclusionState|null,after:ExclusionState|null) {
		return this.enqueue(async()=>{
			if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id))throw changed();
			const data=await this.document(),owners=exclusionOwnership(data);
			if(JSON.stringify(owners[id]??null)!==JSON.stringify(before))throw changed();
			if(JSON.stringify(before)===JSON.stringify(after))return;
			const next={...owners};
			if(after)next[id]=after;
			else delete next[id];
			const updated={...data,templateExclusionOwnership:next};
			if(!Object.keys(next).length)delete (updated as Data).templateExclusionOwnership;
			await this.io.save(updated);
			if(JSON.stringify(await this.readExclusionOwnership(id))!==JSON.stringify(after))throw changed();
		});
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
			const data = await this.document();
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
}
