import * as core from '@actions/core';

import {
	appOctokit,
	failureMessage,
	installationToken,
	octokitFor,
} from '../lib/app.mjs';
import { botBranches } from '../lib/branches.mjs';
import { isIgnored } from '../lib/ignored.mjs';
import { awaitingApproval } from '../lib/installations.mjs';

/** @import { Octokit } from '../lib/app.mjs' */
/** @typedef {ReturnType<typeof import('../lib/app.mjs').appAuth>} Auth */
/** @typedef {{ owner: string, name: string, repository: string, private: boolean, installationId: number }} Repo */

const batchSize = 20;

/** @type {(error: unknown) => Record<string, any>} */
function partialData(error) {
	if (error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object') {
		return /** @type {Record<string, any>} */ (error.data);
	}
	throw error;
}

/**
 * Of `repos`, the ones not archived, nor forks, with an open PR from one of the App's branches: by how many PRs each has open from each, which GraphQL counts in one query for many repositories.
 * @type {(octokit: Octokit, repos: { name: string, full_name: string, private: boolean, owner: { login: string } }[]) => Promise<typeof repos>}
 */
async function withAppPRs(octokit, repos) {
	/** @type {typeof repos} */
	const found = [];
	for (let i = 0; i < repos.length; i += batchSize) {
		const batch = repos.slice(i, i + batchSize);
		const variables = {
			...Object.fromEntries(batch.flatMap((r, j) => [[`o${j}`, r.owner.login], [`n${j}`, r.name]])),
			...Object.fromEntries(botBranches.map((branch, k) => [`b${k}`, branch])),
		};
		const repoIndices = [...batch.keys()];
		const branchIndices = [...botBranches.keys()];
		const counts = branchIndices.map((k) => `p${k}: pullRequests(states: OPEN, headRefName: $b${k}) { totalCount }`).join(' ');
		const text = `query(${[...repoIndices.map((j) => `$o${j}: String!, $n${j}: String!`), ...branchIndices.map((k) => `$b${k}: String!`)].join(', ')}) {
			${repoIndices.map((j) => `r${j}: repository(owner: $o${j}, name: $n${j}) { isArchived isFork ${counts} }`).join('\n')}
		}`;
		// a repository that can't be read is in the partial data as `null`, and only it is skipped
		const data = await octokit.graphql(text, variables).catch(partialData); // eslint-disable-line no-await-in-loop
		found.push(...repoIndices.filter((j) => {
			const repo = data[`r${j}`];
			return repo && !repo.isArchived && !repo.isFork && branchIndices.some((k) => repo[`p${k}`]?.totalCount > 0);
		}).map((j) => batch[j]));
	}
	return found;
}

// quiet, since it lists private repositories too
/** @type {(token: string) => Octokit} */
function getReader(token) {
	core.setSecret(token);
	return octokitFor(token, true);
}

// what finding the repositories needs
/** @type {Record<string, string>} */
const readPermissions = { metadata: 'read', pull_requests: 'read' }; // eslint-disable-line camelcase

/**
 * Every repository the App is installed on, in `accounts`, that isn't archived, ignored, or a fork, and has an open PR from one of the App's branches; and how many installations couldn't be read.
 * An installation that's waiting on its account to approve the permissions finding them needs, or `needs` (what's then done with them), is skipped, and isn't a failure; one lacking any the App itself doesn't have is (see `awaitingApproval`).
 * @type {(auth: Auth, accounts: Set<string>, needs: Record<string, string>) => Promise<{ repos: Repo[], failures: number }>}
 */
export async function reposWithAppPRs(auth, accounts, needs) {
	const app = await appOctokit(auth);
	const installations = (await app.paginate('GET /app/installations', { per_page: 100 })) // eslint-disable-line camelcase
		.filter((i) => !i.suspended_at && accounts.has(String(i.account && 'login' in i.account ? i.account.login : '').toLowerCase()));
	const { ready, failures: unavailable } = await awaitingApproval(app, installations, { ...readPermissions, ...needs });
	unavailable.forEach(({ scope, message }) => {
		core.warning(`${scope}: ${message}`);
	});
	// one installation at a time, each awaiting the one before
	/** @type {Promise<{ repos: Repo[], failures: number }>} */
	const initial = Promise.resolve({
		repos: [],
		failures: unavailable.length,
	});
	return ready.reduce(async (previous, installation) => {
		const { repos, failures } = await previous;
		try {
			const octokit = getReader(await installationToken(auth, installation.id, { permissions: readPermissions }));
			const installed = (await octokit.paginate('GET /installation/repositories', { per_page: 100 })).filter((r) => !isIgnored(r.full_name)); // eslint-disable-line camelcase
			return {
				repos: repos.concat((await withAppPRs(octokit, installed)).map((r) => ({
					owner: r.owner.login,
					name: r.name,
					repository: r.full_name,
					private: r.private,
					installationId: installation.id,
				}))),
				failures,
			};
		} catch (error) {
			core.warning(`installation ${installation.id} ${failureMessage(error)}`);
			return {
				repos,
				failures: failures + 1,
			};
		}
	}, initial);
}
