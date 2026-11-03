import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as core from '@actions/core';

import {
	addInputs,
	ambiguity,
	declaredInputs,
	removedInputs,
} from '../drift/inputs.mjs';
import { installationToken, octokitFor } from '../lib/app.mjs';
import { fixBranch } from '../lib/branches.mjs';
import { configFile, keptConfig } from '../lib/kept.mjs';
import { code } from '../lib/markdown.mjs';
import {
	candidatePRs,
	ciStatus,
	messageOf,
} from '../lib/merge.mjs';
import { changedReason, commitsRefusal, isSingleOnBase } from '../lib/merge-guards.mjs';
import {
	botIdentity,
	checkout,
	commentOnce,
	findMarked,
	ownCommits,
	pushBranch,
	remoteTip,
} from '../lib/pr.mjs';
import { reposWithAppPRs } from './repos.mjs';

/** @typedef {import('../lib/app.mjs').Octokit} Octokit */
/** @typedef {ReturnType<typeof import('../lib/app.mjs').appAuth>} Auth */
/** @typedef {import('../lib/merge.mjs').PR} PR */
/** @typedef {import('../lib/pr.mjs').Git} Git */
/** @typedef {import('../lib/pr.mjs').Identity} Identity */
/** @typedef {import('./repos.mjs').Repo} Repo */
/**
 * What keeping one PR up to date came to:
 * - `changed`: its branch moved while it was being looked at, so it's left for the next run
 * - `foreign`: it has commits by someone else (or too many to tell), so it's never touched (and says so, once per head)
 * - `rebased`: it was rebuilt as one commit on its base's tip
 * - `conflict`: it can't be, since it conflicts with its base (which it says, once per head and base tip)
 * - `empty`: it can't be, since its base already has everything it changes (which it says, once per head and base tip)
 * - `pending`, `passed`: it's one commit on its base's tip, and its CI is still running, or passed (or, for a relock PR, isn't looked at)
 * - `restored`: its CI failed, and inputs it removed from a failed workflow file were put back, and kept
 * - `stuck`: its CI failed, and there's nothing left to put back (or where to put it back is ambiguous), so it needs a person (which it says, once per head)
 * Once it's said a PR is `stuck`, that's what it is until its head changes; once it's said it's `conflict` or `empty`, that's what it is until its head, or its base's tip, changes: later runs find what was said on it, and never clone it again to decide it again.
 * @typedef {{ kind: 'changed' | 'foreign' | 'rebased' | 'conflict' | 'empty' | 'pending' | 'passed' | 'restored' | 'stuck', text: string }} Outcome
 */
/** @typedef {{ auth: Auth, bot: string, serverURL: string, identities: Map<number, Promise<Identity>> }} Context */

// reading and checking a PR's CI, rebuilding its branch, and commenting on it
/** @type {Record<string, string>} */
export const permissions = {
	contents: 'write',
	pull_requests: 'write', // eslint-disable-line camelcase
	workflows: 'write',
	checks: 'read',
	actions: 'read',
	statuses: 'read',
};

// hidden in each comment, so that each is only ever made once for each head commit (and, when it's about the PR's base too, for each of its base's tips)
/** @typedef {'foreign' | 'conflict' | 'empty' | 'stuck'} Said */

/** @type {(kind: Said, head: string, base?: string) => string} */
export function marker(kind, head, base) {
	return `<!-- fleet:${kind}:${head}${base ? `:${base}` : ''} -->`;
}

/** @type {(git: Git, rev: string) => string | null} */
function show(git, rev) {
	const shown = git(['show', rev], { allowFailure: true });
	return shown.status === 0 ? shown.stdout : null;
}

/**
 * One commit on `base`'s tip with `tree`, with the message of `from` (the PR's oldest commit, which is the App's, whose message says what it's for).
 * @type {(git: Git, commit: { base: string, tree: string, from: string }) => string}
 */
function commitOnBase(git, {
	base, tree, from,
}) {
	return git([
		'commit-tree', tree, '-p', `origin/${base}`, '-F', '-',
	], {
		input: git([
			'log', '-1', '--format=%B', from,
		]).stdout,
	}).stdout.trim();
}

/** @typedef {{ context: Context, repo: Repo, pr: PR, octokit: Octokit, token: string }} Target */
/** @typedef {Target & { git: Git, tip: string, identity: Identity }} Job */

// about the PR's head commit, which is what it was looked at as (and, with `base`, its base's tip, which it was looked at on)
/** @type {(target: Target, about: { kind: Said, base?: string }, body: string) => Promise<boolean>} */
function say({
	context, repo, pr, octokit,
}, { kind, base }, body) {
	return commentOnce({
		octokit, owner: repo.owner, name: repo.name, number: pr.number, author: context.bot, marker: marker(kind, pr.head.sha, base), body,
	});
}

/**
 * Rebuilds the PR as one commit on its base's tip: the change all its commits make, applied there as `git rebase` would (a single commit is replayed onto the base's tip; several, squashed first). On a conflict, it's left as it is, and says so, about that tip.
 * @type {(job: Job) => Promise<Outcome>}
 */
async function rebase(job) {
	const {
		git, pr, tip, identity,
	} = job;
	const base = pr.base.ref;
	const commits = ownCommits(git, { base, tip });
	const from = commits.length === 1 ? `${tip}^` : git([
		'merge-base', `origin/${base}`, tip,
	]).stdout.trim();
	const merged = git([
		'merge-tree', '--write-tree', `--merge-base=${from}`, `origin/${base}`, tip,
	], { allowFailure: true });
	const onto = git(['rev-parse', `origin/${base}`]).stdout.trim();
	if (merged.status !== 0) {
		await say(job, { kind: 'conflict', base: onto }, `This PR conflicts with ${code(base)}, so the App can’t rebase it onto ${code(base)}’s tip, which it must be on to be merged: it needs updating (eg, with \`/fix\`), or closing.`);
		return { kind: 'conflict', text: `it conflicts with ${code(base)}, so it can’t be rebased; said so on it` };
	}
	const tree = merged.stdout.split('\n')[0];
	if (tree === git(['rev-parse', `origin/${base}^{tree}`]).stdout.trim()) {
		await say(job, { kind: 'empty', base: onto }, `${code(base)} already has everything this PR changes, so the App leaves it as it is: it can be closed.`);
		return { kind: 'empty', text: `${code(base)} already has everything it changes, so it’s left as it is; said so on it` };
	}
	const commit = commitOnBase(git, {
		base, tree, from: String(commits.at(-1)),
	});
	pushBranch(git, {
		base, branch: pr.head.ref, tip, identity, commit,
	});
	return { kind: 'rebased', text: `rebased onto ${code(base)}’s tip` };
}

/**
 * Only the inputs the reusable workflow each is passed to declares: only those can be what it needed (and can be kept).
 * @type {(inputs: import('../drift/inputs.mjs').Inputs) => import('../drift/inputs.mjs').Inputs}
 */
function declaredOnly(inputs) {
	/** @type {import('../drift/inputs.mjs').Inputs} */
	const declared = new Map();
	for (const [job, { file, inputs: passed }] of inputs) {
		const known = new Map([...passed].filter(([key]) => declaredInputs(file).has(key)));
		if (known.size > 0) {
			declared.set(job, { file, inputs: known });
		}
	}
	return declared;
}

/**
 * What putting back the inputs the PR removed from the workflow files in `failed` that it changes writes: each file, with them put back, in each call it removed them from (see `removedInputs`), and the inputs put back in each, by its file name; and, by file, why any it removed from a call whose counterpart is ambiguous can't be put back (`ambiguous`), or why any that would be put back can't be (`unwritable`: see `addInputs`).
 * @type {(git: Git, at: { base: string, tip: string }, failed: string[]) => { writes: Map<string, string>, kept: Map<string, string[]>, ambiguous: Map<string, string>, unwritable: Map<string, string> }}
 */
function restorations(git, { base, tip }, failed) {
	const changed = new Set(git([
		'diff', '--name-only', '-z', `origin/${base}`, tip,
	]).stdout.split('\0').filter(Boolean));
	/** @type {Map<string, string>} */
	const writes = new Map();
	/** @type {Map<string, string[]>} */
	const kept = new Map();
	/** @type {Map<string, string>} */
	const ambiguous = new Map();
	/** @type {Map<string, string>} */
	const unwritable = new Map();
	for (const file of failed.filter((f) => changed.has(f))) {
		const before = show(git, `origin/${base}:${file}`);
		const after = show(git, `${tip}:${file}`);
		const none = new Map();
		const found = before === null || after === null ? {
			removed: none, ambiguous: none,
		} : removedInputs(before, after);
		const removed = declaredOnly(found.removed);
		const unplaced = declaredOnly(found.ambiguous);
		if (unplaced.size > 0) {
			ambiguous.set(file, ambiguity(unplaced));
		} else if (removed.size > 0) {
			const { text: written, why } = addInputs(String(after), removed);
			if (why) {
				unwritable.set(file, why);
			} else {
				writes.set(file, written);
				kept.set(path.posix.basename(file), [...new Set([...removed.values()].flatMap(({ inputs }) => [...inputs.keys()]))]);
			}
		}
	}
	return {
		writes, kept, ambiguous, unwritable,
	};
}

/**
 * One commit on `base`'s tip whose tree is `tip`'s, with `writes`.
 * @type {(git: Git, at: { base: string, tip: string }, writes: Map<string, string>) => string}
 */
function rewrite(git, { base, tip }, writes) {
	git(['read-tree', tip]);
	for (const [file, content] of writes) {
		const blob = git([
			'hash-object', '-w', '--stdin',
		], { input: content }).stdout.trim();
		git([
			'update-index', '--add', '--cacheinfo', `100644,${blob},${file}`,
		]);
	}
	return commitOnBase(git, {
		base, tree: git(['write-tree']).stdout.trim(), from: tip,
	});
}

/**
 * Puts back, in each workflow file whose CI failed that the PR changes, the inputs it removed (as the base has them, with their trailing comments), and keeps them (in `.github/ljharb-actions.json`'s `keep`), so that fixing the file again doesn't remove them again: then the next CI run decides.
 * With nothing left to put back (eg, it already was, or what failed isn't something the PR changed), the PR needs a person, which it says, once for each head commit.
 * @type {(job: Job, failed: string[]) => Promise<Outcome>}
 */
async function restore(job, failed) {
	const {
		git, pr, tip,
	} = job;
	const base = pr.base.ref;
	const {
		writes, kept, ambiguous, unwritable,
	} = restorations(git, { base, tip }, failed);
	if (ambiguous.size > 0) {
		await say(job, { kind: 'stuck' }, `CI failed on this PR’s head commit, and the App can’t tell where to restore inputs this PR removed: ${[...ambiguous].map(([file, why]) => `in ${code(file)}, ${code(why)}`).join('; ')}. It needs a person to look at it.`);
		return { kind: 'stuck', text: 'its CI failed, and where to restore what it removed is ambiguous; said so on it' };
	}
	if (unwritable.size > 0) {
		await say(job, { kind: 'stuck' }, `CI failed on this PR’s head commit, and the App can’t restore inputs this PR removed: ${[...unwritable].map(([file, why]) => `in ${code(file)}, ${code(why)}`).join('; ')}. It needs a person to look at it.`);
		return { kind: 'stuck', text: 'its CI failed, and what it removed can’t be restored; said so on it' };
	}
	const config = writes.size > 0 ? keptConfig(git, tip, kept) : null;
	if (config === null) {
		const why = writes.size === 0
			? 'the App has nothing left to restore in the workflow files that failed and that this PR changes'
			: `the App would restore inputs this PR removed, but ${code(configFile)} isn’t a JSON object (with an object \`keep\`, if it has one), so it can’t keep them there`;
		await say(job, { kind: 'stuck' }, `CI failed on this PR’s head commit, and ${why}: it needs a person to look at it.${failed.length > 0 ? ` The workflow files that failed: ${failed.map(code).join(', ')}.` : ''}`);
		return { kind: 'stuck', text: 'its CI failed, with nothing left to restore; said so on it' };
	}
	writes.set(configFile, config);
	pushBranch(git, {
		base, branch: pr.head.ref, tip, identity: job.identity, commit: rewrite(git, { base, tip }, writes),
	});
	return { kind: 'restored', text: `its CI failed, so restored ${[...kept].map(([file, inputs]) => `${inputs.map(code).join(', ')} in ${code(file)}`).join('; ')}, and kept them in ${code(configFile)}` };
}

/** @type {(context: Context, installationId: number) => Promise<Identity>} */
function identityFor({ auth, identities }, installationId) {
	let identity = identities.get(installationId);
	if (!identity) {
		identity = botIdentity(auth, installationId);
		identities.set(installationId, identity);
	}
	return identity;
}

/**
 * Which of `kinds` the bot already said the PR is, about its head commit (and, with `base`, its base's tip: see `say`), from the API: so that what's decided about them is never decided again (which would take a clone).
 * @type {(target: Target, kinds: Said[], base?: string) => Promise<Outcome | null>}
 */
async function alreadySaid({
	context, repo, pr, octokit,
}, kinds, base) {
	const said = await findMarked({
		octokit, owner: repo.owner, name: repo.name, number: pr.number, author: context.bot, markers: kinds.map((k) => marker(k, pr.head.sha, base)),
	});
	const kind = kinds.find((k) => marker(k, pr.head.sha, base) === said);
	return kind ? { kind, text: `left as it is: as already said on it, it’s \`${kind}\` until its head commit${base ? ', or its base’s tip,' : ''} changes` } : null;
}

const branchChanged = /** @type {const} */ ({ kind: 'changed', text: 'its branch changed while it was being looked at; it’s looked at again next time' }); // eslint-disable-line no-extra-parens

/**
 * Clones the PR's repository, as little of it as `act` needs, and has `act` change its branch: unless what the clone has isn't what the API showed.
 * With `onBase`, `act` only needs the PR's head and its base's tip, which must be its parent (so the clone has only those, and their trees); otherwise, it needs their history too (but still only their trees, with each file's contents fetched when it's read).
 * @type {(target: Target, onBase: boolean, act: (job: Job) => Promise<Outcome>) => Promise<Outcome>}
 */
async function withClone(target, onBase, act) {
	const {
		context, repo, pr, token,
	} = target;
	const identity = await identityFor(context, repo.installationId);
	const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'fleet-maintain-'));
	try {
		const base = pr.base.ref;
		const { git } = checkout({
			serverURL: context.serverURL, repository: repo.repository, base, token, identity, dir: path.join(dir, 'repo'), partial: onBase ? { depth: 1 } : {},
		});
		// with `onBase`, the head and its parent, which should be the base's tip
		const tip = remoteTip(git, pr.head.ref, onBase ? { depth: 2 } : {});
		if (tip !== pr.head.sha || (onBase && git(['rev-parse', `${tip}^`]).stdout.trim() !== git(['rev-parse', `origin/${base}`]).stdout.trim())) {
			return branchChanged;
		}
		return await act({
			...target, git, tip, identity,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Keeps one of the App's open PRs the one commit on its base's tip that it must be (see `rebase`), and, for a `fleet/workflows` PR whose CI failed, puts back what it removed (see `restore`).
 * Everything is decided from the API, exactly as `/merge` decides it (see `commitsRefusal`, `isSingleOnBase`, and `ciStatus`): the repository is only cloned for a PR that has to be rebased or restored, and not even then once it's said, for its head commit (and, for a rebase, its base's tip), that it can't be (see `alreadySaid`).
 * Never touches a PR with anyone else's commits on it.
 * @type {(context: Context, target: { repo: Repo, pr: PR, octokit: Octokit, token: string }) => Promise<Outcome>}
 */
export async function maintainPR(context, {
	repo, pr, octokit, token,
}) {
	/** @type {Target} */
	const target = {
		context, repo, pr, octokit, token,
	};
	/** @type {import('../lib/merge.mjs').Target} */
	const at = {
		owner: repo.owner, name: repo.name, number: pr.number, base: pr.base.ref, head: pr.head.sha,
	};
	const commits = await commitsRefusal(octokit, at, context.bot);
	if ('reason' in commits) {
		if (commits.reason === changedReason) {
			return branchChanged;
		}
		await say(target, { kind: 'foreign' }, `The App never updates this PR (nor merges it): ${commits.reason}.`);
		return { kind: 'foreign', text: `it’s left alone (${commits.reason}); said so on it` };
	}
	if (!await isSingleOnBase(octokit, at, commits)) {
		const { data: ref } = await octokit.rest.git.getRef({
			owner: repo.owner, repo: repo.name, ref: `heads/${pr.base.ref}`,
		});
		return await alreadySaid(target, ['conflict', 'empty'], ref.object.sha) ?? withClone(target, false, rebase);
	}
	if (pr.head.ref !== fixBranch) {
		return { kind: 'passed', text: 'up to date' };
	}
	const ci = await ciStatus(octokit, {
		owner: repo.owner, name: repo.name, head: pr.head.sha,
	});
	if (ci.kind === 'failed') {
		return await alreadySaid(target, ['stuck']) ?? withClone(target, true, (job) => restore(job, ci.files));
	}
	return { kind: ci.kind, text: `up to date; its CI ${ci.kind === 'pending' ? 'is still running' : 'passed'}` };
}

/**
 * Keeps every open PR of the App's up to date (see `maintainPR`): each public one's outcome is logged, and nothing about a private one.
 * A repository's failure stops its other PRs until the next run. Returns how many public repositories (or installations) failed.
 * @type {(auth: Auth, accounts: Set<string>, options: { bot: () => Promise<string>, serverURL: string }) => Promise<number>}
 */
export async function maintain(auth, accounts, { bot, serverURL }) {
	const { repos, failures } = await reposWithAppPRs(auth, accounts);
	if (repos.length === 0) {
		core.info('no open PRs from the App’s branches to keep up to date');
		return failures;
	}
	/** @type {Context} */
	const context = {
		auth, bot: await bot(), serverURL, identities: new Map(),
	};
	let errors = failures;
	// one at a time, private repositories last, as the commands do
	for (const repo of [...repos.filter((r) => !r.private), ...repos.filter((r) => r.private)]) {
		try {
			const token = await installationToken(auth, repo.installationId, { repositoryNames: [repo.name], permissions }); // eslint-disable-line no-await-in-loop
			core.setSecret(token);
			const octokit = octokitFor(token, repo.private);
			for (const pr of await candidatePRs(octokit, repo, context.bot)) { // eslint-disable-line no-await-in-loop
				const { text } = await maintainPR(context, { // eslint-disable-line no-await-in-loop
					repo, pr, octokit, token,
				});
				if (!repo.private) {
					core.info(`${serverURL}/${repo.repository}/pull/${pr.number}: ${text}`);
				}
			}
		} catch (error) {
			// a private repository's failure is never shown, and never fails the run
			if (!repo.private) {
				errors += 1;
				core.warning(`${repo.repository}: ${messageOf(error)}`);
			}
		}
	}
	core.info('Open PRs in private repositories, if any, were also kept up to date; nothing about them is shown here.');
	return errors;
}
