export default function checkProperties({result: check, notes, templateDirs}, {tr, addReason}) {
	for (const note of notes) {
		if (note.problem?.dynamic && templateDirs.some(dir => note.path.startsWith(dir + '/'))) {
			check.coverage.unknown++;
			addReason(check, tr('有模板的属性只有在实际插入时才能验证。','Check template properties after inserting the template into a note.'));
			continue;
		}
		check.coverage.checked++;
		if (note.problem) check.diagnostics.push({severity: 'error', code: note.problem.code, line: note.problem.line,
			file: note.path, message: tr('Markdown 的 YAML 属性无效。','The Markdown frontmatter contains invalid YAML. Check the indicated line.')});
	}
	return check;
}
