import {resolve} from 'node:path';
import process from 'node:process';
import {tr} from '../i18n.ts';
import {officialCheckDigests} from '../kb/template-pack.ts';
import {listDiagnosticHistory, listSpecialChecks, runDiagnostics} from './index.ts';
import type {DiagnosticOptions} from './index.ts';
import {checkIdPattern, defaultConfigDir, validConfigDir} from './snapshot.ts';

const usage = 'node kb-check.cjs --library <path> [--vault-root <path>] [--config-dir <name>] [--checks all|id,id,...] [--trust-digest <sha256>] [--list|--history]';

function args(argv: readonly string[]) {
	const options: DiagnosticOptions = {libraryRoot:'', configDir:defaultConfigDir, nodeExecutable:process.execPath};
	const trusted: string[] = [];
	let mode: 'run' | 'history' | 'list' | 'help' = 'run';
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--help' || flag === '--list' || flag === '--history') {
			if (mode !== 'run') throw new Error('command');
			mode = flag === '--help' ? 'help' : flag === '--list' ? 'list' : 'history';
			continue;
		}
		const value = argv[++i];
		if (!value || value.startsWith('--')) throw new Error('missing value');
		switch (flag) {
		case '--library': options.libraryRoot = resolve(value); break;
		case '--vault-root': options.vaultRoot = resolve(value); break;
		case '--config-dir':
			if (!validConfigDir(value)) throw new Error('config dir');
			options.configDir = value; break;
		case '--checks': {
			const ids = value.split(',');
			if (ids.length > 64 || ids.some(id => !checkIdPattern.test(id))) throw new Error('check list');
			options.selected = value === 'all' ? 'all' : ids; break;
		}
		case '--trust-digest':
			if (!/^[a-f0-9]{64}$/iu.test(value)) throw new Error('digest');
			trusted.push(value.toLowerCase()); break;
		default: throw new Error('unknown flag');
		}
	}
	if (mode !== 'help' && !options.libraryRoot) throw new Error('missing library');
	return {mode, options:{...options, trustedDigests:trusted, officialDigests:officialCheckDigests()}};
}

export async function runCli(argv: readonly string[]) {
	try {
		const {mode, options} = args(argv);
		if (mode === 'help') return {code:0, payload:{schemaVersion:1, usage}};
		if (mode === 'history') return {code:0, payload:{schemaVersion:1, reports:await listDiagnosticHistory(options.libraryRoot)}};
		if (mode === 'list') return {code:0, payload:{schemaVersion:1, ...await listSpecialChecks(options.libraryRoot)}};
		const report = await runDiagnostics(options);
		const code = report.status === 'failed' || report.logError || report.checks.some(check => check.diagnostics.some(item => item.code === 'checker-untrusted')) ? 2 :
			report.checks.some(check => check.diagnostics.some(item => item.severity === 'error')) ? 1 : 0;
		return {code, payload:report};
	} catch {return {code:2, payload:{schemaVersion:1, status:'failed', error:tr('无法处理命令行请求。','Could not process the command-line request.'), usage}};}
}

if (typeof require !== 'undefined' && require.main === module) {
	void runCli(process.argv.slice(2)).then(({code,payload}) => {
		process.stdout.write(JSON.stringify(payload) + '\n');
		process.exitCode = code;
	});
}
