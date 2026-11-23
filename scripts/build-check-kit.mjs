import esbuild from 'esbuild';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {courseworkScript,courseworkTemplate,previousCourseworkDigests} from '../src/kb/coursework-check.ts';
import {previousTemplateCheckDigests} from '../src/kb/template-check-digests.ts';

export async function buildCheckKit({packs,digests:specialDigests}) {
	const directory=new URL('../assets/checks/common/',import.meta.url);
	const sources={}, digests={};
	const ruleFiles=[];
	for(const name of readdirSync(directory).sort()){
		if(!name.endsWith('.mjs'))continue;
		const file='checks/common/'+name;
		const path=fileURLToPath(new URL(name,directory));
		ruleFiles.push(path);
		sources[file]=readFileSync(path,'utf8').replace(/\r\n/gu,'\n');
		digests[file]=createHash('sha256').update(sources[file]).digest('hex');
	}
	const templateChecks=Object.values(packs).filter(pack=>pack.descriptor.checks?.length).map(({descriptor,text})=>({
		id:descriptor.id,version:descriptor.version,checks:descriptor.checks.map(({id,name,path})=>{
			const current=createHash('sha256').update(text[path]).digest('hex');
			const known=descriptor.id===courseworkTemplate && path===courseworkScript ? previousCourseworkDigests :
				[].concat(previousTemplateCheckDigests[descriptor.id]?.[path] ?? []);
			return {id,name,path,digests:[current,...known]};
		}),
	}));
	const define={KB_COMMON_RULES:JSON.stringify(sources),KB_COMMON_DIGESTS:JSON.stringify(digests),KB_TEMPLATE_CHECKS:JSON.stringify(templateChecks),
		KB_CHECK_DIGESTS:JSON.stringify(specialDigests)};
	const cli=await esbuild.build({entryPoints:['src/diagnostics/cli.ts'],bundle:true,platform:'node',target:'node20',
		format:'cjs',outfile:'dist/kb-check.cjs',write:false,metafile:true,minify:true,define});
	// A library can redistribute the standalone runner without the plugin ZIP's notices.
	const notices=['LICENSE','node_modules/yaml/LICENSE','node_modules/smol-toml/LICENSE'].map(file=>{
		const content=readFileSync(new URL('../'+file,import.meta.url),'utf8').replace(/\r\n/gu,'\n');
		return file+'\n'+content.replace(/\*\//gu,'* /');
	});
	const runner='/*!\n'+notices.join('\n\n')+'\n*/\n'+cli.outputFiles[0].text;
	return {defines:{...define,KB_OFFLINE_RUNNER:JSON.stringify(runner)},metafile:cli.metafile,runner,ruleFiles};
}
