import * as core from '@actions/core';

import { botLogin } from '../lib/app.mjs';
import { code } from '../lib/markdown.mjs';
import {
	assess,
	behindReason,
	candidatePRs,
	entryKey,
	fastForward,
	fits,
	messageOf,
	queueOctokit,
	readPermissions,
	readQueue,
	repoOctokit,
	writePermissions,
	writeQueue,
} from '../lib/merge.mjs';

/** @typedef {import('../lib/app.mjs').Octokit} Octokit */
/** @typedef {import('../lib/app.mjs').RepoState} RepoState */
/** @typedef {import('../lib/merge.mjs').Entry} Entry */
/** @typedef {import('../lib/merge.mjs').PR} PR */
/** @typedef {import('./syntax.mjs').Filters} Filters */
/**
 * `progress.queued` becomes whether the queue holds a public PR this command queued as soon as the queue is written, so that even if what follows (eg, replying) fails, the command's 👀 stays until the queue resolves that PR.
 * @typedef {{
 *   auth: ReturnType<typeof import('../lib/app.mjs').appAuth>,
 *   dryRun: boolean,
 *   commentId: number,
 *   issueNumber: number,
 *   finishOther: (commentId: number, ok: boolean) => Promise<void>,
 *   progress: { queued: boolean },
 * }} MergeContext
 */
/**
 * What happened to one PR: `ok` is whether it went as asked (merged, or queued, or, in a dry run, anything that isn't an error); `entry`, a PR to queue.
 * @typedef {{ text: string, ok: boolean, error?: boolean, key?: string, url?: string, entry?: Entry }} Outcome
 */
/** @typedef {{ state: RepoState, named: boolean, outcomes: Outcome[] }} Row */

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
} = process.env;

/** @type {(repository: string, number: number) => string} */
function prURL(repository, number) {
	return `${GITHUB_SERVER_URL}/${repository}/pull/${number}`;
}

/** @type {(dryRun: boolean, now: string, later: string) => string} */
function tense(dryRun, now, later) {
	return dryRun ? later : now;
}

/**
 * What `/merge` does with one PR (or, in a dry run, would do).
 * @type {(context: MergeContext, job: { state: RepoState, pr: PR, bot: string, read: Octokit, write: () => Promise<Octokit> }) => Promise<Outcome>}
 */
async function mergePR(context, {
	state, pr, bot, read, write,
}) {
	const url = prURL(state.repository, pr.number);
	const target = {
		owner: state.owner, name: state.name, number: pr.number, base: pr.base.ref, head: pr.head.sha,
	};
	const assessment = await assess(read, target, bot);
	const not = tense(context.dryRun, 'not merged', 'would not merge');
	if (assessment.kind === 'refused') {
		return { text: `${not} ${url}: ${assessment.reason}`, ok: context.dryRun };
	}
	if (assessment.kind === 'behind') {
		return { text: `${not} ${url}: ${behindReason(target.base)}`, ok: context.dryRun };
	}
	if (assessment.kind === 'failed') {
		return { text: `${not} ${url}: its checks failed: ${assessment.failures.join(', ')}`, ok: context.dryRun };
	}
	if (assessment.kind === 'pending' && context.dryRun) {
		return { text: `would queue ${url}: its checks haven’t all finished, so it would be merged once they pass`, ok: true };
	}
	if (assessment.kind === 'pending') {
		return {
			text: `queued ${url}: its checks haven’t all finished, so it’ll be merged once they pass`,
			ok: true,
			url,
			entry: {
				repository: state.repository,
				number: pr.number,
				headSha: pr.head.sha,
				base: pr.base.ref,
				commentId: context.commentId,
				issueNumber: context.issueNumber,
				queuedAt: new Date().toISOString(),
				private: state.private,
			},
		};
	}
	if (context.dryRun) {
		return { text: `would merge ${url}`, ok: true };
	}
	const octokit = await write();
	try {
		await fastForward(octokit, target);
	} catch (error) {
		return {
			text: `not merged ${url}: ${messageOf(error)}`, ok: false, error: true,
		};
	}
	return { text: `merged ${url}`, ok: true };
}

/**
 * Every PR `/merge` takes in one repository, in order; an error stops that repository's (a private one's says nothing).
 * @type {(context: MergeContext, state: RepoState, bot: string) => Promise<Outcome[]>}
 */
async function mergeRepo(context, state, bot) {
	/** @type {Outcome[]} */
	const outcomes = [];
	try {
		if (state.stateError) {
			throw new Error(state.stateError);
		}
		const read = await repoOctokit(context.auth, state, readPermissions);
		/** @type {Promise<Octokit> | undefined} */
		let writer;
		// the token that can push is only asked for when a PR is actually merged
		const write = () => {
			writer ??= repoOctokit(context.auth, state, writePermissions);
			return writer;
		};
		for (const pr of await candidatePRs(read, state, bot)) {
			const outcome = await mergePR(context, { // eslint-disable-line no-await-in-loop
				state, pr, bot, read, write,
			});
			outcomes.push({ ...outcome, key: entryKey({ repository: state.repository, number: pr.number }) });
		}
	} catch (error) {
		// a private repository's error is never output, as with `/fix`
		if (state.private) {
			outcomes.push({ text: '', ok: false });
		} else {
			const text = messageOf(error);
			core.warning(`${state.repository}: ${text}`);
			outcomes.push({
				text: `failed: ${code(text)}`, ok: false, error: true,
			});
		}
	}
	return outcomes;
}

/**
 * Queues `wanted`, replacing any entry for the same PR (the newest command wins), and drops the entries of the other PRs this command already resolved.
 * A command whose last public entry another replaced is finished as it stood, since the newer one has taken its PR over.
 * Returns the entries that didn't fit.
 * @type {(context: MergeContext, resolved: Set<string>, wanted: Entry[]) => Promise<Set<Entry>>}
 */
async function enqueue(context, resolved, wanted) {
	const [owner, repo] = GITHUB_REPOSITORY.split('/');
	const octokit = await queueOctokit(context.auth, owner, repo);
	const { entries, exists } = await readQueue(octokit, owner, repo);
	const replaced = entries.filter((e) => resolved.has(entryKey(e)));
	const queue = entries.filter((e) => !resolved.has(entryKey(e)));
	/** @type {Set<Entry>} */
	const full = new Set();
	for (const entry of wanted) {
		if (fits([...queue, entry])) {
			queue.push(entry);
		} else {
			full.add(entry);
		}
	}
	// a public PR that didn't fit is a failure of this command, which its queued PRs' reaction must say
	if ([...full].some((e) => !e.private)) {
		for (const entry of wanted.filter((e) => !full.has(e))) {
			entry.commandFailed = true;
		}
	}
	if (replaced.length > 0 || queue.length > entries.length - replaced.length) {
		await writeQueue(octokit, {
			owner, repo, exists,
		}, queue);
	}
	context.progress.queued = queue.some((e) => !e.private && e.commentId === context.commentId); // eslint-disable-line no-param-reassign
	/** @type {Map<number, boolean>} */
	const others = new Map();
	for (const entry of replaced.filter((e) => !e.private && e.commentId !== context.commentId)) {
		others.set(entry.commentId, (others.get(entry.commentId) ?? true) && !entry.commandFailed);
	}
	for (const [commentId, ok] of others) {
		if (!queue.some((e) => !e.private && e.commentId === commentId)) {
			await context.finishOther(commentId, ok); // eslint-disable-line no-await-in-loop
		}
	}
	return full;
}

/**
 * Runs `/merge` (or `/dry-run merge`), failing the run if any public repository failed, or the queue can't be used: the rows of its reply, and whether it went as asked; whether it queued a public PR is in `context.progress`.
 * Whether any private repository matched, or was queued, never shows in any of them.
 * @type {(context: MergeContext, states: RepoState[], filters: Pick<Filters, 'repositories' | 'accounts'>) => Promise<{ rows: string[], ok: boolean }>}
 */
export async function runMerge(context, states, { repositories, accounts }) {
	const selected = states.filter((s) => !s.external
		&& (s.stateError || !s.archived)
		&& (repositories.size === 0 || repositories.has(s.repository.toLowerCase()))
		&& (accounts.size === 0 || accounts.has(s.owner.toLowerCase())));
	const bot = selected.length > 0 ? await botLogin(context.auth) : '';

	/** @type {Row[]} */
	const rows = [];
	// one at a time, private repositories last, as `/fix` does
	for (const state of [...selected.filter((s) => !s.private), ...selected.filter((s) => s.private)]) {
		const outcomes = await mergeRepo(context, state, bot); // eslint-disable-line no-await-in-loop
		rows.push({
			state, named: repositories.has(state.repository.toLowerCase()), outcomes,
		});
	}

	const outcomes = rows.flatMap((r) => r.outcomes);
	const publicOutcomes = rows.filter((r) => !r.state.private).flatMap((r) => r.outcomes);
	const failed = rows.filter((r) => !r.state.private && r.outcomes.some((o) => o.error)).length;
	if (failed > 0) {
		core.setFailed(`${failed} ${failed === 1 ? 'repository' : 'repositories'} could not be merged`);
	}
	const commandFailed = publicOutcomes.some((o) => !o.ok);
	/** @type {Map<Outcome, Entry>} */
	const wanted = new Map(outcomes.flatMap((o) => (o.entry ? [[o, commandFailed ? { ...o.entry, commandFailed } : o.entry]] : [])));
	/** @type {Map<Outcome, string>} */
	const unqueued = new Map();
	/** @type {string | null} */
	let queueError = null;
	// even with nothing to queue, so that whether it fails says nothing about which PRs (eg, a private one's) matched
	if (!context.dryRun) {
		try {
			const full = await enqueue(context, new Set(outcomes.flatMap((o) => (o.key ? [o.key] : []))), [...wanted.values()]);
			for (const [o, entry] of wanted) {
				if (full.has(entry)) {
					unqueued.set(o, 'the merge queue is full; run `/merge` again once it has room');
				}
			}
		} catch (error) {
			queueError = messageOf(error);
			core.setFailed(queueError);
			for (const o of wanted.keys()) {
				unqueued.set(o, 'the merge queue could not be written');
			}
		}
	}
	/** @type {(o: Outcome) => Outcome} */
	const settled = (o) => {
		const why = unqueued.get(o);
		return why ? { text: `not queued ${o.url}: ${why}`, ok: false } : o;
	};
	const settledRows = rows.map((r) => ({ ...r, outcomes: r.outcomes.map(settled) }));
	const publicSettled = settledRows.filter((r) => !r.state.private).flatMap((r) => r.outcomes);

	const shown = settledRows.filter((r) => !r.state.private && (r.outcomes.length > 0 || r.named));
	return {
		rows: shown.map((r) => `| ${code(r.state.repository)} | ${r.outcomes.length > 0 ? r.outcomes.map((o) => o.text).join('<br>') : 'nothing to merge'} |`),
		ok: failed === 0 && !queueError && publicSettled.every((o) => o.ok),
	};
}
