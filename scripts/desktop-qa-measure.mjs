// Prepended to the isolated plugin copy before the bundle imports Node's fs.
export function instrumentVault(root, importModule) {
	const fs = importModule('node:fs/promises');
	const path = importModule('node:path');
	let phase;
	const measurement = {
		begin() { phase = { started: performance.now(), operations: {}, reads: {} }; },
		observeRegistry(adapter, relative) {
			const read = adapter.read;
			adapter.read = async function (filename, ...args) {
				const record = filename === relative && track('adapter.read', path.join(root, filename));
				const data = await read.call(this, filename, ...args);
				if (record) record(Buffer.byteLength(data));
				return data;
			};
		},
		snapshot() {
			return {
				ms: Math.round((performance.now() - phase.started) * 10) / 10,
				operations: Object.fromEntries(Object.entries(phase.operations).sort()),
				reads: Object.fromEntries(Object.entries(phase.reads).sort()),
			};
		},
	};

	function track(method, filename) {
		if (!phase || typeof filename !== 'string') return;
		const relative = path.relative(root, filename);
		if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
		const current = phase;
		current.operations[method] = (current.operations[method] ?? 0) + 1;
		const key = relative.split(path.sep).join('/');
		return bytes => {
			const entry = current.reads[key] ??= { calls: 0, bytes: 0 };
			entry.calls++;
			entry.bytes += bytes;
		};
	}

	for (const method of ['lstat', 'stat', 'realpath', 'readdir', 'readFile', 'open']) {
		const original = fs[method];
		fs[method] = async function (filename, ...args) {
			const record = track(method, filename);
			const result = await original.call(this, filename, ...args);
			if (record && method === 'readFile') record(Buffer.byteLength(result));
			if (record && method === 'open') {
				for (const operation of ['read', 'readFile']) {
					const read = result[operation];
					result[operation] = async function (...parameters) {
						const recordRead = track('FileHandle.' + operation, filename);
						const data = await read.apply(this, parameters);
						recordRead?.(operation === 'read' ? data.bytesRead : Buffer.byteLength(data));
						return data;
					};
				}
			}
			return result;
		};
	}
	window.kbDesktopMeasurements = measurement;
}
