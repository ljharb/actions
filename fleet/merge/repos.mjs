import * as core from '@actions/core';

import {
	appOctokit,
	failureMessage,
	installationToken,
	isTransient,
	octokitFor,
} from '../lib/app.mjs';
import { botBranches } from '../lib/branches.mjs';
import { isIgnored } from '../lib/ignored.mjs';
import { awaitingApproval } from '../lib/installations.mjs';

/** @import { Octokit, appAuth } from '../lib/app.mjs' */
/** @typedef {ReturnType<typeof appAuth>} Auth */
/** @typedef {{ owner: string, name: string, repository: string, private: boolean, installationId: number }} Repo */

const batchSize = 20;

/** @type {(value: unknown) => value is Record<string, unknown>} */
function isObject(value) {
	return !!value && typeof value === 'object';
}

/** @type {(error: unknown) => Record<string, unknown>} */
function partialData(error) {
	// GitHub's "Something went wrong while executing your query" is retried as a server error (see `octokitFor`), whose error has the last attempt's partial data only on its response
	/** @type {{ data?: unknown, response?: { data?: { data?: unknown } } }} */
	const failure = Object(error);
	const partial = 'data' in failure ? failure.data : failure.response?.data?.data;
	if (isObject(partial)) {
		return partial;
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
		const repoIndices = Array.from(batch.keys());
		const branchIndices = Array.from(botBranches.keys());
		const counts = branchIndices.map((k) => `p${k}: pullRequests(states: OPEN, headRefName: $b${k}) { totalCount }`).join(' ');
		const text = `query(${repoIndices.map((j) => `$o${j}: String!, $n${j}: String!`).concat(branchIndices.map((k) => `$b${k}: String!`)).join(', ')}) {
			${repoIndices.map((j) => `r${j}: repository(owner: $o${j}, name: $n${j}) { isArchived isFork ${counts} }`).join('\n')}
		}`;
		// a repository that can't be read is in the partial data as `null`, and only it is skipped
		const data = await octokit.graphql(text, variables).catch(partialData); // eslint-disable-line no-await-in-loop
		repoIndices.filter((j) => {
			const repo = data[`r${j}`];
			return repo && !repo.isArchived && !repo.isFork && branchIndices.some((k) => repo[`p${k}`]?.totalCount > 0);
		}).forEach((j) => {
			found.push(batch[j]);
		});
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

// reading an installation only reads, so when GitHub fails it (see `isTransient`), even once each request was retried (see `retry` in `../lib/app.mjs`), it's read again, twice at most: each read's own retries wait seconds, so a failure that outlasts them is often over by the next read, but one that outlasts three reads would only hold up the run, and the next run (in 10 minutes) reads it again anyway
const installationReads = 3;

/**
 * The repositories of the installation `installationId` that have an open PR from one of the App's branches (see `withAppPRs`), read again while GitHub fails it (see `installationReads`).
 * @type {(auth: Auth, installationId: number, reads?: number) => Promise<Repo[]>}
 */
async function readInstallation(auth, installationId, reads = 1) {
	try {
		const octokit = getReader(await installationToken(auth, installationId, { permissions: readPermissions }));
		const installed = (await octokit.paginate('GET /installation/repositories', { per_page: 100 })).filter((r) => !isIgnored(r.full_name)); // eslint-disable-line camelcase
		return (await withAppPRs(octokit, installed)).map((r) => ({
			owner: r.owner.login,
			name: r.name,
			repository: r.full_name,
			private: r.private,
			installationId,
		}));
	} catch (error) {
		if (reads < installationReads && isTransient(error)) {
			return readInstallation(auth, installationId, reads + 1);
		}
		throw error;
	}
}

/**
 * Every repository the App is installed on, in `accounts`, that isn't archived, ignored, or a fork, and has an open PR from one of the App's branches; and how many installations couldn't be read, but for those GitHub failed (see `installationReads`), which are only warned about.
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
			return {
				repos: repos.concat(await readInstallation(auth, installation.id)),
				failures,
			};
		} catch (error) {
			// GitHub failing it, even when read again, isn't the run's failure, since the next run reads it again
			if (isTransient(error)) {
				core.warning(`installation ${installation.id} ${failureMessage(error)}, even when read again; GitHub failing doesn’t fail the run, and the next run tries it again`);
				return {
					repos,
					failures,
				};
			}
			core.warning(`installation ${installation.id} ${failureMessage(error)}`);
			return {
				repos,
				failures: failures + 1,
			};
		}
	}, initial);
}
