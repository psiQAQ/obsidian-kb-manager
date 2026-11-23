import {posix} from 'node:path';
import {isScalar, parseDocument} from 'yaml';
import type {Pos} from 'obsidian';
import {moveVaultPath, relocateMarkdownReference} from './move-link-text.ts';
import type {MoveToken} from './move-references.ts';

interface Scope { source: string; destination: string }

function exactTarget(path: string, target: string) {
	return path===target || path+'.md'===target;
}

export function keepsRelativeLinkTarget(path: string, from: string, target: string, scope: Scope) {
	if (!/^\.\.?\//u.test(path) || /[\\%]/u.test(path)) return false;
	const relativeTo=(file:string)=>posix.normalize(posix.join(posix.dirname(file),path));
	const moved=(file:string)=>moveVaultPath(file,scope.source,scope.destination);
	return exactTarget(relativeTo(from),target) && exactTarget(relativeTo(moved(from)),moved(target));
}

export function movePropertyValues(text: string) {
	const header=/^\uFEFF?---[ \t]*\r?\n/u.exec(text);
	if (!header) return;
	const body=text.slice(header[0].length);
	const end=/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(body);
	if (!end) return;
	const yaml=parseDocument(body.slice(0,end.index));
	if (yaml.errors.length) return;
	return (key:string)=>{
		const parts=key.split('.');
		const entry=yaml.getIn(parts,true);
		return isScalar(entry) && typeof entry.value==='string' ? entry.value : undefined;
	};
}

export function movePropertyToken(value: string | undefined, original: string) {
	if (!value || !/^\[\[[^\r\n]*\]\]$/u.test(original)) return false;
	const index=value.indexOf(original);
	return index!==-1 && value.indexOf(original,index+original.length)===-1;
}

export function managedPropertyTarget(before: string | undefined, after: string | undefined, original: string,
	path: string, file: string, target: string, scope: Scope) {
	if (!movePropertyToken(before,original) || before===undefined || !after) return false;
	const replacement=relocateMarkdownReference(original,file,target,scope.source,scope.destination);
	if (!replacement || replacement===original || after!==before.replace(original,()=>replacement)) return false;
	const next=replacement.slice(2,-2).split(/#|\|/u)[0]!;
	const moved=moveVaultPath(target,scope.source,scope.destination);
	return path.includes('/') && exactTarget(path,target) && next.includes('/') && exactTarget(next,moved);
}

const referenceId=(id:string)=>id.trim().replace(/\s+/gu,' ').toLowerCase();

export function moveReferenceDefinition(lines: readonly string[], id: string, position: Pos, link: string) {
	const line=lines[position.start.line];
	if (!line) return;
	const match=/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|([^ \t]+))/u.exec(line);
	if (!match || referenceId(match[1]!)!==referenceId(id)) return;
	const value=(match[2] ?? match[3])!;
	try {
		if (decodeURIComponent(value)===link) return match[0];
	} catch { /* Require an unambiguous, decodable destination. */ }
	return undefined;
}

export function moveReferenceUse(original: string, displayText: string) {
	const match=/^!?\[((?:[^[\]\\]|\\.)+)\](?:\[([^[\]\\]*)\])?$/u.exec(original);
	return match ? referenceId(match[2] || displayText || match[1]!) : undefined;
}

export function uncoveredManagedMarkdown(text: string, after: string|undefined, file: string, scope: Scope,
	tokens: readonly MoveToken[]) {
	const beforeLines=text.split('\n'), afterLines=after?.split('\n');
	const groups=new Map<number,{token:MoveToken; column:number}[]>();
	for (const token of tokens) {
		const line=text.slice(0,token.offset).split('\n').length-1;
		const rows=groups.get(line) ?? [];
		rows.push({token,column:token.offset-(text.lastIndexOf('\n',token.offset-1)+1)});
		groups.set(line,rows);
	}
	return [...groups].flatMap(([line,rows])=>{
		const original=beforeLines[line]!, current=afterLines?.length===beforeLines.length ? afterLines[line] : undefined;
		const all=()=>rows.map(({token})=>({line:line+1,token}));
		if (current===undefined) return all();
		let beforeAt=0, afterAt=0;
		const review:{line:number;token:MoveToken}[]=[];
		for (const {token,column} of rows.sort((a,b)=>a.column-b.column)) {
			const unchanged=original.slice(beforeAt,column);
			if (column<beforeAt || !current.startsWith(unchanged,afterAt)) return all();
			afterAt+=unchanged.length;
			const replacement=relocateMarkdownReference(token.original,file,token.target,scope.source,scope.destination);
			const keepsOld=current.startsWith(token.original,afterAt);
			const hasNew=replacement && current.startsWith(replacement,afterAt);
			if (!replacement || keepsOld===!!hasNew) return all();
			if (keepsOld) review.push({line:line+1,token});
			afterAt+=keepsOld ? token.original.length : replacement.length;
			beforeAt=column+token.original.length;
		}
		return original.slice(beforeAt)===current.slice(afterAt) ? review : all();
	});
}
