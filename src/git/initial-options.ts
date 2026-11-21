import {segments} from '../fs/segments.ts';
import {tr} from '../i18n.ts';

export const defaultInitialBranch='main';
export const defaultInitialMessage='Initial commit';

export interface InitialOptions {branch:string;message:string}

const invalidBranch=()=>new Error(tr('分支名无效','Invalid branch name'));

export function branchName(name:string){
	if(!/^[\p{L}\p{N}_][\p{L}\p{N}._/-]*$/u.test(name) || name==='HEAD' || name.includes('..') ||
		name.split('/').some(p=>!p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock')))throw invalidBranch();
	return name;
}

export function initialCommitOptions(draft?:Partial<InitialOptions>):InitialOptions{
	const branch=branchName(draft?.branch?.trim()??defaultInitialBranch);
	if(segments(branch).some(part=>part.toLowerCase().endsWith('.lock')))throw invalidBranch();
	const message=draft?.message?.trim()??defaultInitialMessage;
	if(!message)throw new Error(tr('请填写首提交说明','Enter an initial commit message'));
	if(Array.from(message).some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127 || char==='\u2028' || char==='\u2029'))
		throw new Error(tr('首提交说明须为一行文本','Enter the initial commit message on one line'));
	return {branch,message};
}
