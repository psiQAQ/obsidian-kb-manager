import { tr } from '../i18n.ts';
import { parseRegistry, serializeRegistry } from './paths.ts';
import type {ExclusionState} from '../kb/template-exclusions.ts';
import { readPreferences } from '../preferences.ts';
import type { GitPreferences, Language } from '../preferences.ts';

type Data = Record<string, unknown>;
const retired = ['parents','templates','grants','moves','saves','known','pendingLibraryPreferences','libraries','prefs','author','email'] as const;

function fields(value:unknown):Data {
	return value && typeof value==='object' && !Array.isArray(value) ? value as Data : {};
}

function shared(data:Data) {
	const legacy=fields(data.prefs);
	return {
		language:data.language ?? legacy.language,
		defaults:{...fields(legacy.defaults),...fields(data.defaults)},
	};
}

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

	private enqueue<T>(action: () => Promise<T>) {
		const task = this.pending.then(action);
		this.pending = task.then(()=>{},()=>{});
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

	async readSettings() {
		const data=await this.document();
		const raw=registryField(data);
		return {prefs:readPreferences(shared(data)),paths:raw===null?[]:parseRegistry(raw,this.configDir)};
	}

	savePreferences(patch: {language?: Language; defaults?: Partial<GitPreferences>; remove?: readonly (keyof GitPreferences)[]}) {
		return this.enqueue(async () => {
			const data = await this.document();
			const next={...data};
			if(patch.language!==undefined)next.language=patch.language;
			if(patch.defaults || patch.remove?.length){
				const defaults={...fields(data.defaults),...patch.defaults};
				for(const key of patch.remove ?? [])delete defaults[key];
				next.defaults=defaults;
			}
			if (JSON.stringify(next) !== JSON.stringify(data)) await this.io.save(next);
			return readPreferences(shared(next));
		});
	}

	/** Remove retired fields only after their source values were transferred to this device. */
	migratePreferences(source:unknown) {
		return this.enqueue(async()=>{
			const data=await this.document(), previous=fields(source);
			if(retired.some(key=>key in data) && retired.every(key=>JSON.stringify(data[key])===JSON.stringify(previous[key]))){
				const prefs=shared(data);
				for(const key of ['author','email','backend'])delete prefs.defaults[key];
				const next={...data,language:readPreferences(prefs).language,defaults:prefs.defaults};
				for(const key of retired)delete (next as Data)[key];
				await this.io.save(next);
				return readPreferences(prefs);
			}
			return readPreferences(shared(data));
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
