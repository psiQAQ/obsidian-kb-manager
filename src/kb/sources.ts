import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tr } from '../i18n.ts';
import type { VaultDisk } from '../fs/vault.ts';
import type { Mapping } from './mapping.ts';
import { within } from './audit-types.ts';
import type { AuditNote, AuditReport } from './audit-types.ts';
import { candidates, contains, sourceBody } from './audit-markdown.ts';
import { validDate } from './audit-notes.ts';
import { referenceTarget } from './audit-links.ts';

function relative(value: string) {
	return value.length > 0 && !value.startsWith('/') && !value.includes('\\') &&
		!value.startsWith('[[') && !/^[a-z][\w+.-]*:/iu.test(value);
}

interface Snapshot { file: string; stamp: string }

export function inspectLocalReferences(location:string, files:ReadonlySet<string>, notes:ReadonlyMap<string,AuditNote>, report:AuditReport) {
	for(const [file,{metadata:m}] of notes) {
		if(m.type==='operation' || !('sources' in m))continue;
		const values=Array.isArray(m.sources) ? m.sources : [m.sources];
		for(const value of new Set(values)){
			const target=typeof value==='string' ? referenceTarget(file,value,location,files) : undefined;
			if(!target || !files.has(target))report('review','source-unverified',file,tr('未能在本库找到该来源 ','Could not find the source in this library: ')+String(value));
		}
	}
}

function registerSnapshot(raw: AuditNote, file: string, mapping: Mapping, grouped: Map<string, Snapshot[]>, report: AuditReport) {
	const m = raw.metadata;
	if (!('snapshot_source_note' in m || 'snapshot_source_mtime_ns' in m)) return;
	const name = m.snapshot_source_note, stamp = m.snapshot_source_mtime_ns;
	if (typeof name !== 'string' || !name || typeof stamp !== 'string' || !/^\d+$/u.test(stamp)) {
		report('review','snapshot-metadata',file,tr('快照需注明原笔记及带引号的纳秒时间字符串','Snapshot needs an original note and a quoted nanosecond timestamp'));
		return;
	}
	const target = path.posix.join(path.posix.dirname(file),name);
	if (!relative(name) || !within(target,mapping.notes)) {
		report('review','snapshot-source-scope',file,tr('快照原笔记超出本库 Notes','Snapshot original is outside this library’s Notes'));
		return;
	}
	const entries = grouped.get(target) ?? [];
	entries.push({file,stamp:stamp.replace(/^0+(?=\d)/u,'')});
	grouped.set(target,entries);
}

export async function inspectArticleSources(disk: VaultDisk, location: string, mapping: Mapping,
	files: ReadonlySet<string>, articles: ReadonlyMap<string, AuditNote>, noMaterial: ReadonlySet<string>,
	read: (file: string) => Promise<AuditNote>, report: AuditReport) {
	const roots = mapping.clippings ? [mapping.raw,mapping.clippings] : [mapping.raw];
	const referenced = new Set<string>();
	const textSources = new Map<string,string>();
	const snapshots = new Map<string,Snapshot[]>();
	for (const [file,note] of articles) {
		const {type,status,sources,archived} = note.metadata;
		if (!Array.isArray(sources) || !sources.every((v): v is string => typeof v === 'string')) continue;
		if (!sources.length) {
			if (type === 'overview' && status === 'empty') {
				if (articles.size > 1) report('review','empty-overview',file,tr('库内已有知识页，请复核空综述','Review the empty overview now that knowledge pages exist'));
			} else if (type !== 'category') report('error','sources-missing',file,tr('知识页缺少来源','Knowledge page has no sources'));
			continue;
		}
		const evidence: string[] = [];
		for (const value of new Set(sources)) {
			const target = referenceTarget(file,value,location,files);
			if (!target) {
				report('error','source-path',file,tr('来源须为本库文件链接或相对路径','Expected a link or relative path to a file in this library') + ': ' + value);
				continue;
			}
			if (target === file || !(type === 'archive' ? [mapping.wiki] : roots).some(root => within(target,root))) {
				report('error','source-scope',file,tr('来源超出允许的本库目录','Source outside the allowed library folder') + ': ' + value);
				continue;
			}
			if (!files.has(target)) {
				report('error','source-missing',file,tr('来源文件不存在或无法安全访问','Source file missing or unavailable') + ': ' + value);
				continue;
			}
			if (type === 'archive') {
				const cited = articles.get(target);
				if (!cited) report('error','archive-source',file,tr('归档须引用本库知识页','Archives must cite knowledge articles') + ': ' + value);
				else if (validDate(cited.metadata.updated) && validDate(archived) && cited.metadata.updated > archived)
					report('review','archive-stale',file,tr('被引页面在归档后有更新','Cited page changed after archival') + ': ' + value);
				continue;
			}
			referenced.add(target);
			if (!/\.(?:md|txt)$/iu.test(target)) {
				report('review','evidence-unverified',file,tr('未核验非文本来源，请阅读原件','Non-text evidence unverified; read the original') + ': ' + value);
				continue;
			}
			try {
				let body = textSources.get(target);
				if (body === undefined) {
					const raw = await read(target);
					if (within(target,mapping.raw)) registerSnapshot(raw,target,mapping,snapshots,report);
					body = sourceBody(raw.body);
					textSources.set(target,body);
				}
				evidence.push(body);
			} catch (error) {
				report('review','evidence-unverified',file,tr('未能核验来源','Source unverified') + ': ' + value + ' · ' + String(error));
			}
		}
		if (evidence.length) for (const candidate of candidates(note.body)) {
			if (!evidence.some(body => contains(body,candidate))) report('review','evidence-candidate',file,
				tr('未在引用正文找到该字面值，请复核上下文或推导','Literal absent from cited text; review context or derivation') + ': ' + candidate.value);
		}
	}
	for (const [target,entries] of snapshots) {
		const labels = entries.map(s => s.file).join(', ');
		if (!files.has(target)) {
			report('review','snapshot-source-missing',target,tr('核对快照原笔记','Review missing snapshot original') + ': ' + labels);
			continue;
		}
		try {
			const stat = await fs.lstat(await disk.path(location + '/' + target),{bigint:true});
			if (!stat.isFile() || entries.some(entry => entry.stamp !== String(stat.mtimeNs)))
				report('review','snapshot-source-changed',target,tr('原笔记时间已变化，请复核快照','Original note timestamp changed; review snapshots') + ': ' + labels);
		} catch (error) {
			report('review','snapshot-source-unverified',target,tr('无法核对快照时间','Could not check snapshot timestamp') + ': ' + labels + ' · ' + String(error));
		}
	}
	for (const file of files) {
		const root = roots.find(r => within(file,r));
		if (root && !file.slice(root.length + 1).split('/').includes('assets') && !referenced.has(file) && !noMaterial.has(file))
			report('review','unprocessed-raw',file,tr('尚无知识页引用或 No material 摄入记录','No knowledge page citation or No material ingestion record'));
	}
}
