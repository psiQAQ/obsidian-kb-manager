import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {templateCatalog} from './template-catalog.mjs';
import {buildCheckKit} from './build-check-kit.mjs';

const {digests}=templateCatalog(fileURLToPath(new URL('../assets/templates/',import.meta.url)));
const {defines}=await buildCheckKit(digests);
mkdirSync('.tmp',{recursive:true});
writeFileSync('.tmp/test-kit.json',JSON.stringify(Object.fromEntries(
	Object.entries(defines).map(([key,value])=>[key,JSON.parse(value)]))));
