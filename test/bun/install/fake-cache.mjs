// stands in for `@actions/cache` inside child processes; see `child-setup.mjs`.
// behavior is driven by env vars, and every call is appended to `$FAKE_CACHE_LOG` as a JSON line.
import { appendFileSync } from 'fs';

/** @param {string} fn @param {unknown[]} args */
function record(fn, args) {
	if (process.env.FAKE_CACHE_LOG) {
		appendFileSync(process.env.FAKE_CACHE_LOG, `${JSON.stringify({ fn, args })}\n`);
	}
}

/** @type {(paths: string[], key: string) => Promise<string | undefined>} */
export async function restoreCache(paths, key) {
	record('restoreCache', [paths, key]);
	const mode = process.env.FAKE_CACHE_RESTORE || 'miss';
	if (mode === 'reject') {
		throw new Error('fake restoreCache failure');
	}
	if (mode.startsWith('hit:')) {
		return mode.slice('hit:'.length);
	}
	return undefined;
}

/** @type {(paths: string[], key: string) => Promise<number>} */
export async function saveCache(paths, key) {
	record('saveCache', [paths, key]);
	if (process.env.FAKE_CACHE_SAVE === 'reject') {
		throw new Error('fake saveCache failure');
	}
	return 42;
}
