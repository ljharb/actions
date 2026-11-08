import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import {
	appOctokit,
	failureMessage,
	installationToken,
	octokitFor,
} from './app.mjs';
import { botBranches } from './branches.mjs';
import { ciStatus } from './ci.mjs';
import { commitsRefusal, isSingleOnBase } from './merge-guards.mjs';
import { code } from './markdown.mjs';

export { ciStatus };
export { behindReason, maxPRCommits } from './merge-guards.mjs';

/** @import { Octokit } from './app.mjs' */
/** @typedef {ReturnType<typeof import('./app.mjs').appAuth>} Auth */
/**
 * A PR waiting for its checks to finish, as the merge queue stores it: `headSha` and `base` are what `/merge` saw, and only that is ever merged. `private` is whether its repository was private when it was queued, and `commandFailed` whether anything else the same command did already failed, so that its reaction says so once its last PR is resolved.
 * @typedef {{
 *   repository: string,
 *   number: number,
 *   headSha: string,
 *   base: string,
 *   commentId: number,
 *   issueNumber: number,
 *   queuedAt: string,
 *   private: boolean,
 *   commandFailed?: boolean,
 * }} Entry
 */
// a failure's `files` are the workflow files (eg, `.github/workflows/tests.yml`) whose runs or jobs failed, or had a step whose failure `continue-on-error` hides
/** @typedef {{ kind: 'ready' } | { kind: 'pending' } | { kind: 'failed', failures: string[], files: string[] } | { kind: 'behind' } | { kind: 'refused', reason: string }} Assessment */
/** @typedef {{ owner: string, name: string, number: number, base: string, head: string }} Target */
/** @typedef {{ number: number, head: { sha: string, ref: string, repo: { full_name: string } | null }, base: { ref: string }, user: { login: string } | null }} PR */

export const queueVariable = 'FLEET_MERGE_QUEUE';
// GitHub's limit for a variable's value is 48 KB: this leaves room to spare
export const maxQueueBytes = 40 * 1024;
// a PR whose checks still haven't all finished this long after `/merge` (eg, a status nothing will ever report) is dropped, so that nothing is queued forever
export const maxQueueHours = 24;

/** @type {Record<string, string>} */
export const readPermissions = {
	contents: 'read',
	pull_requests: 'read', // eslint-disable-line camelcase
	checks: 'read',
	actions: 'read',
	statuses: 'read',
};
// a PR from `fleet/workflows` changes workflow files, which GitHub only lets a ref update include with the Workflows permission
/** @type {Record<string, string>} */
export const writePermissions = { contents: 'write', workflows: 'write' };

/** @type {Record<string, string>} */
const permissionNames = {
	contents: 'Contents',
	pull_requests: 'Pull requests', // eslint-disable-line camelcase
	checks: 'Checks',
	actions: 'Actions',
	statuses: 'Commit statuses',
	workflows: 'Workflows',
};

/** @type {(error: unknown) => string} */
export function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** @type {(error: unknown) => number | undefined} */
export function statusOf(error) {
	return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : void undefined;
}

/** @type {(error: unknown) => string} */
function httpStatus(error) {
	const status = statusOf(error);
	return typeof status === 'number' ? ` (HTTP ${status})` : '';
}

/** @type {(permissions: Record<string, string>) => string} */
function describePermissions(permissions) {
	return Object.entries(permissions).map(([name, level]) => `“${permissionNames[name]}: ${level === 'write' ? 'Read and write' : 'Read-only'}”`).join(', ');
}

/**
 * An Octokit for only the repository `name`, with only `permissions`.
 * @type {(auth: Auth, repo: { installationId: number, name: string, private: boolean }, permissions: Record<string, string>) => Promise<Octokit>}
 */
export async function repoOctokit(auth, {
	installationId, name, private: isPrivate,
}, permissions) {
	/** @type {string} */
	let token;
	try {
		token = await installationToken(auth, installationId, { repositoryNames: [name], permissions });
	} catch (error) {
		throw new Error(`the fleet GitHub App could not get a token for it${httpStatus(error)}: the App needs the ${describePermissions(permissions)} repository permissions, approved by its installation`);
	}
	core.setSecret(token);
	return octokitFor(token, isPrivate);
}

/**
 * The installation on `owner/name`, looked up quietly, since it may be a private repository.
 * @type {(auth: Auth, owner: string, name: string) => Promise<number>}
 */
export async function installationFor(auth, owner, name) {
	const { data } = await (await appOctokit(auth, true)).rest.apps.getRepoInstallation({ owner, repo: name });
	return data.id;
}

/**
 * The open PRs the App's bot opened in `owner/name` from one of its own branches there: never from a fork, nor by anyone else.
 * @type {(octokit: Octokit, repo: { owner: string, name: string, repository: string }, bot: string) => Promise<PR[]>}
 */
export async function candidatePRs(octokit, {
	owner, name, repository,
}, bot) {
	/** @type {PR[]} */
	const found = [];
	await botBranches.reduce(async (previous, branch) => {
		await previous;
		// `head` only narrows by the head repository's owner and branch, so a fork of anything else the owner has can still match
		const prs = await octokit.paginate(octokit.rest.pulls.list, {
			owner,
			repo: name,
			head: `${owner}:${branch}`,
			state: 'open',
			per_page: 100, // eslint-disable-line camelcase
		});
		prs.filter((pr) => pr.head.ref === branch
			&& pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase()
			&& pr.user?.login.toLowerCase() === bot.toLowerCase()).forEach((pr) => {
			found.push(pr);
		});
	}, Promise.resolve());
	return found.sort((a, b) => a.number - b.number);
}

/**
 * Whether a PR can be merged now: `refused` when it has commits that aren't the App's bot's own (which only a person can review), `behind` when it isn't one commit on its base's current tip (which the App fixes by rebasing it, not by waiting), else how its CI went.
 * @type {(octokit: Octokit, target: Target, bot: string) => Promise<Assessment>}
 */
export async function assess(octokit, target, bot) {
	const commits = await commitsRefusal(octokit, target, bot);
	if ('reason' in commits) {
		return { kind: 'refused', reason: commits.reason };
	}
	if (!await isSingleOnBase(octokit, target, commits)) {
		return { kind: 'behind' };
	}
	const ci = await ciStatus(octokit, target);
	return ci.kind === 'passed' ? { kind: 'ready' } : ci;
}

/**
 * Fast-forwards `base` to `head`, which GitHub then marks the PR as merged by; never forced, so it's refused if `base` has moved on since.
 * A refusal's message (eg, from branch protection) can name what refused it, so only its HTTP status is kept.
 * @type {(octokit: Octokit, target: Target) => Promise<void>}
 */
export async function fastForward(octokit, {
	owner, name, base, head,
}) {
	try {
		await octokit.rest.git.updateRef({
			owner, repo: name, ref: `heads/${base}`, sha: head, force: false,
		});
	} catch (error) {
		throw new Error(`GitHub refused to fast-forward ${code(base)} to it${httpStatus(error)}, eg because of a branch protection rule`);
	}
}

/** @type {(value: unknown) => value is Entry} */
function isEntry(value) {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const e = /** @type {Record<string, unknown>} */ (value);
	return typeof e.repository === 'string'
		&& typeof e.number === 'number'
		&& typeof e.headSha === 'string'
		&& typeof e.base === 'string'
		&& typeof e.commentId === 'number'
		&& typeof e.issueNumber === 'number'
		&& typeof e.queuedAt === 'string'
		&& !Number.isNaN(Date.parse(e.queuedAt))
		&& typeof e.private === 'boolean';
}

/** @type {(entry: { repository: string, number: number }) => string} */
export function entryKey({ repository, number }) {
	return `${repository.toLowerCase()}#${number}`;
}

/** @type {(entries: Entry[]) => boolean} */
export function fits(entries) {
	return Buffer.byteLength(JSON.stringify(entries)) <= maxQueueBytes;
}

/**
 * An Octokit that can only read and write `owner/repo`'s Actions variables, which hold the merge queue: a variable, unlike anything a workflow outputs, is private, and the queue may name private repositories.
 * @type {(auth: Auth, owner: string, repo: string) => Promise<Octokit>}
 */
export async function queueOctokit(auth, owner, repo) {
	/** @type {string} */
	let token;
	try {
		const { data: installation } = await (await appOctokit(auth)).rest.apps.getRepoInstallation({ owner, repo });
		token = await installationToken(auth, installation.id, {
			repositoryNames: [repo],
			permissions: { actions_variables: 'write' }, // eslint-disable-line camelcase
		});
	} catch (error) {
		throw new Error(`the fleet GitHub App could not get a token to read and write Actions variables in \`${owner}/${repo}\`${httpStatus(error)}: the App needs the “Variables: Read and write” repository permission, for the merge queue (the \`${queueVariable}\` variable), and must be installed on \`${owner}/${repo}\`. After that permission is added to the App, its installation on \`${owner}\` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.`);
	}
	core.setSecret(token);
	return getOctokit(token);
}

/**
 * The merge queue, and whether its variable exists yet; anything in it that isn't an entry is dropped.
 * @type {(octokit: Octokit, owner: string, repo: string) => Promise<{ entries: Entry[], exists: boolean }>}
 */
export async function readQueue(octokit, owner, repo) {
	/** @type {string} */
	let value;
	try {
		({ data: { value } } = await octokit.rest.actions.getRepoVariable({
			owner, repo, name: queueVariable,
		}));
	} catch (error) {
		if (statusOf(error) === 404) {
			return { entries: [], exists: false };
		}
		throw error;
	}
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		core.warning(`the \`${queueVariable}\` variable is not valid JSON, so the merge queue starts over empty`);
		parsed = [];
	}
	return { entries: Array.isArray(parsed) ? parsed.filter(isEntry) : [], exists: true };
}

/** @type {(octokit: Octokit, where: { owner: string, repo: string, exists: boolean }, entries: Entry[]) => Promise<void>} */
export async function writeQueue(octokit, {
	owner, repo, exists,
}, entries) {
	const options = {
		owner, repo, name: queueVariable, value: JSON.stringify(entries),
	};
	await (exists ? octokit.rest.actions.updateRepoVariable(options) : octokit.rest.actions.createRepoVariable(options));
}

/**
 * Swaps the App's bot's 👀 on a queued command for how it went, once its last PR is resolved: 🚀 or 😕.
 * Only ever a best effort, like a command's own.
 * @type {(options: { octokit: Octokit, owner: string, repo: string, commentId: number, bot: string, ok: boolean }) => Promise<void>}
 */
export async function finishQueued({
	octokit, owner, repo, commentId, bot, ok,
}) {
	try {
		const reactions = await octokit.paginate(octokit.rest.reactions.listForIssueComment, {
			owner, repo, comment_id: commentId, content: 'eyes', per_page: 100, // eslint-disable-line camelcase
		});
		await reactions.filter((r) => r.user?.login.toLowerCase() === bot.toLowerCase()).reduce(async (previous, reaction) => {
			await previous;
			await octokit.rest.reactions.deleteForIssueComment({
				owner,
				repo,
				comment_id: commentId, // eslint-disable-line camelcase
				reaction_id: reaction.id, // eslint-disable-line camelcase
			});
		}, Promise.resolve());
		await octokit.rest.reactions.createForIssueComment({
			owner, repo, comment_id: commentId, content: ok ? 'rocket' : 'confused', // eslint-disable-line camelcase
		});
	} catch (error) {
		core.warning(`could not mark a queued \`/merge\` as ${ok ? 'done' : 'failed'}: ${failureMessage(error)}`);
	}
}
