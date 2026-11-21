import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function findLocalExecutable(name: string, roots: readonly (string | undefined)[], override?: string) {
	const excluded = new Set<string>();
	for (const root of new Set(roots)) {
		if (!root) continue;
		excluded.add(root);
		excluded.add(await fs.realpath(root));
	}
	function isExcluded(filename: string) {
		for (const root of excluded) {
			const relative = path.relative(root, filename);
			if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return true;
		}
		return false;
	}

	const basename = process.platform === 'win32' ? name + '.exe' : name;
	const candidates = override ? [override] : (process.env.PATH ?? '').split(path.delimiter)
		.map(folder => folder.replace(/^"|"$/gu, '')).filter(folder => path.isAbsolute(folder))
		.map(folder => path.join(folder, basename));
	for (const filename of candidates) {
		if (!path.isAbsolute(filename) || isExcluded(filename)) continue;
		try {
			const real = await fs.realpath(filename);
			if (isExcluded(real) || !(await fs.stat(real)).isFile()) continue;
			await fs.access(real, fs.constants.X_OK);
			return real;
		} catch {/* Continue searching absolute executable paths. */}
	}
	return undefined;
}
