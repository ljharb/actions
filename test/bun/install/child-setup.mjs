// preloaded (via `--import`) into the child processes that run the actions under test.
// importing this module has no side effects; `setup` must be called explicitly.
import { registerHooks } from 'module';

const fakeCacheURL = new URL('fake-cache.mjs', import.meta.url).href;

/** @param {{ fakeCache?: boolean }} [options] */
export async function setup({ fakeCache = false } = {}) {
	const { default: nock } = await import('nock');
	nock.disableNetConnect();

	if (fakeCache) {
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === '@actions/cache') {
					return { url: fakeCacheURL, shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
		});
	}
}
