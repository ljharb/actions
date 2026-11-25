import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as core from '@actions/core';

import {
	addInputs,
	ambiguity,
	declaredInputs,
	removedInputs,
	uncapped,
} from '../drift/inputs.mjs';
import {
	installationToken,
	isTransient,
	octokitFor,
} from '../lib/app.mjs';
import { fixBranch } from '../lib/branches.mjs';
import { blame, ciFailures } from '../lib/ci.mjs';
import { configFile, keptConfig } from '../lib/kept.mjs';
import { code } from '../lib/markdown.mjs';
import { candidatePRs, messageOf } from '../lib/merge.mjs';
import { changedReason, commitsRefusal, isBaseTip } from '../lib/merge-guards.mjs';
import {
	hasConfig,
	onlyBookkeeping,
	packageJson,
	packageJsonAt,
	syncConfigIgnore,
} from '../lib/npmignore.mjs';
import {
	botIdentity,
	checkout,
	closeBookkeeping,
	commentOnce,
	findMarked,
	ownCommits,
	pushBranch,
	remoteTip,
} from '../lib/pr.mjs';
import { hideSaid as hideMarked, hideStale, marker } from '../lib/said.mjs';
import { replay, rewrite } from './rebuild.mjs';
import { reposWithAppPRs } from './repos.mjs';

/** @import { Octokit, appAuth } from '../lib/app.mjs' */
/** @typedef {ReturnType<typeof appAuth>} Auth */
/** @import { PR, Target as MergeTarget } from '../lib/merge.mjs' */
/** @import { CIFailure, Commit } from '../lib/ci.mjs' */
/** @import { Git, Identity } from '../lib/pr.mjs' */
/** @import { Repo } from './repos.mjs' */
/** @import { Inputs } from '../drift/inputs.mjs' */
/** @import { Current, Said } from '../lib/said.mjs' */
/**
 * What keeping one PR up to date came to:
 * - `changed`: its branch moved while it was being looked at, so it's left for the next run
 * - `foreign`: it has commits by someone else (or too many to tell), so it's never touched (and says so, once per head)
 * - `rebased`: its commits were replayed onto its base's tip, one by one
 * - `conflict`: it can't be, since it conflicts with its base (which it says, once per head and base tip)
 * - `empty`: it can't be, since its base already has everything it changes (which it says, once per head and base tip)
 * - `pending`, `passed`: its commits are on its base's tip, one after another, and its CI is still running (or has failed only as its base's tip's has, so far), or passed (or, for a relock PR, isn't looked at); CI that failed only in ways `continue-on-error` hides passed (see `optionalFailures`); once it's passed, that it was said to be `stuck`, for that head, no longer applies, so that's hidden (see `hideStuck`)
 * - `restored`: its CI failed, and inputs it removed from a workflow file that failed in a way its base's tip doesn't were put back, and kept
 * - `stuck`: its CI failed, and there's nothing left to put back (or where to put it back is ambiguous, or every workflow file that failed only failed as on its base's tip), so it needs a person (which it says, once per head)
 * - `matches`: a `fleet/workflows` PR that would change nothing on its base's tip but the App's bookkeeping (see `onlyBookkeeping`), as it is, or once rebased, or once what it removed is put back: so it was closed (saying why, once per head), since its base's workflow files already match
 * Once it's said a PR is `stuck`, that's what it is until its head changes, or its CI, read again, passes (eg, once a flaky job that failed is re-run), when what it said is hidden, and so no longer counts: if its CI fails again on that head after all, that's decided again (and, if it's still `stuck`, said again); once it's said it's `conflict` or `empty`, that's what it is until its head, or its base's tip, changes: later runs find what was said on it, and never clone it again to decide it again.
 * @typedef {{ kind: 'changed' | 'foreign' | 'rebased' | 'conflict' | 'empty' | 'pending' | 'passed' | 'restored' | 'stuck' | 'matches', text: string }} Outcome
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

export { marker };

/** @type {(git: Git, rev: string) => string | null} */
function show(git, rev) {
	const shown = git(['show', rev], { allowFailure: true });
	return shown.status === 0 ? shown.stdout : null;
}

/** @typedef {{ context: Context, repo: Repo, pr: PR, octokit: Octokit, token: string }} Target */
/** @typedef {Target & { git: Git, tip: string, identity: Identity }} Job */

/** @type {(git: Git, from: string, to: string) => string[]} */
function changedFiles(git, from, to) {
	return git([
		'diff',
		'--name-only',
		'-z',
		from,
		to,
	]).stdout.split('\0').filter(Boolean);
}

/**
 * Closes a `fleet/workflows` PR that would change nothing on its base but the App's bookkeeping (see `closeBookkeeping`); `how` says, for its outcome, when that's so (eg, once it's rebased).
 * @type {(target: Target, how: string) => Promise<Outcome>}
 */
async function closeMatching(
	{
		context,
		repo,
		pr,
		octokit,
	},
	how,
) {
	await closeBookkeeping({
		octokit,
		owner: repo.owner,
		name: repo.name,
		number: pr.number,
		head: pr.head.sha,
		base: pr.base.ref,
		author: context.bot,
		isPrivate: repo.private,
	});
	return { kind: 'matches', text: `${how} would change only ${code(configFile)} or ${code(packageJson)}, since ${code(pr.base.ref)}’s workflow files already match, so it’s closed; said why on it` };
}

/**
 * Once the App has pushed `head` to the PR's branch, in place of `previous`, on `base`'s tip, hides what it said on the PR that no longer applies (see `hideStale`; for a private repository, never warning); `resolved` is what that push resolved. Returns how that's said in the PR's outcome.
 * @type {(job: Job, current: Current) => Promise<string>}
 */
async function hideSaid(
	{
		context,
		repo,
		pr,
		octokit,
	},
	current,
) {
	const hidden = await hideStale({
		octokit,
		owner: repo.owner,
		name: repo.name,
		number: pr.number,
		author: context.bot,
		current,
		isPrivate: repo.private,
	});
	return hidden > 0 ? `; hid ${hidden} of its earlier comments that no longer apply` : '';
}

// only that a PR is `stuck` is ever hidden while it's still about the PR's head commit (once its CI passes: see `hideStuck`), so that's what's said again if it applies again after all, and what, once hidden, is no longer what the PR is
/** @type {(kind: Said) => kind is 'stuck'} */
function isRetractable(kind) {
	return kind === 'stuck';
}

// about the PR's head commit, which is what it was looked at as (and, with `base`, its base's tip, which it was looked at on)
/** @type {(target: Target, about: { kind: Said, base?: string }, body: string) => Promise<boolean>} */
function say(
	{
		context,
		repo,
		pr,
		octokit,
	},
	{ kind, base },
	body,
) {
	return commentOnce({
		octokit,
		owner: repo.owner,
		name: repo.name,
		number: pr.number,
		author: context.bot,
		marker: marker(kind, pr.head.sha, base),
		body,
		visible: isRetractable(kind),
	});
}

/**
 * Pushes `commit`, which the App rebuilt the PR's branch as, on its base's tip (see `pushBranch`), as however many commits it is there.
 * @type {(job: Job, commit: string) => void}
 */
function pushRebuilt(
	{
		git,
		pr,
		tip,
		identity,
	},
	commit,
) {
	const base = pr.base.ref;
	pushBranch(git, {
		base,
		branch: pr.head.ref,
		tip,
		identity,
		commit,
		count: ownCommits(git, { base, tip: commit }).length,
	});
}

/**
 * Rebuilds the PR on its base's tip: its commits replayed there, one by one, as `git rebase` would (see `replay`), so that each is still a commit of its own, by the App's bot, with its message. On a conflict in any of them, it's left as it is, and says so, about that tip.
 * When its change touches `package.json` or the config file, `package.json`'s entry for the config file is synced again with whether the result has it (see `syncConfigIgnore`), in its last commit, since what the base changed meanwhile (eg, adding or deleting the config file) can leave the entry the PR added or removed wrong.
 * @type {(job: Job) => Promise<Outcome>}
 */
async function rebase(job) {
	const {
		git,
		pr,
		tip,
	} = job;
	const base = pr.base.ref;
	const replayed = replay(git, { base, tip });
	const onto = git(['rev-parse', `origin/${base}`]).stdout.trim();
	if (replayed === null) {
		await say(job, { kind: 'conflict', base: onto }, `This PR conflicts with ${code(base)}, so the App can’t rebase it onto ${code(base)}’s tip, which it must be on to be merged: it needs updating (eg, with \`/fix\`), or closing.`);
		return { kind: 'conflict', text: `it conflicts with ${code(base)}, so it can’t be rebased; said so on it` };
	}
	const tree = git(['rev-parse', `${replayed}^{tree}`]).stdout.trim();
	if (tree === git(['rev-parse', `origin/${base}^{tree}`]).stdout.trim()) {
		await say(job, { kind: 'empty', base: onto }, `${code(base)} already has everything this PR changes, so the App leaves it as it is: it can be closed.`);
		return { kind: 'empty', text: `${code(base)} already has everything it changes, so it’s left as it is; said so on it` };
	}
	if (pr.head.ref === fixBranch && onlyBookkeeping(changedFiles(git, `origin/${base}`, tree))) {
		return closeMatching(job, 'rebased onto its base’s tip, it');
	}
	const touched = git([
		'diff',
		'--name-only',
		git([
			'merge-base',
			`origin/${base}`,
			tip,
		]).stdout.trim(),
		tip,
		'--',
		packageJson,
		configFile,
	]).stdout.trim() !== '';
	const synced = touched ? await syncConfigIgnore(packageJsonAt(git, tree), hasConfig(git, tree)) : null;
	const commit = synced === null ? replayed : rewrite(
		git,
		{
			parent: `${replayed}^`,
			tree: replayed,
			from: replayed,
		},
		new Map([[packageJson, synced.content]]),
	);
	pushRebuilt(job, commit);
	/** @type {Record<'ignored' | 'unignored', string>} */
	const resynced = {
		ignored: `, and added ${code(configFile)}, which it now has, to ${code(packageJson)}’s \`publishConfig.ignore\``,
		unignored: `, and removed ${code(configFile)}, which it no longer has, from ${code(packageJson)}’s \`publishConfig.ignore\``,
	};
	// it's now only the App's commits, one after another on its base's tip, that change something there: so the head it replaced no longer conflicts, isn't empty, and has nobody else's commits
	const hid = await hideSaid(job, {
		previous: tip,
		head: commit,
		base: onto,
		resolved: [
			'foreign',
			'conflict',
			'empty',
			'matches',
		],
	});
	return { kind: 'rebased', text: `rebased onto ${code(base)}’s tip${synced === null ? '' : resynced[synced.reason]}${hid}` };
}

/**
 * Only the inputs the reusable workflow each is passed to declares: only those can be what it needed (and can be kept).
 * @type {(inputs: Inputs) => Inputs}
 */
function declaredOnly(inputs) {
	/** @type {Inputs} */
	const declared = new Map();
	inputs.forEach(({ file, inputs: passed }, job) => {
		const known = new Map(Array.from(passed).filter(([key]) => declaredInputs(file).has(key)));
		if (known.size > 0) {
			declared.set(job, { file, inputs: known });
		}
	});
	return declared;
}

/**
 * What putting back the inputs the PR removed from the workflow files in `failed` that it changes writes: each file, with them put back, in each call it removed them from (see `removedInputs`), and the inputs put back in each, by its file name; and, by file, why any it removed from a call whose counterpart is ambiguous can't be put back (`ambiguous`), or why any that would be put back can't be (`unwritable`: see `addInputs`).
 * @type {(git: Git, at: { base: string, tip: string }, failed: string[]) => { writes: Map<string, string>, kept: Map<string, string[]>, ambiguous: Map<string, string>, unwritable: Map<string, string> }}
 */
function restorations(git, { base, tip }, failed) {
	const changed = new Set(git([
		'diff',
		'--name-only',
		'-z',
		`origin/${base}`,
		tip,
	]).stdout.split('\0').filter(Boolean));
	/** @type {Map<string, string>} */
	const writes = new Map();
	/** @type {Map<string, string[]>} */
	const kept = new Map();
	/** @type {Map<string, string>} */
	const ambiguous = new Map();
	/** @type {Map<string, string>} */
	const unwritable = new Map();
	failed.filter((f) => changed.has(f)).forEach((file) => {
		const before = show(git, `origin/${base}:${file}`);
		const after = show(git, `${tip}:${file}`);
		const none = new Map();
		const found = before === null || after === null
			? {
				removed: none,
				ambiguous: none,
			}
			: removedInputs(before, after);
		const removed = declaredOnly(found.removed);
		const unplaced = declaredOnly(found.ambiguous);
		if (unplaced.size > 0) {
			ambiguous.set(file, ambiguity(unplaced));
		} else if (removed.size > 0) {
			const { text: written, why } = addInputs(String(after), removed);
			if (why) {
				unwritable.set(file, why);
			} else {
				// a call that's given back an input that writes the cache can't be capped at `read`
				writes.set(file, uncapped(written, written));
				kept.set(path.posix.basename(file), Array.from(new Set(Array.from(removed.values()).flatMap(({ inputs }) => Array.from(inputs.keys())))));
			}
		}
	});
	return {
		writes,
		kept,
		ambiguous,
		unwritable,
	};
}

/**
 * Puts back, in each workflow file whose CI failed that the PR changes, the inputs it removed (as the base has them, with their trailing comments), and keeps them (in `.github/ljharb-actions.json`'s `keep`), so that fixing the file again doesn't remove them again: then the next CI run decides.
 * Since that config file is then in the PR, it's added to `package.json`'s `publishConfig.ignore`, when that's needed (see `syncConfigIgnore`), so it isn't published (so it's never removed from there, which is only for a PR that leaves no config file).
 * With nothing left to put back (eg, it already was, or what failed isn't something the PR changed), the PR needs a person, which it says, once for each head commit.
 * @type {(job: Job, failed: string[]) => Promise<Outcome>}
 */
async function restore(job, failed) {
	const {
		git,
		pr,
		tip,
	} = job;
	const base = pr.base.ref;
	const {
		writes,
		kept,
		ambiguous,
		unwritable,
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
	const ignored = await syncConfigIgnore(packageJsonAt(git, tip), true);
	if (ignored !== null) {
		writes.set(packageJson, ignored.content);
	}
	// in its last commit, so that each of its commits is still its own
	const commit = rewrite(
		git,
		{
			parent: `${tip}^`,
			tree: tip,
			from: tip,
		},
		writes,
	);
	// with what it removed put back, its base already has the rest of what it changes
	if (onlyBookkeeping(changedFiles(git, `origin/${base}`, commit))) {
		return closeMatching(job, 'its CI failed, and with what it removed restored, it');
	}
	pushRebuilt(job, commit);
	// as for a rebase; it was never said to be stuck about the head it replaced, since it would then not have been restored
	const hid = await hideSaid(job, {
		previous: tip,
		head: commit,
		base: git(['rev-parse', `origin/${base}`]).stdout.trim(),
		resolved: [
			'foreign',
			'conflict',
			'empty',
			'matches',
		],
	});
	return { kind: 'restored', text: `its CI failed, so restored ${[...kept].map(([file, inputs]) => `${inputs.map(code).join(', ')} in ${code(file)}`).join('; ')}, and kept them in ${code(configFile)}${ignored === null ? '' : `, which it added to ${code(packageJson)}’s \`publishConfig.ignore\``}${hid}` };
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
 * Which of `kinds` the bot already said the PR is, about its head commit (and, with `base`, its base's tip: see `say`), from the API: so that what's decided about them is never decided again (which would take a clone); but for that it's `stuck`, once that's hidden (see `hideStuck`), since what it said was then taken back.
 * @type {(target: Target, kinds: Said[], base?: string) => Promise<Outcome | null>}
 */
async function alreadySaid(
	{
		context,
		repo,
		pr,
		octokit,
	},
	kinds,
	base,
) {
	const said = await findMarked({
		octokit,
		owner: repo.owner,
		name: repo.name,
		number: pr.number,
		author: context.bot,
		markers: kinds.map((k) => marker(k, pr.head.sha, base)),
		visible: kinds.some(isRetractable),
	});
	const kind = kinds.find((k) => marker(k, pr.head.sha, base) === said);
	return kind ? { kind, text: `left as it is: as already said on it, it’s \`${kind}\` until its head commit${base ? ', or its base’s tip,' : ''} changes${isRetractable(kind) ? ', or its CI passes' : ''}` } : null;
}

/** @type {Outcome} */
const branchChanged = { kind: 'changed', text: 'its branch changed while it was being looked at; it’s looked at again next time' };

/**
 * Clones the PR's repository, as little of it as `act` needs, and has `act` change its branch: unless what the clone has isn't what the API showed.
 * With `onBase`, how many commits the PR is on its base's tip, `act` only needs those and that tip, which must be what the oldest of them is on (so the clone has only those, and their trees); otherwise (`0`), it needs their history too (but still only their trees, with each file's contents fetched when it's read).
 * @type {(target: Target, onBase: number, act: (job: Job) => Promise<Outcome>) => Promise<Outcome>}
 */
async function withClone(target, onBase, act) {
	const {
		context,
		repo,
		pr,
		token,
	} = target;
	const identity = await identityFor(context, repo.installationId);
	const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'fleet-maintain-'));
	try {
		const base = pr.base.ref;
		const { git } = checkout({
			serverURL: context.serverURL,
			repository: repo.repository,
			base,
			token,
			identity,
			dir: path.join(dir, 'repo'),
			partial: onBase ? { depth: 1 } : {},
		});
		// with `onBase`, the PR's commits and what the oldest is on, which should be the base's tip
		const tip = remoteTip(git, pr.head.ref, onBase ? { depth: onBase + 1 } : {});
		if (tip !== pr.head.sha || (onBase && git(['rev-parse', `${tip}~${onBase}`]).stdout.trim() !== git(['rev-parse', `origin/${base}`]).stdout.trim())) {
			return branchChanged;
		}
		return await act({
			...target,
			git,
			tip,
			identity,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * For a PR whose CI failed, restores what it removed from the workflow files whose failures it could have caused (see `restore`), but never for a failure its base branch's tip has too, nor one that `continue-on-error` hides (see `blame`): when that's every one, the PR needs a person, which it says, once for each head commit. While that can't be told yet, nothing's done.
 * `count` is how many commits the PR is, on its base's tip, `baseTip`.
 * @type {(target: Target, ci: { failures: CIFailure[], running: boolean }, onBase: { baseTip: Commit, count: number }) => Promise<Outcome>}
 */
async function remediate(target, ci, { baseTip, count }) {
	const blamed = await blame(target.octokit, ci, baseTip);
	const base = target.pr.base.ref;
	if (blamed.kind === 'running') {
		return { kind: 'pending', text: `up to date; its CI has failed only as ${code(base)}’s does so far, and is still running` };
	}
	if (blamed.kind === 'base') {
		await say(target, { kind: 'stuck' }, `Every workflow file that failed on this PR’s head commit (${blamed.files.map(code).join(', ')}) fails the same way on ${code(base)}’s head commit (${code(baseTip.head)}), so the App has nothing to restore: it needs a person to look at it.`);
		return { kind: 'stuck', text: `its CI failed only as ${code(base)}’s does; said so on it` };
	}
	return withClone(target, count, (job) => restore(job, blamed.files));
}

/**
 * Once CI passes on a head commit the App said was `stuck` (eg, once a flaky job that failed is re-run), what it said no longer applies, so it's hidden as `OUTDATED` (see `hideSaid`; for a private repository, never warning): only what's about that head commit being stuck, never anything else it said, nor anyone else's. Returns how that's said in the PR's outcome.
 * @type {(target: Target) => Promise<string>}
 */
async function hideStuck({
	context,
	repo,
	pr,
	octokit,
}) {
	const hidden = await hideMarked({
		octokit,
		owner: repo.owner,
		name: repo.name,
		number: pr.number,
		author: context.bot,
		isPrivate: repo.private,
		classifierOf: ({ kind, head }) => (kind === 'stuck' && head === pr.head.sha ? 'OUTDATED' : null),
		unread: 'could not read the App’s comments on one of its PRs whose CI passed, to hide that it said it needed a person',
		unhidden: (count) => `could not hide ${count} of the App’s comments saying one of its PRs, whose CI has since passed, needed a person`,
	});
	return hidden > 0 ? '; it had been said to need a person, which no longer applies, so hid that' : '';
}

/**
 * Keeps one of the App's open PRs on its base's tip, as its commits, one after another, as it must be (see `rebase`), and, for a `fleet/workflows` PR whose CI failed, puts back what it removed (see `restore`); a `fleet/workflows` PR that would change nothing on its base's tip but the App's bookkeeping, as it is, or once rebased or restored, is closed instead (see `closeMatching`).
 * Everything is decided from the API, exactly as `/merge` decides it (see `commitsRefusal`, `isBaseTip`, and `ciStatus`; and, for a PR whose CI failed, its base's tip's CI, see `remediate`): the repository is only cloned for a PR that has to be rebased or restored, and not even then once it's said, for its head commit (and, for a rebase, its base's tip), that it can't be (see `alreadySaid`).
 * Never touches a PR with anyone else's commits on it.
 * @type {(context: Context, target: { repo: Repo, pr: PR, octokit: Octokit, token: string }) => Promise<Outcome>}
 */
export async function maintainPR(
	context,
	{
		repo,
		pr,
		octokit,
		token,
	},
) {
	/** @type {Target} */
	const target = {
		context,
		repo,
		pr,
		octokit,
		token,
	};
	/** @type {MergeTarget} */
	const at = {
		owner: repo.owner,
		name: repo.name,
		number: pr.number,
		base: pr.base.ref,
		head: pr.head.sha,
	};
	const commits = await commitsRefusal(octokit, at, context.bot);
	if ('reason' in commits) {
		if (commits.reason === changedReason) {
			return branchChanged;
		}
		await say(target, { kind: 'foreign' }, `The App never updates this PR (nor merges it): ${commits.reason}.`);
		return { kind: 'foreign', text: `it’s left alone (${commits.reason}); said so on it` };
	}
	const { onto } = commits;
	if (onto === null || !await isBaseTip(octokit, at, onto)) {
		const { data: ref } = await octokit.rest.git.getRef({
			owner: repo.owner,
			repo: repo.name,
			ref: `heads/${pr.base.ref}`,
		});
		return await alreadySaid(target, ['conflict', 'empty'], ref.object.sha) ?? withClone(target, 0, rebase);
	}
	if (pr.head.ref !== fixBranch) {
		return { kind: 'passed', text: 'up to date' };
	}
	/*
	 * its commits are on its base's tip, so what they change, from there to its head, is what it changes there: read for exactly the head commit checked above, so that a push since (eg, of anyone else's commits) is never what decides it; one that changes nothing at all is left as it is
	 * GitHub lists at most 300 of a comparison's files at once, so a longer list is cut short, but never to only the App's bookkeeping, which is at most two
	 */
	const { data: { files: diff = [] } } = await octokit.rest.repos.compareCommitsWithBasehead({
		owner: repo.owner,
		repo: repo.name,
		basehead: `${onto}...${pr.head.sha}`,
	});
	const changed = diff.flatMap((f) => [f.filename].concat(f.previous_filename ?? []));
	if (changed.length > 0 && onlyBookkeeping(changed)) {
		return closeMatching(target, 'it');
	}
	/** @type {Commit} */
	const headCommit = {
		owner: repo.owner,
		name: repo.name,
		head: pr.head.sha,
	};
	const ci = await ciFailures(octokit, headCommit);
	if (ci.kind === 'failed') {
		// what its commits are on is its base's tip
		return await alreadySaid(target, ['stuck']) ?? remediate(target, ci, { baseTip: { ...headCommit, head: onto }, count: commits.count });
	}
	if (ci.kind === 'pending') {
		return { kind: 'pending', text: 'up to date; its CI is still running' };
	}
	return { kind: 'passed', text: `up to date; its CI passed${await hideStuck(target)}` };
}

/**
 * Keeps every open PR of the App's up to date (see `maintainPR`): each public one's outcome is logged, and nothing about a private one.
 * A repository's failure stops its other PRs until the next run. Returns how many public repositories (or installations) failed, but for those GitHub failed (see `isTransient`), which are only warned about, since the next run tries them again.
 * @type {(auth: Auth, accounts: Set<string>, options: { bot: () => Promise<string>, serverURL: string }) => Promise<number>}
 */
export async function maintain(auth, accounts, { bot, serverURL }) {
	const { repos, failures } = await reposWithAppPRs(auth, accounts, permissions);
	if (repos.length === 0) {
		core.info('no open PRs from the App’s branches to keep up to date');
		return failures;
	}
	/** @type {Context} */
	const context = {
		auth,
		bot: await bot(),
		serverURL,
		identities: new Map(),
	};
	let errors = failures;
	// one at a time, private repositories last, as the commands do
	await repos.filter((r) => !r.private).concat(repos.filter((r) => r.private)).reduce(
		async (previous, repo) => {
			await previous;
			try {
				const token = await installationToken(auth, repo.installationId, { repositoryNames: [repo.name], permissions });
				core.setSecret(token);
				const octokit = octokitFor(token, repo.private);
				await (await candidatePRs(octokit, repo, context.bot)).reduce(
					async (previousPR, pr) => {
						await previousPR;
						const { text } = await maintainPR(context, {
							repo,
							pr,
							octokit,
							token,
						});
						if (!repo.private) {
							core.info(`${serverURL}/${repo.repository}/pull/${pr.number}: ${text}`);
						}
					},
					Promise.resolve(),
				);
			} catch (error) {
			// a private repository's failure is never shown, and never fails the run; nor does GitHub failing a public one, since the next run tries it again: keeping its PRs up to date writes (comments, pushes), so it's never tried again in this one
				if (!repo.private && isTransient(error)) {
					core.warning(`${repo.repository}: ${messageOf(error)}; GitHub failing doesn’t fail the run, and the next run tries it again`);
				} else if (!repo.private) {
					errors += 1;
					core.warning(`${repo.repository}: ${messageOf(error)}`);
				}
			}
		},
		Promise.resolve(),
	);
	core.info('Open PRs in private repositories, if any, were also kept up to date; nothing about them is shown here.');
	return errors;
}
