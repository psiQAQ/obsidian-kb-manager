const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && !!value.trim();

function validFilter(value, depth = 0) {
	if (nonempty(value)) return true;
	if (depth >= 32 || !isRecord(value)) return false;
	const entries = Object.entries(value);
	if (entries.length !== 1) return false;
	const [operator, operands] = entries[0];
	return ['and','or','not'].includes(operator) && Array.isArray(operands) && operands.every(item => validFilter(item, depth + 1));
}

export default function checkBases({result: check, files, notes, noteCoverage}, {tr, addReason}) {
	let dynamicExpressions = 0;
	function inspectPaths(file, paths = []) {
		for (const {status, kind, field, line, column, expression, value} of paths) {
			const evidence = Array.from(value === undefined ? expression : JSON.stringify(value), character => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127 ? '\\u' + code.toString(16).padStart(4,'0') : character;
			}).join('');
			const position = {file,field,line,column,evidence};
			if (status === 'unverified') {
				check.coverage.unknown++;
				check.diagnostics.push({...position,severity:'info',code:'base-path-unverified',message:tr('此过滤条件的路径无法静态确认。','The filter path could not be verified statically.')});
				addReason(check,tr('部分过滤器路径需要在 Vault 中确认。','Some filter paths need to be verified in the vault.'));
				continue;
			}
			check.coverage.checked++;
			if (status === 'relative') check.diagnostics.push({...position,severity:'warning',code:'base-path-relative',message:tr(
				'Bases 路径以 Vault 根目录为基准。请检查 ./ 或 ../ 开头的路径。','Bases paths are relative to the vault root. Review the path beginning with ./ or ../.')});
			if (status === 'missing') check.diagnostics.push({...position,severity:'info',code:'base-path-missing-folder',message:kind === 'inFolder'
				? tr('Vault 中未找到过滤器指定的文件夹。','The folder used by the filter was not found in the vault.')
				: tr('Vault 中未找到此前缀指向的文件夹。','The folder used as a path prefix was not found in the vault.')});
		}
	}
	function inspect(file, base, line) {
		function fail(code, message) {check.diagnostics.push({severity:'error', code, message, file, line});}
		if (base === null) return;
		if (!isRecord(base)) {fail('base-yaml',tr('Base 文件须为有效的 YAML 映射。','Use a valid YAML mapping for the Base.')); return;}
		if (base.views !== undefined && (!Array.isArray(base.views) || !base.views.every(isRecord))) {
			fail('base-views',tr('Base 视图须为映射数组。','Define the Base views as a list of mappings.')); return;
		}
		const views = base.views ?? [];
		if (views.some(view => !nonempty(view.type) || !nonempty(view.name))) fail('base-view-identity',tr('Base 视图须声明类型和名称。','Supply a type and name for every Base view.'));
		if (base.properties !== undefined && (!isRecord(base.properties) || !Object.values(base.properties).every(isRecord)))
			fail('base-properties',tr('Base 属性配置须为映射。','Use a mapping for each Base property configuration.'));
		for (const field of ['formulas','summaries']) {
			const value = base[field];
			if (value === undefined) continue;
			if (!isRecord(value) || !Object.values(value).every(nonempty)) fail('base-expression',tr('Base 表达式须为非空字符串。','Write each Base expression as a nonempty string.'));
			else dynamicExpressions += Object.keys(value).length;
		}
		for (const scope of [base, ...views]) {
			if (scope.filters === undefined) continue;
			if (!validFilter(scope.filters)) fail('base-filter',tr('Base 过滤器须用语句或 and/or/not 的嵌套列表。','Use an expression or nested and/or/not lists for the Base filter.'));
			else dynamicExpressions++;
		}
	}
	for (const {file, data, paths, unreadable} of files) {
		if (unreadable) {
			check.coverage.unknown++;
			check.diagnostics.push({severity:'info', code:'unreadable-file', file, message:tr('文件不可读或超出检查范围限制。','Could not read the file within the scan limits.')});
			addReason(check, tr('部分检查文件未能读取。','Some files for this check could not be read.'));
		} else {
			check.coverage.checked++;
			inspect(file, data);
			inspectPaths(file, paths);
		}
	}
	check.coverage.unknown += noteCoverage.coverage.unknown;
	check.diagnostics.push(...noteCoverage.diagnostics);
	if (noteCoverage.reason) addReason(check, noteCoverage.reason);
	for (const {file, problem, blocks} of notes) {
		if (problem?.code === 'unclosed-frontmatter') {
			check.coverage.unknown++;
			const message = tr('未找到 YAML 属性的结束标记，无法检查正文中的 Base 代码块。','Could not scan the body for Base blocks because the frontmatter has no closing delimiter.');
			check.diagnostics.push({severity:'info', code:'unverified-markdown-body', file, line:problem.line, message});
			addReason(check, tr('部分 Markdown 正文无法与属性分开。','Some Markdown bodies could not be separated from their frontmatter.'));
		}
		for (const {data, line, paths} of blocks) {
			check.coverage.checked++;
			inspect(file, data, line);
			inspectPaths(file, paths);
		}
	}
	check.coverage.unknown += dynamicExpressions;
	if (dynamicExpressions) addReason(check, tr('动态表达式的运行结果须在 Obsidian 中确认。','Open the Base in Obsidian to verify the results of dynamic expressions.'));
	return check;
}
