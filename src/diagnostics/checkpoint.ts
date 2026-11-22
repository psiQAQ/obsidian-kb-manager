import {setTimeout} from 'node:timers/promises';

/** Let desktop input and unload run between CPU-bound units of evidence. */
export function diagnosticCheckpoint(signal?: AbortSignal) {
	if (!signal) return;
	let nextYield = performance.now() + 16;
	return () => {
		signal.throwIfAborted();
		if (performance.now() < nextYield) return;
		nextYield = performance.now() + 16;
		return setTimeout(0, undefined, {signal});
	};
}
