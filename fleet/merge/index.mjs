import * as core from '@actions/core';

import { appAuth, botLogin, parseAccounts } from '../lib/app.mjs';
import { issueOctokit } from '../lib/issues.mjs';
import { code, split } from '../lib/markdown.mjs';
import {
	assess,
	behindReason,
	fastForward,
	finishQueued,
	installationFor,
	maxQueueHours,
	messageOf,
	optionalNote,
	queueOctokit,
	readPermissions,
	readQueue,
	repoOctokit,
	statusOf,
	writePermissions,
	writeQueue,
} from '../lib/merge.mjs';
import { maintain } from './maintain.mjs';

/** @import { Entry } from '../lib/merge.mjs' */
/** @typedef {{ auth: ReturnType<typeof appAuth>, bot: () => Promise<string> }} App */
/**
 * What checking one queued PR came to: kept, to check again next time, or dropped, with whether it was merged (`ok`), and what to say about it (`null`: nothing, since it's private, or can't be shown to be public).
 * `error` is whether it's a public failure that fails the run.
 * @typedef {{ entry: Entry, keep: boolean, ok: boolean, text: string | null, error: boolean }} Result
 */

const maxBodyLength = 60000; // GitHub's limit for a comment is 65536 characters

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
	GITHUB_RUN_ID,
} = process.env;
const runURL = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;

const privateNote = 'Queued PRs in private repositories, if any, were also checked; nothing about them is shown here.';

/** @type {(entry: Entry, outcome: { ok: boolean, text: string | null, error?: boolean }) => Result} */
function drop(
	entry,
	{
		ok,
		text,
		error = false,
	},
) {
	return {
		entry,
		keep: false,
		ok,
		text,
		error,
	};
}

/** @type {(entry: Entry, error?: boolean) => Result} */
function keep(entry, error = false) {
	return {
		entry,
		keep: true,
		ok: true,
		text: null,
		error,
	};
}

/**
 * Checks one queued PR again, and merges it if it's ready; `visibility.shown` becomes whether it's public, once that's known.
 * @type {(app: App, entry: Entry, visibility: { shown: boolean }) => Promise<Result>}
 */
async function recheck({ auth, bot }, entry, visibility) {
	const [owner, name] = entry.repository.split('/');
	const url = `${GITHUB_SERVER_URL}/${entry.repository}/pull/${entry.number}`;
	const installationId = await installationFor(auth, owner, name);
	const repo = {
		installationId,
		name,
		private: entry.private,
	};
	const read = await repoOctokit(auth, repo, readPermissions);
	const { data: pr } = await read.rest.pulls.get({
		owner,
		repo: name,
		pull_number: entry.number, // eslint-disable-line camelcase
	});
	// a repository made private since is private now
	visibility.shown &&= !pr.base.repo.private; // eslint-disable-line no-param-reassign
	/** @type {(ok: boolean, text: string, error?: boolean) => Result} */
	const done = (ok, text, error) => drop(entry, {
		ok,
		text: visibility.shown ? text : null,
		error: error && visibility.shown,
	});
	if (pr.state !== 'open') {
		return pr.merged_at ? done(true, `already merged ${url}`) : done(false, `not merged ${url}: it was closed`);
	}
	// only what `/merge` was asked to merge is ever merged, and only into the branch it was asked to
	if (pr.head.sha !== entry.headSha || pr.base.ref !== entry.base) {
		return done(false, `not merged ${url}: the PR changed after \`/merge\`; run \`/merge\` again`);
	}
	const target = {
		owner,
		name,
		number: entry.number,
		base: entry.base,
		head: entry.headSha,
	};
	const assessment = await assess(read, target, await bot());
	if (assessment.kind === 'refused') {
		return done(false, `not merged ${url}: ${assessment.reason}`);
	}
	if (assessment.kind === 'pending' && Date.now() - Date.parse(entry.queuedAt) > maxQueueHours * 60 * 60 * 1000) {
		return done(false, `not merged ${url}: its checks still hadn’t all finished ${maxQueueHours} hours after \`/merge\`; run \`/merge\` again once they have`);
	}
	if (assessment.kind === 'pending') {
		return keep(entry);
	}
	if (assessment.kind === 'behind') {
		return done(false, `not merged ${url}: ${behindReason(target.base)}`);
	}
	if (assessment.kind === 'failed') {
		return done(false, `not merged ${url}: its checks failed: ${assessment.failures.join(', ')}${optionalNote(assessment)}`);
	}
	const write = await repoOctokit(auth, repo, writePermissions);
	try {
		await fastForward(write, target);
	} catch (error) {
		return done(false, `not merged ${url}: ${messageOf(error)}`, true);
	}
	return done(true, `merged ${url}${optionalNote(assessment)}`);
}

/**
 * Checks one queued PR again: one that's gone (or that the App can no longer see) is dropped, and one that couldn't be checked for any other reason is kept, to check again next time.
 * @type {(app: App, accounts: Set<string>, entry: Entry) => Promise<Result>}
 */
async function check(app, accounts, entry) {
	// an account that's no longer allowed is never acted on, nor said anything about
	if (!accounts.has(entry.repository.split('/')[0].toLowerCase())) {
		return drop(entry, { ok: false, text: null });
	}
	const visibility = { shown: !entry.private };
	try {
		return await recheck(app, entry, visibility);
	} catch (error) {
		if (statusOf(error) === 404) {
			return drop(entry, { ok: false, text: visibility.shown ? `not merged ${GITHUB_SERVER_URL}/${entry.repository}/pull/${entry.number}: it could not be read (HTTP 404)` : null });
		}
		if (visibility.shown) {
			core.warning(`${entry.repository}#${entry.number}: ${messageOf(error)}`);
		}
		return keep(entry, visibility.shown);
	}
}

/**
 * One reply per issue the resolved PRs were queued from (in practice, the report): only public ones are listed, and every reply ends the same way, whether or not any private one was resolved.
 * @type {(results: Result[]) => Map<number, string[]>}
 */
function replies(results) {
	/** @type {Map<number, string[]>} */
	const rows = new Map();
	for (const { entry, text } of results) {
		if (text) {
			const comment = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/issues/${entry.issueNumber}#issuecomment-${entry.commentId}`;
			rows.set(entry.issueNumber, [...rows.get(entry.issueNumber) ?? [], `| ${code(entry.repository)} | ${text} (queued by [this comment](${comment})) |`]);
		}
	}
	const table = { open: '| Repository | Outcome |\n| --- | --- |', close: '' };
	return new Map([...rows].map(([issueNumber, lines]) => [
		issueNumber,
		split(
			[
				`The merge queue, as of [this run](${runURL}):`,
				'',
				{ text: table.open, group: table },
				...lines.map((text) => ({ text, group: table })),
				'',
				privateNote,
			],
			maxBodyLength,
		),
	]));
}

/**
 * The queue after these results, in its order, and the commands they finished: ones whose last public PR is resolved. A command's reaction only ever reflects its public PRs, so that it says nothing about any private one.
 * @type {(all: Result[]) => { remaining: Entry[], changed: boolean, finished: number[], failedCommands: Set<number> }}
 */
function settle(all) {
	const dropped = all.filter((r) => !r.keep);
	const failedCommands = new Set(dropped.filter((r) => !r.entry.private && (!r.ok || r.entry.commandFailed)).map((r) => r.entry.commentId));
	let changed = dropped.length > 0;
	const remaining = all.filter((r) => r.keep).map(({ entry }) => {
		if (failedCommands.has(entry.commentId) && !entry.commandFailed) {
			changed = true;
			return { ...entry, commandFailed: true };
		}
		return entry;
	});
	const finished = [...new Set(dropped.filter((r) => !r.entry.private).map((r) => r.entry.commentId))]
		.filter((id) => !remaining.some((e) => !e.private && e.commentId === id));
	return {
		remaining,
		changed,
		finished,
		failedCommands,
	};
}

/**
 * Replies with what happened to the resolved public PRs, and swaps the reactions of the commands that are finished.
 * @type {(app: App, dropped: Result[], commands: { finished: number[], failedCommands: Set<number> }) => Promise<void>}
 */
async function report({ auth, bot }, dropped, { finished, failedCommands }) {
	const bodies = replies(dropped);
	if (finished.length === 0 && bodies.size === 0) {
		return;
	}
	const [owner, repo] = GITHUB_REPOSITORY.split('/');
	const octokit = await issueOctokit(auth, owner, repo);
	for (const [issueNumber, parts] of bodies) {
		for (const body of parts) {
			await octokit.rest.issues.createComment({ // eslint-disable-line no-await-in-loop
				owner,
				repo,
				issue_number: issueNumber, // eslint-disable-line camelcase
				body,
			});
		}
	}
	await core.summary.addRaw([...bodies.values()].flat().join('\n\n---\n\n')).write();
	for (const commentId of finished) {
		await finishQueued({ // eslint-disable-line no-await-in-loop
			octokit,
			owner,
			repo,
			commentId,
			bot: await bot(), // eslint-disable-line no-await-in-loop
			ok: !failedCommands.has(commentId),
		});
	}
}

/**
 * Checks every queued PR again, merging the ones that are ready; returns how many public ones failed.
 * @type {(app: App, accounts: Set<string>) => Promise<number>}
 */
async function runQueue(app, accounts) {
	const [owner, repo] = GITHUB_REPOSITORY.split('/');
	const queue = await queueOctokit(app.auth, owner, repo);
	const { entries, exists } = await readQueue(queue, owner, repo);
	if (entries.length === 0) {
		core.info('the merge queue is empty');
		return 0;
	}

	/** @type {Map<Entry, Result>} */
	const results = new Map();
	// one at a time, private repositories last, as the commands do
	for (const entry of [...entries.filter((e) => !e.private), ...entries.filter((e) => e.private)]) {
		results.set(entry, await check(app, accounts, entry)); // eslint-disable-line no-await-in-loop
	}
	const all = entries.map((e) => /** @type {Result} */ (results.get(e)));
	const {
		remaining,
		changed,
		finished,
		failedCommands,
	} = settle(all);
	if (changed) {
		await writeQueue(
			queue,
			{
				owner,
				repo,
				exists,
			},
			remaining,
		);
	}
	await report(app, all.filter((r) => !r.keep), { finished, failedCommands });
	return all.filter((r) => r.error).length;
}

/** @type {(error: unknown) => void} */
function fail(error) {
	core.setFailed(error instanceof Error ? error : String(error));
}

async function main() {
	const auth = appAuth(core.getInput('app-id', { required: true }), core.getInput('private-key', { required: true }));
	const accounts = parseAccounts(core.getInput('accounts'), process.env.GITHUB_REPOSITORY_OWNER || '');

	// looked up only once it's needed, and then only once
	/** @type {Promise<string> | undefined} */
	let botPromise;
	/** @type {App} */
	const app = {
		auth,
		bot() {
			botPromise ??= botLogin(auth);
			return botPromise;
		},
	};

	// the queue first, then every open PR of the App's, so that a failure of either doesn't keep the other from running
	try {
		const errors = await runQueue(app, accounts);
		if (errors > 0) {
			core.setFailed(`${errors} queued ${errors === 1 ? 'PR' : 'PRs'} could not be checked or merged`);
		}
	} catch (error) {
		fail(error);
	}
	try {
		const failed = await maintain(auth, accounts, { bot: app.bot, serverURL: GITHUB_SERVER_URL });
		if (failed > 0) {
			core.setFailed(`the App’s open PRs could not all be kept up to date (failures: ${failed})`);
		}
	} catch (error) {
		fail(error);
	}
}

main().catch(fail);
