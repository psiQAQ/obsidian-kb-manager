import {resolve} from 'node:path';
import process from 'node:process';
import {tr} from '../i18n.ts';
import {officialCheckDigests} from '../kb/template-pack.ts';
import {listCommonChecks, listDiagnosticHistory, listSpecialChecks, runDiagnostics} from './index.ts';
import type {DiagnosticOptions} from './index.ts';
import {defaultConfigDir} from '../fs/segments.ts';
import {checkIdPattern, libraryLocation, validConfigDir} from './snapshot.ts';

const usage = 'node kb-check.cjs --help\nnode kb-check.cjs --library <path> [--vault-root <path>] [--config-dir <name>] [--checks all|id,id,...] [--trust-digest <sha256>] [--list|--history]';
const valueFlags=new Set(['--library','--vault-root','--config-dir','--checks','--trust-digest']);

// Keep command-line errors independent of the actual values supplied, which can contain secrets.
class CliInputError extends Error {}

function args(argv: readonly string[]) {
	const options: DiagnosticOptions = {libraryRoot:'', configDir:defaultConfigDir, nodeExecutable:process.execPath};
	const trusted: string[] = [];
	let mode: 'run' | 'history' | 'list' | 'help' = 'run';
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--help' || flag === '--list' || flag === '--history') {
			if (mode !== 'run') throw new CliInputError(tr('--help、--list 和 --history 只能指定一项。',
				'Specify only one of --help, --list, and --history.'));
			mode = flag === '--help' ? 'help' : flag === '--list' ? 'list' : 'history';
			continue;
		}
		if (!flag || !valueFlags.has(flag)) throw new CliInputError(tr('检测到未知选项。请使用 --help 查看支持的选项。',
			'Unknown option. Use --help to see supported options.'));
		const value = argv[++i];
		if (!value || value.startsWith('--')) throw new CliInputError(tr(`${flag} 缺少参数值。`,`Missing value for ${flag}.`));
		switch (flag) {
		case '--library': options.libraryRoot = resolve(value); break;
		case '--vault-root': options.vaultRoot = resolve(value); break;
		case '--config-dir':
			if (!validConfigDir(value)) throw new CliInputError(tr('--config-dir 必须是单个有效的目录名称。',
				'--config-dir must be a single valid directory name.'));
			options.configDir = value; break;
		case '--checks': {
			const ids = value.split(',');
			if (ids.length > 64 || ids.some(id => !checkIdPattern.test(id))) throw new CliInputError(tr(
				'--checks 应为 all 或由逗号分隔的 1 至 64 个合法检验 ID。','--checks expects all or a comma-separated list of 1 to 64 valid check IDs.'));
			options.selected = value === 'all' ? 'all' : ids; break;
		}
		case '--trust-digest':
			if (!/^[a-f0-9]{64}$/iu.test(value)) throw new CliInputError(tr('--trust-digest 应为 64 位十六进制 SHA-256 摘要。',
				'--trust-digest expects a 64-character hexadecimal SHA-256 digest.'));
			trusted.push(value.toLowerCase()); break;
		}
	}
	if (mode !== 'help' && !options.libraryRoot) throw new CliInputError(tr('请使用 --library 指定知识库目录。',
		'Specify a library folder with --library.'));
	return {mode, options:{...options, trustedDigests:trusted, officialDigests:officialCheckDigests()}};
}

function locationError(error:unknown) {
	if (!(error instanceof Error)) return undefined;
	switch (error.message) {
	case 'invalid-root': return tr('--library 必须指向实际目录。','--library must point to a real directory.');
	case 'outside-vault': return tr('--library 必须位于 Vault 内且在配置目录之外。','--library must be inside the vault and outside its configuration directory.');
	case 'invalid-config-directory': return tr('--config-dir 不是有效的目录名称。','--config-dir is not a valid directory name.');
	}
	switch ('code' in error ? error.code : undefined) {
	case 'ENOENT': case 'ENOTDIR':
		return tr('找不到指定的知识库或 Vault 目录。','The specified library or vault folder does not exist.');
	case 'EACCES': case 'EPERM':
		return tr('无法访问指定的知识库或 Vault 目录。','Permission denied accessing the specified library or vault folder.');
	case 'ELOOP':
		return tr('指定目录包含无法解析的链接。','The specified folder contains an unresolvable link.');
	}
	return undefined;
}

export async function runCli(argv: readonly string[]) {
	try {
		const {mode, options} = args(argv);
		if (mode === 'help') return {code:0, payload:{schemaVersion:1, usage}};
		if (mode === 'history' || mode === 'list') {
			const {root} = await libraryLocation(options).catch((error:unknown)=>{
				const message=locationError(error);
				if(message)throw new CliInputError(message);
				throw error;
			});
			const data = mode === 'history' ? {reports:await listDiagnosticHistory(root)} : {...await listSpecialChecks(root), common:await listCommonChecks(root)};
			return {code:0, payload:{schemaVersion:1, ...data}};
		}
		const report = await runDiagnostics(options);
		const code = report.status === 'failed' || report.logError || report.checks.some(check => check.diagnostics.some(item => item.code === 'checker-untrusted')) ? 2 :
			report.checks.some(check => check.diagnostics.some(item => item.severity === 'error')) ? 1 : 0;
		return {code, payload:report};
	} catch (error) {
		const message=error instanceof CliInputError ? error.message : tr('无法处理命令行请求。','Could not process the command-line request.');
		return {code:2, payload:{schemaVersion:1, status:'failed', error:message, usage}};
	}
}

if (typeof require !== 'undefined' && require.main === module) {
	void runCli(process.argv.slice(2)).then(({code,payload}) => {
		process.stdout.write(JSON.stringify(payload) + '\n');
		process.exitCode = code;
	});
}
