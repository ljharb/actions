import * as core from '@actions/core';

import { botLogin, installationToken, octokitFor } from './app.mjs';
import { isBotBranch } from './branches.mjs';
import { exec, gitAuthEnv } from './exec.mjs';
import { hideStale } from './said.mjs';

/** @import { Octokit, appAuth } from './app.mjs' */
/** @import { ExecResult } from './exec.mjs' */
/** @typedef {{ name: string, email: string }} Identity */
/** @typedef {{ mode: 'create' } | { mode: 'update' | 'reopen', number: number, head: string }} PRState */
/** @typedef {(args: string[], options?: { allowFailure?: boolean, input?: string }) => ExecResult} Git */
/** @typedef {(path: string) => boolean} PathFilter */

/** @type {(output: string) => string[]} */
function paths(output) {
	return output.split('\0').filter(Boolean);
}

// the App's bot user, so that its commits are attributed to it
/** @type {(auth: ReturnType<typeof appAuth>, installationId: number) => Promise<Identity>} */
export async function botIdentity(auth, installationId) {
	// quiet, like a private repository's own requests: these only happen when there's a repository to fix, which may be a private one
	const login = await botLogin(auth, true);
	const token = await installationToken(auth, installationId, { permissions: { metadata: 'read' } });
	core.setSecret(token);
	const { data: user } = await octokitFor(token, true).rest.users.getByUsername({ username: login });
	return { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
}

/**
 * Clones `base` into `dir`, authenticated with `token`, with `identity` as the author and committer of anything committed there.
 * `serverURL` defaults to the workflow's server (`GITHUB_SERVER_URL`), else github.com.
 * With `partial`, only `base` is cloned, without any file's contents (each is fetched when it's read, as is anything later fetched), and with `partial.depth`, only that many of its commits.
 * @type {(options: { serverURL?: string, repository: string, base: string, token: string, identity: Identity, dir: string, partial?: { depth?: number } }) => { git: Git, env: Record<string, string> }}
 */
export function checkout({
	serverURL = process.env.GITHUB_SERVER_URL || 'https://github.com',
	repository,
	base,
	token,
	identity,
	dir,
	partial,
}) {
	const server = serverURL.replace(/\/+$/, '');
	const auth = gitAuthEnv(token, server);
	// as actions/checkout does: mask the token, and the header that encodes it, in case git ever echoes either
	core.setSecret(token);
	core.setSecret(auth.GIT_CONFIG_VALUE_0.slice('AUTHORIZATION: basic '.length));
	const env = {
		...auth,
		GIT_AUTHOR_NAME: identity.name,
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
	};
	exec(
		'git',
		[
			'clone',
			'--quiet',
			'--no-tags',
			...partial ? ['--single-branch', '--filter=blob:none'] : [],
			...partial?.depth ? [`--depth=${partial.depth}`] : [],
			'--branch',
			base,
			`${server}/${repository}.git`,
			dir,
		],
		{ env },
	);
	/** @type {Git} */
	const git = (args, options) => exec('git', args, {
		cwd: dir,
		env,
		...options,
	});
	return { git, env };
}

/** @type {(octokit: Octokit, target: { owner: string, name: string, base: string, branch: string }) => Promise<PRState>} */
export async function findPR(
	octokit,
	{
		owner,
		name,
		base,
		branch,
	},
) {
	const { data: [pr] } = await octokit.rest.pulls.list({
		owner,
		repo: name,
		head: `${owner}:${branch}`, // excludes fork PRs that reuse the branch name
		base,
		state: 'all',
		sort: 'created',
		direction: 'desc',
		per_page: 1, // eslint-disable-line camelcase
	});
	// only an already-merged PR (or none at all) warrants a new one; otherwise, update the last one in place
	if (!pr || pr.merged_at) {
		return { mode: 'create' };
	}
	return {
		mode: pr.state === 'open' ? 'update' : 'reopen',
		number: pr.number,
		head: pr.head.sha,
	};
}

/** @type {(branch: string) => void} */
function assertBotBranch(branch) {
	if (!isBotBranch(branch)) {
		throw new Error(`\`${branch}\` is not one of the App’s own branches, so it is never overwritten`);
	}
}

/** @type {(git: Git, branch: string) => string | null} */
function lsRemote(git, branch) {
	return git([
		'ls-remote',
		'--heads',
		'origin',
		`refs/heads/${branch}`,
	]).stdout.split(/\s/)[0] || null;
}

/**
 * The commit `branch` is at on the remote, fetched (with `depth`, only that many of its commits), or `null` if there's no such branch.
 * @type {(git: Git, branch: string, options?: { depth?: number }) => string | null}
 */
export function remoteTip(git, branch, { depth } = {}) {
	if (lsRemote(git, branch) === null) {
		return null;
	}
	git([
		'fetch',
		'--no-tags',
		'--quiet',
		...depth ? [`--depth=${depth}`] : [],
		'origin',
		`refs/heads/${branch}`,
	]);
	return git(['rev-parse', 'FETCH_HEAD']).stdout.trim();
}

/** @type {(git: Git, rev: string) => string} */
function revParse(git, rev) {
	return git(['rev-parse', rev]).stdout.trim();
}

/**
 * The commits on `tip` that aren't on `base` (newest first): everything a branch at `tip` adds.
 * @type {(git: Git, options: { base: string, tip: string }) => string[]}
 */
export function ownCommits(git, { base, tip }) {
	return git([
		'rev-list',
		tip,
		'--not',
		`origin/${base}`,
	]).stdout.split('\n').filter(Boolean);
}

/**
 * How many of the commits on `tip` that aren't on `base` weren't both authored and committed by `identity`: matched by email, the bot's noreply one, which is what the App commits with.
 * This guards against accidents, not adversaries: authorship is unverified git metadata, which anyone who can push to the branch can set to the bot's.
 * @type {(git: Git, options: { base: string, tip: string, identity: Identity }) => number}
 */
export function foreignCommits(
	git,
	{
		base,
		tip,
		identity,
	},
) {
	const email = identity.email.toLowerCase();
	return git([
		'log',
		'--format=%ae%x09%ce',
		tip,
		'--not',
		`origin/${base}`,
	]).stdout.split('\n').filter(Boolean).filter((line) => line.split('\t').some((e) => e.toLowerCase() !== email)).length;
}

/**
 * Refuses to overwrite `branch` at `tip` when it has anyone else's commits, so that nobody's work is ever lost.
 * @type {(git: Git, options: { base: string, branch: string, tip: string, identity: Identity }) => void}
 */
export function assertBotOwned(
	git,
	{
		base,
		branch,
		tip,
		identity,
	},
) {
	const foreign = foreignCommits(git, {
		base,
		tip,
		identity,
	});
	if (foreign > 0) {
		throw new Error(`\`${branch}\` has ${foreign} commit(s) by someone else, so it is never overwritten; remove them from the branch, or delete the branch, so the next run can rebuild it`);
	}
}

/**
 * Whether `tip` is exactly one commit whose only parent is `base`'s current tip: what every PR of the App's is.
 * @type {(git: Git, options: { base: string, tip: string }) => boolean}
 */
export function isSingleOnBase(git, { base, tip }) {
	return ownCommits(git, { base, tip }).length === 1
		&& git(['rev-parse', `${tip}^@`]).stdout.trim() === revParse(git, `origin/${base}`);
}

/**
 * Stages everything under `paths`, and commits it on top of `base`'s tip, where the clone is: unless it has nothing to commit, or (refused) anything that isn't `allowed`.
 * Returns whether it committed.
 * @type {(git: Git, options: { base: string, message: string, paths: string[], allowed: PathFilter }) => boolean}
 */
export function commitChanges(
	git,
	{
		base,
		message,
		paths: staged,
		allowed,
	},
) {
	if (revParse(git, 'HEAD') !== revParse(git, `origin/${base}`)) {
		throw new Error(`the clone is not at \`${base}\`’s tip, so nothing is committed`);
	}
	git([
		'add',
		'--all',
		'--',
		...staged,
	]);
	const files = paths(git([
		'diff',
		'--cached',
		'--name-only',
		'-z',
	]).stdout);
	const outside = files.filter((file) => !allowed(file));
	if (outside.length > 0) {
		throw new Error(`refusing to commit changes to files this job doesn’t write: ${outside.map((file) => `\`${file}\``).join(', ')}`);
	}
	if (files.length === 0) {
		return false;
	}
	git([
		'commit',
		'--quiet',
		'--message',
		message,
	]);
	return true;
}

/** @type {(git: Git, options: { base: string, branch: string, commit: string }) => void} */
function assertOnBase(
	git,
	{
		base,
		branch,
		commit,
	},
) {
	if (git(['rev-parse', `${commit}^@`]).stdout.trim() !== revParse(git, `origin/${base}`)) {
		throw new Error(`refusing to push \`${branch}\`: it must be one commit on top of \`${base}\`’s tip`);
	}
}

/** @type {(branch: string) => Error} */
function leaseError(branch) {
	return new Error(`\`${branch}\` changed after it was read, so it was not overwritten (its push was rejected); the next run rebuilds it from what it is now`);
}

/**
 * Makes the App's own `branch` exactly `commit`: one commit, whose only parent is `base`'s tip.
 * A branch that already has that tree on that parent is left alone. Otherwise, with no branch, it's a plain push; with one, observed at `tip`, it's only overwritten when every commit it adds is the bot's own, and only with a lease on `tip`, so anything pushed since makes the push fail instead of being lost.
 * Returns whether it pushed.
 * @type {(git: Git, options: { base: string, branch: string, tip: string | null, identity: Identity, commit?: string }) => 'pushed' | 'unchanged'}
 */
export function pushBranch(
	git,
	{
		base,
		branch,
		tip,
		identity,
		commit = 'HEAD',
	},
) {
	assertBotBranch(branch);
	assertOnBase(git, {
		base,
		branch,
		commit,
	});
	if (tip) {
		assertBotOwned(git, {
			base,
			branch,
			tip,
			identity,
		});
		if (isSingleOnBase(git, { base, tip }) && revParse(git, `${tip}^{tree}`) === revParse(git, `${commit}^{tree}`)) {
			return 'unchanged';
		}
	}
	const pushed = git(
		[
			'push',
			'--quiet',
			...tip ? [`--force-with-lease=refs/heads/${branch}:${tip}`] : [],
			'origin',
			`${commit}:refs/heads/${branch}`,
		],
		{ allowFailure: true },
	);
	if (pushed.status !== 0) {
		throw leaseError(branch);
	}
	return 'pushed';
}

/**
 * Makes `branch` HEAD (one commit on `base`'s tip; see `pushBranch`), and opens, reopens, or updates its PR; returns what it did.
 * `tip` is where the branch was observed on the remote (`null`: it wasn't there). A closed PR whose branch is gone has the branch restored at the PR's head (a plain push) before it's reopened, since GitHub only reopens a PR whose branch is at its head; only then is the branch overwritten.
 * Before anything is pushed or any PR touched, it refuses (via `assertBotOwned`) a branch with anyone else's commits on it; and before a closed PR is reopened, anything else that would refuse its update: HEAD that isn't one commit on `base`'s tip, or a branch that's no longer where it was observed (which would fail the update's lease), so that it's never reopened only to be left as it was.
 * Once an existing PR is updated, what the App said on it that no longer applies is hidden (see `hideStale`), which, for a private repository (`isPrivate`), never warns.
 * @type {(options: {
 *   octokit: Octokit,
 *   git: Git,
 *   owner: string,
 *   name: string,
 *   base: string,
 *   branch: string,
 *   state: PRState,
 *   tip: string | null,
 *   identity: Identity,
 *   title: string,
 *   body: string,
 *   isPrivate: boolean,
 * }) => Promise<string>}
 */
export async function publish({
	octokit,
	git,
	owner,
	name,
	base,
	branch,
	state,
	tip,
	identity,
	title,
	body,
	isPrivate,
}) {
	assertBotBranch(branch);
	let observed = tip;
	if (state.mode === 'reopen' && !observed) {
		git([
			'fetch',
			'--no-tags',
			'--quiet',
			'origin',
			`refs/pull/${state.number}/head`,
		]);
		observed = state.head;
	}
	if (observed) {
		assertBotOwned(git, {
			base,
			branch,
			tip: observed,
			identity,
		});
	}
	if (state.mode === 'reopen') {
		assertOnBase(git, {
			base,
			branch,
			commit: 'HEAD',
		});
		if (lsRemote(git, branch) !== tip) {
			throw leaseError(branch);
		}
		if (!tip) {
			git([
				'push',
				'--quiet',
				'origin',
				`${state.head}:refs/heads/${branch}`,
			]);
		}
		await octokit.rest.pulls.update({
			owner,
			repo: name,
			pull_number: state.number, // eslint-disable-line camelcase
			state: 'open',
		});
	}
	const pushed = pushBranch(git, {
		base,
		branch,
		tip: observed,
		identity,
	});

	const { data: pr } = state.mode === 'create'
		? await octokit.rest.pulls.create({
			owner,
			repo: name,
			base,
			head: branch,
			title,
			body,
		})
		: await octokit.rest.pulls.update({
			owner,
			repo: name,
			pull_number: state.number, // eslint-disable-line camelcase
			title,
			body,
		});
	const done = {
		create: 'created',
		update: pushed === 'pushed' ? 'updated' : 'already up to date:',
		reopen: 'reopened and updated',
	}[state.mode];
	// it's now one commit, of only the App's, that changes something on its base's tip: so the head it replaced no longer conflicts, isn't empty, and has nobody else's commits
	const hidden = state.mode === 'create' ? 0 : await hideStale({
		octokit,
		owner,
		name,
		number: state.number,
		author: identity.name,
		isPrivate,
		current: {
			previous: observed,
			head: pushed === 'pushed' ? revParse(git, 'HEAD') : String(observed),
			base: revParse(git, `origin/${base}`),
			resolved: [
				'foreign',
				'conflict',
				'empty',
			],
		},
	});
	return `${done} ${pr.html_url}${hidden > 0 ? `; hid ${hidden} of the App’s earlier comments on it that no longer apply` : ''}`;
}

/**
 * The first of `markers` that a comment on PR (or issue) `number` by `author` starts with (on a line of its own, as `commentOnce` puts it), or `null` if none does.
 * @type {(options: { octokit: Octokit, owner: string, name: string, number: number, author: string, markers: string[] }) => Promise<string | null>}
 */
export async function findMarked({
	octokit,
	owner,
	name,
	number,
	author,
	markers,
}) {
	const comments = (await octokit.paginate(octokit.rest.issues.listComments, {
		owner,
		repo: name,
		issue_number: number, // eslint-disable-line camelcase
		per_page: 100, // eslint-disable-line camelcase
	})).filter((c) => c.user?.login === author);
	return markers.find((m) => comments.some((c) => c.body?.startsWith(`${m}\n`))) ?? null;
}

/**
 * Comments `body` on PR (or issue) `number`, unless `author` already has a comment there with `marker` (see `findMarked`): so that something is only ever said once (eg, once per head commit, when `marker` names it).
 * Returns whether it commented.
 * @type {(options: { octokit: Octokit, owner: string, name: string, number: number, author: string, marker: string, body: string }) => Promise<boolean>}
 */
export async function commentOnce({
	octokit,
	owner,
	name,
	number,
	author,
	marker,
	body,
}) {
	if (await findMarked({
		octokit,
		owner,
		name,
		number,
		author,
		markers: [marker],
	})) {
		return false;
	}
	await octokit.rest.issues.createComment({
		owner,
		repo: name,
		issue_number: number, // eslint-disable-line camelcase
		body: `${marker}\n${body}`,
	});
	return true;
}

// a closed (not deleted) branch and PR are what a later run reopens, so the history and discussion stay in one place
/** @type {(options: { octokit: Octokit, owner: string, name: string, number: number, comment?: string }) => Promise<void>} */
export async function closePR({
	octokit,
	owner,
	name,
	number,
	comment,
}) {
	if (comment) {
		await octokit.rest.issues.createComment({
			owner,
			repo: name,
			issue_number: number, // eslint-disable-line camelcase
			body: comment,
		});
	}
	await octokit.rest.pulls.update({
		owner,
		repo: name,
		pull_number: number, // eslint-disable-line camelcase
		state: 'closed',
	});
}
