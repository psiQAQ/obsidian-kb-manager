export default function checkBindings({result: check, manifest, bindings, libraryPath}, {tr}) {
	if (!manifest.parsed) {
		check.coverage.unknown++;
		check.reason = manifest.reason;
		return check;
	}
	for (const {path, fingerprint, root, status, digest} of bindings) {
		if (status === 'readable') {
			check.coverage.checked++;
			if (digest !== fingerprint) check.diagnostics.push({severity:'warning', code:'binding-drift', file:path, message:tr('受管文件内容与登记指纹不同，请复核绑定。','The managed file differs from its saved fingerprint. Review its bindings.')});
			if (root && libraryPath !== undefined && root !== libraryPath)
				check.diagnostics.push({severity:'warning', code:'binding-root-drift', file:path, message:tr('受管绑定仍记录其他 Vault 路径。','The managed binding still records a different vault path. Review it before repairing the binding.')});
			if (root && libraryPath === undefined) check.coverage.unknown++;
		} else {
			const missing = status === 'missing';
			check.coverage[missing ? 'checked' : 'unknown']++;
			check.diagnostics.push({severity:missing ? 'warning' : 'info', code:missing ? 'missing-binding' : 'binding-unverified',
				file:path, message:missing ? tr('清单登记的受管文件缺失。','The managed file in the manifest is missing. Restore it or review its binding.') :
					tr('无法核对受管文件。','Could not verify the managed file. Check its path and permissions.')});
		}
	}
	if (check.coverage.unknown) check.reason = tr('受管文件不可读或当前入口没有提供 Vault 相对位置。','Some managed files were unreadable or their vault-relative location was unavailable.');
	return check;
}
