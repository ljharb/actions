import npa from 'npm-package-arg';
import registryFetch from 'npm-registry-fetch';

import { isCovered, packageName } from './check.mjs';

/** @import { RepoState } from '../lib/app.mjs' */
/** @typedef {Record<string, unknown>} FetchOptions */

// what `npm` itself retries a registry request with, by default
const retries = {
	fetchRetries: 2,
	fetchRetryFactor: 10,
	fetchRetryMintimeout: 10000,
	fetchRetryMaxtimeout: 60000,
};

// the abbreviated packument, as `npm install` asks for: far smaller, and it still lists every version
const accept = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

// how many packages are looked up at once
const concurrency = 10;

// the registry's errors aren't quoted, since a private repository's row could be anyone's
export const lookupError = 'whether its package is on npm could not be told';

/**
 * Whether `name` is on npm: whether its packument has any version. A name the registry doesn't know (an HTTP 404), or one npm can't take, was never published; any other failure, after npm-registry-fetch's retries, rejects.
 * @type {(name: string, options?: FetchOptions) => Promise<boolean>}
 */
export async function isOnNpm(name, options = {}) {
	const { escapedName } = npa(name);
	// `npa` doesn't read a name npm can't take (eg, `.pkg`) as a package's, so has no path for it
	if (!escapedName) {
		return false;
	}
	try {
		const packument = await registryFetch.json(`/${escapedName}`, {
			...retries,
			...options,
			headers: { accept },
		});
		return Object.keys(Object(packument.versions)).length > 0;
	} catch (error) {
		if (Object(error).statusCode === 404) {
			return false;
		}
		throw error;
	}
}

/**
 * The package name a covered state is looked up by: none when its state couldn't be read, which is already its error.
 * @type {(state: RepoState) => string | null}
 */
function lookedUp(state) {
	return state.stateError ? null : packageName(state.packageJson).name;
}

/**
 * The states the README drift report covers (see `isCovered`), less each whose package isn't on npm (see `isOnNpm`), which has no npm badges to show; each distinct name is looked up once, `concurrency` at a time.
 * One whose package couldn't be looked up is covered, with that as its `stateError`, so that it's reported, and `/fix` fails it, as one whose state couldn't be read.
 * @type {(states: RepoState[], options?: FetchOptions) => Promise<RepoState[]>}
 */
export async function coveredStates(states, options) {
	const covered = states.filter(isCovered);
	const names = Array.from(new Set(covered.map(lookedUp).filter((name) => name !== null)));
	/** @type {Map<string, boolean | null>} */
	const onNpm = new Map();
	/** @type {(name: string) => Promise<void>} */
	async function lookUp(name) {
		onNpm.set(name, await isOnNpm(name, options).catch(() => null));
	}
	const chunks = Array.from({ length: Math.ceil(names.length / concurrency) }, (_, i) => names.slice(i * concurrency, (i + 1) * concurrency));
	await chunks.reduce(
		async (previous, chunk) => {
			await previous;
			await Promise.all(chunk.map(lookUp));
		},
		Promise.resolve(),
	);
	return covered.flatMap((state) => {
		const name = lookedUp(state);
		const published = name === null ? true : onNpm.get(name);
		if (published === false) {
			return [];
		}
		return published === null ? [{ ...state, stateError: lookupError }] : [state];
	});
}
