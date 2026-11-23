import { parseDocument } from 'yaml';
import { fencedBlocks } from '../diagnostics/fences.ts';
import { segments } from '../fs/segments.ts';
import { key } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { sameOrBelow } from '../registry/paths.ts';
import { scanBasePathFilters, scanBasePaths } from './base-paths.ts';
import type { BasePathFilter, BasePathReference } from './base-paths.ts';

interface Scope { source: string; destination: string }
export interface MoveBaseToken { offset: number; original: string }
export interface MoveBaseField {
	token: MoveBaseToken;
	field: string;
	location: string;
	before: string;
	after: string;
	replacement: string;
	link?: {path:string; subpath:string};
}

function isVaultPath(value: string) {
	try { segments(value.replace(/\/$/u,'')); return true; }
	catch { return false; }
}

function managedPathUpdates(before: BasePathFilter[], after: BasePathFilter[], scope: Scope) {
	const covered=new Set<BasePathReference>();
	if (before.length!==after.length || before.some((filter,index)=>filter.field!==after[index]?.field)) return covered;
	for (const [index,filter] of before.entries()) {
		const updated=after[index]!;
		if (filter.line!==updated.line || filter.references.length!==updated.references.length) continue;
		let expression=updated.expression;
		const matches:BasePathReference[]=[];
		for (let i=filter.references.length-1;i>=0;i--) {
			const previous=filter.references[i]!, next=updated.references[i]!;
			const old=previous.argument, replacement=next.argument;
			if (previous.kind!==next.kind || previous.receiver!==next.receiver || old?.start===undefined ||
				replacement?.start===undefined || !sameOrBelow(old.value,scope.source) ||
				replacement.value!==scope.destination+old.value.slice(scope.source.length)) continue;
			expression=expression.slice(0,replacement.expressionStart)+
				filter.expression.slice(old.expressionStart,old.expressionEnd)+expression.slice(replacement.expressionEnd);
			matches.push(previous);
		}
		// Restore only provable path replacements. A changed predicate, another
		// field, or a moved inline block cannot stand in for this expression.
		if (expression===filter.expression) for (const match of matches) covered.add(match);
	}
	return covered;
}

export function moveBaseFields(text: string, file: string, scope: Scope, managed: boolean, managedAfter?: string,
	allowOrdinary=false) {
	const extension=file.toLowerCase().endsWith('.base') ? 'base' : 'md';
	const inside=sameOrBelow(file,scope.source);
	const escaped=scope.source.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
	const mentionsSource=new RegExp('["\'](?:\\./|/)?'+escaped+'(?=[/"\'])','giu');
	const sourceSpelling=(value:string)=>sameOrBelow(key(value.replace(/^(?:\.\/|\/)/u,'')),key(scope.source));
	const fields: MoveBaseField[]=[], manual: string[]=[];
	const unsupported=tr('检查动态或不受支持的 Base 路径','Review this dynamic or unsupported Base path');
	const location=(match:{field:string;line:number;column:number})=>`${match.field} · ${match.line}:${match.column}`;
	const filters=scanBasePathFilters(text,extension);
	const references=filters.flatMap(filter=>filter.references);
	const covered=managed && managedAfter!==undefined
		? managedPathUpdates(filters,scanBasePathFilters(managedAfter,extension),scope) : undefined;
	const sections=extension==='base' ? [{line:1,source:text}] : fencedBlocks(text,true).filter(block=>block.language==='base');
	for (const {line,source} of sections) {
		if (!inside && ![...source.matchAll(mentionsSource)].length) continue;
		if (parseDocument(source).errors.length) manual.push(tr('行','Line')+' '+line+' · '+tr('Base YAML 无法解析','Base YAML could not be parsed'));
	}
	for (const filter of filters) {
		const mentions=[...filter.expression.matchAll(mentionsSource)].length;
		const known=filter.references.filter(ref=>ref.argument && sourceSpelling(ref.argument.value)).length;
		if (mentions>known && /\bfile\s*\.\s*(?:folder\b|path\b(?!\s*\.\s*startsWith\s*\()|inFolder\b(?!\s*\())/u.test(filter.expression))
			manual.push(location(filter)+' · '+unsupported+' · '+filter.expression);
	}
	for (const match of references) {
		const {argument}=match;
		const review=(reason:string)=>manual.push(location(match)+' · '+reason+' · '+match.expression);
		if (!argument) {
			if (inside || [...match.expression.matchAll(mentionsSource)].length) review(unsupported);
			continue;
		}
		const {value,start,end,replace}=argument;
		const hash=match.kind==='link' ? value.indexOf('#') : -1;
		const path=hash===-1 ? value : value.slice(0,hash);
		const link=match.kind==='link' ? {path,subpath:hash===-1 ? '' : value.slice(hash)} : undefined;
		if (!sameOrBelow(path,scope.source)) {
			if (sourceSpelling(path) || (inside && link && !path.includes('/')))
				review(tr('检查 Base 路径拼写','Review the Base path spelling'));
			continue;
		}
		if (match.kind==='startsWith' && value===scope.source) {
			review(tr('路径前缀缺少目录分隔符','The path prefix has no folder separator'));
			continue;
		}
		if (covered?.has(match)) continue;
		if (managed && !allowOrdinary) {
			if (!covered?.has(match)) review(tr('受管更新未覆盖此 Base 路径','The managed update does not cover this Base path'));
			continue;
		}
		if (start===undefined || end===undefined || !replace || !isVaultPath(path) ||
			(link && (path===scope.source || /[#|[\]^\\]/u.test(scope.destination)))) {
			review(tr('检查无法安全替换的 Base 路径','Review this Base path before replacing it'));
			continue;
		}
		const after=scope.destination+value.slice(scope.source.length);
		const token={offset:start,original:text.slice(start,end)};
		const replacement=replace(after);
		// A plain YAML scalar can contain a Bases string literal without quoting
		// the YAML value itself. Punctuation in the new path can alter that YAML.
		if (/[#,{}[\]]/u.test(scope.destination)) {
			const updated=scanBasePaths(text.slice(0,start)+replacement+text.slice(end),extension);
			const unchanged=updated.length===references.length && references.every((previous,index)=>{
				const next=updated[index]!;
				return previous.field===next.field && previous.kind===next.kind && previous.receiver===next.receiver &&
					next.argument?.value===(previous===match ? after : previous.argument?.value);
			});
			if (!unchanged) {
				review(tr('新路径不能安全写入此 YAML 字段','The new path cannot be written safely in this YAML field'));
				continue;
			}
		}
		fields.push({token,field:match.field,location:location(match),before:value,after,replacement,...(link ? {link} : {})});
	}
	return {fields,manual};
}
