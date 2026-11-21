import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {declaration,verifyDeclaration} from '../src/kb/template-declaration.ts';
import {segments} from '../src/fs/segments.ts';

export function templateCatalog(root){
	const packs=Object.create(null), digests=new Set([
		// The exact knowledge-garden v1 checker embedded in plugin releases 3.0.0 and 3.0.1.
		'2d3b01e0c37a95558ba2c785a3370febf7e990fad02d130169c65bea0a00bb9f',
	]);
	for(const purpose of readdirSync(root,{withFileTypes:true})){
		if(!purpose.isDirectory())throw new Error('Unexpected catalogue item: '+purpose.name);
		for(const dir of readdirSync(join(root,purpose.name),{withFileTypes:true})){
			if(!dir.isDirectory())throw new Error('Expected a template folder: '+dir.name);
			const base=join(root,purpose.name,dir.name);
			const descriptor=declaration(readFileSync(join(base,'kb-template.json'),'utf8'));
			if(descriptor.id!==dir.name || !/^[a-z0-9][a-z0-9-]*$/u.test(dir.name) || descriptor.purpose!==purpose.name ||
				!descriptor.name || !descriptor.description || !descriptor.version || !descriptor.entry || !descriptor.sources?.length || packs[dir.name])
				throw new Error('Invalid catalogue metadata: '+base);
			const text=Object.create(null), binary=Object.create(null), folders=[];
			function scan(relative){
				for(const entry of readdirSync(join(base,relative),{withFileTypes:true})){
					const path=relative?relative+'/'+entry.name:entry.name;
					if(path==='kb.toml')continue; // Instance manifests are local, including those left in an author's folder.
					if(!['.gitignore','.gitkeep','.gitattributes'].includes(entry.name))segments(entry.name);
					if(entry.isDirectory()){folders.push(path);scan(path);continue;}
					if(!entry.isFile())throw new Error('Unsupported resource: '+path);
					const bytes=readFileSync(join(base,path));
					if(/\.(?:md|base|canvas|json|toml|mjs|txt|ya?ml|css)$/iu.test(path) || entry.name.startsWith('.')){
						const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
						text[path]=source.replace(/\r\n/gu,'\n');
					}else binary[path]=bytes.toString('base64');
				}
			}
			scan('');
			verifyDeclaration(descriptor,[...Object.keys(text),...Object.keys(binary)],folders);
			for(const check of descriptor.checks??[])digests.add(createHash('sha256').update(text[check.path]).digest('hex'));
			packs[dir.name]={descriptor,text,binary,folders};
		}
	}
	return {packs,digests:[...digests].sort()};
}
