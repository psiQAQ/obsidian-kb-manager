export default function checkManifest({result: check, registration, manifest, template, inventory}, {tr, addReason}) {
	const {parsed} = manifest;
	check.coverage.checked++;
	if (!parsed) check.diagnostics.push({severity: 'error', code: 'invalid-manifest', file: 'kb.toml', message: manifest.reason});
	else if (!parsed.identity) check.diagnostics.push({severity: 'warning', code: 'legacy-identity', file: 'kb.toml', message: tr('清单没有受管知识库身份。','The manifest has no managed library identity. Review it before adopting this library.')});
	if (template.reason) {
		check.coverage.checked++;
		check.diagnostics.push({severity: 'error', code: 'invalid-template', file: 'kb-template.json', message: template.reason});
	}
	if (template.template) {
		check.coverage.checked++;
		const identity = parsed?.identity?.template;
		if (identity && identity.id !== 'unknown' && (identity.id !== template.template.id || identity.version !== template.template.version))
			check.diagnostics.push({severity: 'warning', code: 'template-version-drift', file: 'kb-template.json', message: tr('模板声明的 ID 或版本与实例清单不同。','The template ID or version differs from the library manifest. Review both files.')});
	}
	function verifyPath(file, candidates, missing) {
		if (!candidates.includes(file)) {
			const directory = inventory.unreadableDirectories.find(dir => file === dir || file.startsWith(dir + '/'));
			if (directory) {
				check.coverage.unknown++;
				const message = tr('无法扫描清单路径所在的目录。','Could not scan the directory that contains the configured path.');
				check.diagnostics.push({severity:'info', code:'manifest-path-unverified', file, evidence:directory, message});
				addReason(check, tr('部分清单路径所在的目录无法遍历。','Some configured paths are in directories that could not be scanned.'));
				return;
			}
			check.diagnostics.push({...missing, file});
		}
		check.coverage.checked++;
	}
	const entry = parsed?.identity?.entry ?? template.template?.entry;
	if (entry) verifyPath(entry, inventory.files, {severity:'error', code:'missing-entry',
		message:tr('清单指定的入口文件不存在。','The configured entry file is missing. Restore it or update its path.')});
	for (const [role, relative] of Object.entries(manifest.paths ?? {})) {
		if (relative === entry) continue;
		const candidates = ['overview','index','log'].includes(role) ? inventory.files : inventory.directories;
		verifyPath(relative, candidates, {severity:'error', code:'missing-mapping',
			message:tr('清单映射的文件或目录不存在。','The mapped file or folder is missing. Check the path in kb.toml.'), evidence:role});
	}
	if (registration.registered === undefined) {
		check.coverage.unknown++;
		addReason(check, tr('当前入口未提供 Vault 登记状态。','Run the check in the library manager to verify vault registration.'));
	} else {
		check.coverage.checked++;
		if (!registration.registered) check.diagnostics.push({severity: 'warning', code: 'unregistered-library', message: tr('当前 Vault 没有登记本库。','This library is not registered in the current vault.')});
	}
	if (registration.duplicate === undefined) {
		check.coverage.unknown++;
		addReason(check, tr('当前入口未提供知识库身份重复检查结果。','The current entry point did not provide the result of the duplicate library identity check.'));
	} else {
		check.coverage.checked++;
		if (registration.duplicate) check.diagnostics.push({severity: 'error', code: 'duplicate-library', file: 'kb.toml', message: tr('Vault 已登记另一处具有相同身份的知识库。','Another registered library has the same identity. Review the duplicate registration.')});
	}
	return check;
}
