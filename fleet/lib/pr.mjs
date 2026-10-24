import * as core from '@actions/core';

import { appOctokit, installationToken, octokitFor } from './app.mjs';
import { exec, gitAuthEnv } from './exec.mjs';

/** @typedef {import('./app.mjs').Octokit} Octokit */
/** @typedef {{ name: string, email: string }} Identity */
/** @typedef {{ mode: 'create' } | { mode: 'update' | 'reopen', number: number, head: string }} PRState */
/** @typedef {(args: string[], options?: { allowFailure?: boolean, input?: string }) => import('./exec.mjs').ExecResult} Git */
/** @typedef {(path: string) => boolean} PathFilter */

/** @type {(output: string) => string[]} */
function paths(output) {
	return output.split('\0').filter(Boolean);
}

// the App's bot user, so that its commits are attributed to it
/** @type {(auth: ReturnType<typeof import('./app.mjs').appAuth>, installationId: number) => Promise<Identity>} */
export async function botIdentity(auth, installationId) {
	// quiet, like a private repository's own requests: these only happen when there's a repository to fix, which may be a private one
	const { data: app } = await (await appOctokit(auth, true)).rest.apps.getAuthenticated();
	if (!app?.slug) {
		throw new Error('could not determine the GitHub App’s slug');
	}
	const login = `${app.slug}[bot]`;
	const token = await installationToken(auth, installationId, { permissions: { metadata: 'read' } });
	core.setSecret(token);
	const { data: user } = await octokitFor(token, true).rest.users.getByUsername({ username: login });
	return { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
}

/**
 * Clones `base` into `dir`, authenticated with `token`, with `identity` as the author and committer of anything committed there.
 * `serverURL` defaults to the workflow's server (`GITHUB_SERVER_URL`), else github.com.
 * @type {(options: { serverURL?: string, repository: string, base: string, token: string, identity: Identity, dir: string }) => { git: Git, env: Record<string, string> }}
 */
export function checkout({
	serverURL = process.env.GITHUB_SERVER_URL || 'https://github.com',
	repository,
	base,
	token,
	identity,
	dir,
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
	exec('git', [
		'clone', '--quiet', '--no-tags', '--branch', base, `${server}/${repository}.git`, dir,
	], { env });
	/** @type {Git} */
	const git = (args, options) => exec('git', args, {
		cwd: dir, env, ...options,
	});
	return { git, env };
}

/** @type {(octokit: Octokit, target: { owner: string, name: string, base: string, branch: string }) => Promise<PRState>} */
export async function findPR(octokit, {
	owner, name, base, branch,
}) {
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

/** @type {(git: Git, branch: string) => boolean} */
export function remoteHasBranch(git, branch) {
	return git([
		'ls-remote', '--heads', 'origin', `refs/heads/${branch}`,
	]).stdout.trim() !== '';
}

/**
 * Checks out `branch`, up to date with `base`.
 * @type {(git: Git, options: { state: PRState, base: string, branch: string, remoteHasBranch: boolean, regenerated: PathFilter }) => void}
 */
export function prepareBranch(git, {
	state,
	base,
	branch,
	remoteHasBranch: hasBranch,
	regenerated,
}) {
	// build on whatever is on the remote, so the final push is always a fast-forward; a reopened PR's deleted branch is rebuilt from the PR's head
	/** @type {string | null} */
	let ref = null;
	if (hasBranch) {
		ref = `refs/heads/${branch}`;
	} else if (state.mode === 'reopen') {
		ref = `refs/pull/${state.number}/head`;
	}
	if (ref) {
		git([
			'fetch', '--no-tags', '--quiet', 'origin', ref,
		]);
		git([
			'switch', '--quiet', '--create', branch, 'FETCH_HEAD',
		]);
	} else {
		git([
			'switch', '--quiet', '--create', branch, `origin/${base}`,
		]);
	}

	const merge = git([
		'merge', '--no-edit', '--quiet', `origin/${base}`,
	], { allowFailure: true });
	if (merge.status === 0) {
		return;
	}
	const conflicts = paths(git([
		'diff', '--name-only', '-z', '--diff-filter=U',
	]).stdout);
	if (conflicts.length === 0) {
		throw new Error(`could not merge \`${base}\` into \`${branch}\`:\n${merge.stderr}${merge.stdout}`.trim());
	}
	// a conflict in anything else needs a human: never commit conflict markers, nor silently pick a side
	const unresolvable = conflicts.filter((file) => !regenerated(file));
	if (unresolvable.length > 0) {
		git(['merge', '--abort']);
		throw new Error(`\`${branch}\` conflicts with \`${base}\` in ${unresolvable.map((file) => `\`${file}\``).join(', ')}; refusing to resolve that automatically. Resolve it on the branch, or delete the branch, so the next run can rebuild it.`);
	}
	// the base may have moved, and these files are regenerated anyway, so on a conflict take the base's
	for (const file of conflicts) {
		if (git([
			'cat-file', '-e', `origin/${base}:${file}`,
		], { allowFailure: true }).status === 0) {
			git([
				'checkout', `origin/${base}`, '--', file,
			]);
		} else {
			git([
				'rm', '--quiet', '--', file,
			]);
		}
	}
	git([
		'commit', '--quiet', '--no-edit',
	]);
}

/**
 * The branch is reused across runs, so refuse to put the bot's name on anything it didn't write itself:
 * every file it changes from `base` must be `allowed`, and every commit must be authored and committed by `identity`,
 * except a merge by someone else (eg, GitHub's "Update branch") whose tree is exactly what merging its parents produces, so it adds nothing of its own.
 *
 * This guards against accidents, not adversaries: authorship is read from the commits' author and committer emails,
 * which anyone who can push to the branch can set to the bot's. Stronger guarantees would need the bot's commits made through the API,
 * so GitHub verifies them, and verified signatures required on every non-merge commit.
 * @type {(git: Git, options: { base: string, branch: string, identity: Identity, allowed: PathFilter }) => void}
 */
export function assertOwnChanges(git, {
	base, branch, identity, allowed,
}) {
	const files = paths(git([
		'diff', '--name-only', '-z', `origin/${base}`, 'HEAD',
	]).stdout).filter((file) => !allowed(file));
	const foreign = git([
		'log', '--format=%ae%x09%ce%x09%T%x09%P', `origin/${base}..HEAD`,
	]).stdout.split('\n').filter(Boolean).filter((line) => {
		const [
			author,
			committer,
			tree,
			parents,
		] = line.split('\t');
		if (author === identity.email && committer === identity.email) {
			return false;
		}
		/*
		 * a merge can carry changes of its own (an "evil merge"), which the file check can't attribute when they're in allowed files;
		 * a conflicted one was resolved by hand, so it can't be told apart from one, either
		 */
		const parentList = parents.split(' ');
		const merged = parentList.length === 2 && git([
			'merge-tree', '--write-tree', ...parentList,
		], { allowFailure: true });
		return !merged || merged.status !== 0 || merged.stdout.trim() !== tree;
	});
	if (files.length > 0 || foreign.length > 0) {
		const problems = [
			files.length > 0 && `files: ${files.join(', ')}`,
			foreign.length > 0 && `${foreign.length} commit(s) by someone else`,
		].filter(Boolean);
		throw new Error(`\`${branch}\` has changes this job didn’t make (${problems.join('; ')}); refusing to push. Remove them from the branch, or delete the branch, so the next run can rebuild it.`);
	}
}

/**
 * Pushes HEAD to `branch`, and opens, reopens, or updates its PR; returns what it did.
 * First, before pushing or touching the PR, it refuses (via `assertOwnChanges`) anything on the branch that `identity` didn't write, or outside what's `allowed`.
 * @type {(options: {
 *   octokit: Octokit,
 *   git: Git,
 *   owner: string,
 *   name: string,
 *   base: string,
 *   branch: string,
 *   state: PRState,
 *   remoteHasBranch: boolean,
 *   identity: Identity,
 *   allowed: PathFilter,
 *   title: string,
 *   body: string,
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
	remoteHasBranch: hasBranch,
	identity,
	allowed,
	title,
	body,
}) {
	assertOwnChanges(git, {
		base, branch, identity, allowed,
	});
	if (state.mode === 'reopen') {
		// a closed PR can only be reopened while its head branch exists at its head commit
		if (!hasBranch) {
			git([
				'push', '--quiet', 'origin', `${state.head}:refs/heads/${branch}`,
			]);
		}
		await octokit.rest.pulls.update({
			owner, repo: name, pull_number: state.number, state: 'open', // eslint-disable-line camelcase
		});
	}
	// never forced: the branch was built on the remote's tip, so anything else pushed meanwhile makes this fail instead of being lost
	git([
		'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`,
	]);

	if (state.mode === 'create') {
		const { data: pr } = await octokit.rest.pulls.create({
			owner, repo: name, base, head: branch, title, body,
		});
		return `created ${pr.html_url}`;
	}
	const { data: pr } = await octokit.rest.pulls.update({
		owner, repo: name, pull_number: state.number, title, body, // eslint-disable-line camelcase
	});
	return `${state.mode === 'reopen' ? 'reopened and updated' : 'updated'} ${pr.html_url}`;
}

// a closed (not deleted) branch and PR are what a later run reopens, so the history and discussion stay in one place
/** @type {(options: { octokit: Octokit, owner: string, name: string, number: number, comment?: string }) => Promise<void>} */
export async function closePR({
	octokit, owner, name, number, comment,
}) {
	if (comment) {
		await octokit.rest.issues.createComment({
			owner, repo: name, issue_number: number, body: comment, // eslint-disable-line camelcase
		});
	}
	await octokit.rest.pulls.update({
		owner, repo: name, pull_number: number, state: 'closed', // eslint-disable-line camelcase
	});
}
