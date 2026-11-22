import esbuild from 'esbuild';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export async function buildCheckKit(specialDigests) {
	const directory=new URL('../assets/checks/common/',import.meta.url);
	const sources={}, digests={};
	const ruleFiles=[];
	const manifestFile=fileURLToPath(new URL('../manifest.json',import.meta.url));
	for(const name of readdirSync(directory).sort()){
		if(!name.endsWith('.mjs'))continue;
		const file='checks/common/'+name;
		const path=fileURLToPath(new URL(name,directory));
		ruleFiles.push(path);
		sources[file]=readFileSync(path,'utf8').replace(/\r\n/gu,'\n');
		digests[file]=createHash('sha256').update(sources[file]).digest('hex');
	}
	const define={KB_COMMON_RULES:JSON.stringify(sources),KB_COMMON_DIGESTS:JSON.stringify(digests),
		KB_CHECK_DIGESTS:JSON.stringify(specialDigests),
		KB_DIAGNOSTICS_VERSION:JSON.stringify(JSON.parse(readFileSync(manifestFile,'utf8')).version)};
	const cli=await esbuild.build({entryPoints:['src/diagnostics/cli.ts'],bundle:true,platform:'node',target:'node20',
		format:'cjs',outfile:'dist/kb-check.cjs',write:false,metafile:true,minify:true,define});
	// A library can redistribute the standalone runner without the plugin ZIP's notices.
	const notices=['LICENSE','node_modules/yaml/LICENSE','node_modules/smol-toml/LICENSE'].map(file=>{
		const content=readFileSync(new URL('../'+file,import.meta.url),'utf8').replace(/\r\n/gu,'\n');
		return file+'\n'+content.replace(/\*\//gu,'* /');
	});
	const runner='/*!\n'+notices.join('\n\n')+'\n*/\n'+cli.outputFiles[0].text;
	return {defines:{...define,KB_OFFLINE_RUNNER:JSON.stringify(runner)},metafile:cli.metafile,runner,ruleFiles:[...ruleFiles,manifestFile]};
}
