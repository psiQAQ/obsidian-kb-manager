import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {declaration,verifyDeclaration} from '../src/kb/template-declaration.ts';
import {previousCourseworkDigests} from '../src/kb/coursework-check.ts';
import {previousTemplateCheckDigests} from '../src/kb/template-check-digests.ts';
import {segments} from '../src/fs/segments.ts';

export function templateCatalog(root){
	const packs=Object.create(null), digests=new Set([
		// The exact knowledge-garden v1 checker embedded in plugin releases 3.0.0 and 3.0.1.
		'2d3b01e0c37a95558ba2c785a3370febf7e990fad02d130169c65bea0a00bb9f',
		// Earlier checkers continue to be trusted for existing library instances.
		'4cfce7c700ad14cb9e0b28c575d7158243c99cc12e11372fb137fe4d500dff63', // ai-worklog v1
		'811fe153c69dd71d692f3f3b2ba0d285cc8f56984138832b385109b471a95f20', // llm-wiki v6
		...previousCourseworkDigests,
		'127ac61fe3c08d92fd482c1d8c4c70025e141634dcd432ad106eb5ef5d80eb00', // domain-reading v1
		'5cf311c9f4bd3b9c063cc4028f930ba602302e5128e468bdc7342eefa31a103c', // zettelkasten v1
		'a74bcdacab2e21ce1380a4c79bce9d3016f44336be4c5ccb0e5b6499a5b7b2ac', // research-evidence v1
		'a1be519840d3403df22fd0cdeb55da0bf403c5d26585b204ba6e871da80078c8', // research-project v1
		'78737124a5ed726af23a2716075ab3a80feacbbaf70c2968c717ab05939d6401', // manuscript v1
		'f4a8df186ffbc486e91967cfd5f0048299e805e5618fe4dd84e45850f8e48dfe', // worldbuilding v1
		'6bc3cc10b5e931db171727b903ad6ce0d54ca0fb65f0373e995b6e3400ab22cf', // kepano v5
		'7e9e90342c9091192d5a61d0c464a610a1046910c113f1e963b5ef185e4ab296', // project-review v1
		...Object.values(previousTemplateCheckDigests).flatMap(entry => Object.values(entry).flat()),
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
