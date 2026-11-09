import * as core from '@actions/core';

import { failureMessage, installationToken, octokitFor } from '../lib/app.mjs';
import { optionalFailures } from '../lib/ci.mjs';

/** @import { RepoState, appAuth } from '../lib/app.mjs' */
/** @import { OptionalFailure } from '../lib/ci.mjs' */
/** @typedef {ReturnType<typeof appAuth>} Auth */
/**
 * What CI on a repository's default branch's tip (`head`) shows: each job whose failures `continue-on-error` hides (`jobs`: see `optionalFailures`); or, when it couldn't be read, `error`.
 * @typedef {{ repository: string, private: boolean, head: string, jobs: OptionalFailure[] } | { repository: string, private: boolean, error: string }} Checked
 */

// reading a branch's tip, and every check suite, check run (and its annotations), workflow run and job, and commit status on it
/** @type {Record<string, string>} */
export const permissions = {
	contents: 'read',
	metadata: 'read',
	checks: 'read',
	actions: 'read',
	statuses: 'read',
};

/**
 * `state`'s default branch's tip, and the failures CI on it has that `continue-on-error` hides.
 * An error can quote what it couldn't read, so only its HTTP status is kept (see `failureMessage`).
 * @type {(octokit: ReturnType<typeof octokitFor>, state: RepoState) => Promise<Checked>}
 */
async function checkRepo(octokit, state) {
	const base = { repository: state.repository, private: state.private };
	try {
		const { data: ref } = await octokit.rest.git.getRef({
			owner: state.owner,
			repo: state.name,
			ref: `heads/${state.defaultBranch}`,
		});
		const head = ref.object.sha;
		return {
			...base,
			head,
			jobs: await optionalFailures(octokit, {
				owner: state.owner,
				name: state.name,
				head,
			}),
		};
	} catch (error) {
		return { ...base, error: failureMessage(error) };
	}
}

/**
 * For each of `states`, what CI on its default branch's tip shows (see `Checked`), in their order; a state that couldn't be read at all is only its `stateError`.
 * Each installation's token can only read, and is made once; a fork's source is read with its fork's installation's (see `RepoState`), as any public repository can be.
 * One repository at a time, to stay clear of secondary rate limits, with private ones quiet (see `octokitFor`), and last, so that where one would fall among the public ones, or how long one took, isn't shown.
 * @type {(auth: Auth, states: RepoState[]) => Promise<Checked[]>}
 */
export async function checkRepos(auth, states) {
	/** @type {Map<number, Promise<string>>} */
	const tokens = new Map();
	/** @type {(installationId: number) => Promise<string>} */
	const tokenFor = (installationId) => {
		const token = tokens.get(installationId) ?? installationToken(auth, installationId, { permissions }).then((t) => {
			core.setSecret(t);
			return t;
		});
		tokens.set(installationId, token);
		return token;
	};
	const ordered = states.filter((s) => !s.private).concat(states.filter((s) => s.private));
	/** @type {Map<RepoState, Checked>} */
	const checked = new Map();
	await ordered.reduce(
		async (previous, state) => {
			await previous;
			const base = { repository: state.repository, private: state.private };
			const result = state.stateError
				? { ...base, error: state.stateError }
				: await tokenFor(state.installationId).then(
					(token) => checkRepo(octokitFor(token, state.private), state),
					(error) => ({ ...base, error: failureMessage(error) }),
				);
			checked.set(state, result);
		},
		Promise.resolve(),
	);
	return states.map((state) => /** @type {Checked} */ (checked.get(state)));
}
