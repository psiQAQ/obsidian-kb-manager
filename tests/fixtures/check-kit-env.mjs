import {readFileSync} from 'node:fs';

// Node's test process needs the same injected constants as the esbuild bundle.
Object.assign(globalThis,JSON.parse(readFileSync(new URL('../../.tmp/test-kit.json',import.meta.url),'utf8')));
