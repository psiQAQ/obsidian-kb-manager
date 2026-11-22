import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {runDiagnostics} from '../src/diagnostics/index.ts';
import {checkKitFiles,checkKitVersion} from '../src/kb/check-kit.ts';
import {writeCheckKit} from '../src/kb/identity-core.ts';

const markdown = '---\nstatus: ready\n---\n# Benchmark note\n' + 'Plain text.\n'.repeat(680);
const repetitions = 5;
const open = fs.open;
const readdir = fs.readdir;
const workspace = path.resolve('.tmp');
await fs.mkdir(workspace,{recursive:true});
const fixture = await fs.mkdtemp(path.join(workspace,'diagnostic-benchmark-'));
const read = {directories:0,files:0,markdown:0};
fs.open = async (file,flags,...args) => {
	if (typeof flags === 'number') {
		read.files++;
		if (file.endsWith('.md')) read.markdown++;
	}
	return open(file,flags,...args);
};
fs.readdir = async (...args) => {
	read.directories++;
	return readdir(...args);
};
syncBuiltinESMExports();

try {
	const paths = Array.from({length:100},(_,index)=>'registered-'+index);
	await Promise.all(paths.map(location=>fs.mkdir(path.join(fixture,location))));
	const rows = [];
	for (const kit of [false,true]) {
		const target = kit ? 'installed' : 'legacy';
		const root = path.join(fixture,target);
		await fs.mkdir(path.join(root,'notes'),{recursive:true});
		const manifest = 'version = 2\n[paths]\nnotes = "notes"\n';
		const files = kit ? Object.entries(checkKitFiles()) : [];
		for (const [file,source] of files) {
			const destination = path.join(root,file);
			await fs.mkdir(path.dirname(destination),{recursive:true});
			await fs.writeFile(destination,source);
		}
		const digests = Object.fromEntries(files.map(([file,source])=>[file,createHash('sha256').update(source).digest('hex')]));
		await fs.writeFile(path.join(root,'kb.toml'),kit ? writeCheckKit(manifest,{protocol:1,version:checkKitVersion,digests}) : manifest);
		await Promise.all(paths.map((_,i)=>fs.writeFile(path.join(root,'notes',i+'.md'),markdown)));
		for (const count of [0,10,100]) for (const selected of [['manifest'],['manifest','properties']]) {
			const durations = [];
			const counts = [];
			for (let attempt=0; attempt<=repetitions; attempt++) {
				Object.assign(read,{directories:0,files:0,markdown:0});
				const start = performance.now();
				const report = await runDiagnostics({libraryRoot:root,vaultRoot:fixture,registered:true,duplicate:false,
					registeredPaths:[target,...paths.slice(0,count)],selected,nodeExecutable:process.execPath});
				const ms = performance.now() - start;
				assert.ok(report.logPath,report.logError);
				assert.ok(report.checks.every(check=>check.status==='passed'||check.status==='findings'),JSON.stringify(report.checks));
				await fs.unlink(path.join(root,report.logPath));
				if (attempt) {
					durations.push(ms);
					counts.push({...read});
				}
			}
			for (const count of counts) assert.deepEqual(count,counts[0]);
			durations.sort((a,b)=>a-b);
			rows.push({target, otherRegistered:count, selected:selected.join(','), ...counts[0], medianMs:Number(durations[2].toFixed(2))});
		}
	}
	process.stdout.write(JSON.stringify({node:process.version, platform:process.platform, markdownBytes:Buffer.byteLength(markdown),repetitions, rows},null,2)+'\n');
} finally {
	fs.open = open;
	fs.readdir = readdir;
	syncBuiltinESMExports();
	assert.equal(path.dirname(path.resolve(fixture)),workspace);
	await fs.rm(fixture,{recursive:true,force:true});
}
