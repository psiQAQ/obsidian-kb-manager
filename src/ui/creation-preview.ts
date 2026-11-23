import {tr} from '../i18n.ts';
import {declaration} from '../kb/template-declaration.ts';
import type {Template} from '../kb/template-core.ts';

export function creationDisplayName(folderName:string,displayName:string) {
	if(!folderName.trim())throw new Error(tr('请输入目录名','Enter a folder name'));
	return displayName.trim()?displayName:folderName;
}

export function unmatchedDiagnosticExclusionWarnings(template:Pick<Template,'files'|'folders'>) {
	const asset=template.files.find(file=>file.name==='kb-template.json');
	if(!asset)return [];
	const {diagnosticExclusions}=declaration(new TextDecoder('utf-8',{fatal:true}).decode(asset.bytes));
	if(!diagnosticExclusions?.length)return [];
	const files=new Set(template.files.map(file=>file.name));
	const folders=new Set(template.folders);
	for(const file of files)for(let slash=file.indexOf('/');slash>=0;slash=file.indexOf('/',slash+1))folders.add(file.slice(0,slash));
	const warnings=new Set<string>();
	for(const rule of diagnosticExclusions){
		for(const file of rule.files??[])if(!files.has(file))warnings.add(tr(
			'新库中没有检验排除规则指定的文件 · ','Diagnostic exclusion file missing from the new library · ')+file);
		for(const folder of rule.folders??[])if(!folders.has(folder))warnings.add(tr(
			'新库中没有检验排除规则指定的目录 · ','Diagnostic exclusion folder missing from the new library · ')+folder+'/');
	}
	return [...warnings];
}
