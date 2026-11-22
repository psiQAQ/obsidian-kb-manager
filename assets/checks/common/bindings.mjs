export default function checkBindings({result: check, manifest, bindings, libraryPath}, {tr}) {
	if (!manifest.parsed) {
		check.coverage.unknown++;
		check.reason = manifest.reason;
		return check;
	}
	for (const {path, fingerprint, root, status, digest, verification, evidence} of bindings) {
		if (status === 'readable') {
			const binding = verification ?? (digest === fingerprint ? 'verified' : 'unknown');
			check.coverage[binding === 'unknown' ? 'unknown' : 'checked']++;
			if (binding === 'changed') check.diagnostics.push({severity:'warning', code:'binding-drift', file:path, evidence, message:tr('受管路径绑定已经改变或目标不可用，请检查原位置的链接或过滤器。','A managed path binding changed or its target is missing. Check the original link or filter.')});
			if (binding === 'unknown') check.diagnostics.push({severity:'info', code:'binding-unverified', file:path, message:tr('缺少可核对的原始版本，或当前格式无法验证绑定。','Could not verify the binding from the available original version and supported file syntax.')});
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
	if (check.coverage.unknown) check.reason = tr('部分受管绑定需要可读文件、可核对的原始版本或 Vault 相对位置才能验证。','Some managed bindings need readable files, a verifiable original version, or a vault-relative location.');
	return check;
}
