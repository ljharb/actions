import * as core from '@actions/core';

import { botLogin, octokitFor } from './app.mjs';
import { upsertGist } from './gist.mjs';
import { issueOctokit, upsertReportIssue } from './issues.mjs';
import { code, html } from './markdown.mjs';

/** @import { Failure, appAuth } from './app.mjs' */
/** @import { Gist } from './gist.mjs' */
/** @typedef {Gist | { error: string }} Written */
/** @typedef {{ title: string, parts: string[], summary: (written: Written, forIssue: boolean) => string }} Report */

// GitHub's limit for an issue's body is 65536 characters; a run summary's is 1 MiB, so this fits in both
export const maxSummaryLength = 60000;
/*
 * a gist's API (and its page) cut a file short past 1 MB, so a full report is in files of at most this many characters:
 * each is at most 3 bytes in UTF-8 (a surrogate pair is 2 characters, and 4 bytes), with room left for saying which part it is
 */
export const maxPartLength = 300000;

export const {
	GITHUB_SERVER_URL: serverURL = 'https://github.com',
	GITHUB_REPOSITORY: thisRepository = '',
} = process.env;
export const runURL = `${serverURL}/${thisRepository}/actions/runs/${process.env.GITHUB_RUN_ID}`;

// third-party text in HTML: a blank line would end GitHub's HTML block and let the rest render as Markdown, so it's kept to one line
/** @type {(s: string) => string} */
export function inline(s) {
	return html(s.replace(/\s*[\r\n]+\s*/g, ' ').trim());
}

/** @type {(href: string, name: string) => string} */
export function fileLink(href, name) {
	return `<a href="${html(href)}"><code>${inline(name)}</code></a>`;
}

/** @type {(items: string[]) => string} */
export function list(items) {
	return items.length > 0 ? `<ul>\n${items.map((item) => `<li>${item}</li>`).join('\n')}\n</ul>` : '';
}

/**
 * `results`, grouped by the account each one's `repository` is in, case-insensitively, in the order the results are in.
 * @type {<T extends { repository: string }>(results: T[]) => { owner: string, results: T[] }[]}
 */
export function byAccount(results) {
	/** @type {Map<string, { owner: string, results: (typeof results)[number][] }>} */
	const accounts = new Map();
	results.forEach((result) => {
		const [owner] = result.repository.split('/');
		const account = accounts.get(owner.toLowerCase()) ?? { owner, results: [] };
		account.results.push(result);
		accounts.set(owner.toLowerCase(), account);
	});
	return Array.from(accounts.values());
}

/** @type {(failure: Failure) => string} */
export function failureItem({ scope, message }) {
	return `- ${scope}: ${code(message)}`;
}

export const incomplete = '⚠️ Some repositories could not be checked, so this report is incomplete:';

/** @type {(waiting: string[]) => string} */
export function awaiting(waiting) {
	return `⏳ Waiting on permission approval: ${waiting.map(code).join(', ')}. Until each of these accounts approves the App’s permissions (in its settings, under “Applications”, or from GitHub’s email about them), its repositories aren’t checked.`;
}

/**
 * The lines of a full report saying what couldn't be checked: every failure, and every account waiting on permission approval.
 * @type {(failures: Failure[], waiting: string[]) => string[]}
 */
export function problems(failures, waiting) {
	return /** @type {string[]} */ ([]).concat(
		failures.length > 0
			? ['', incomplete].concat(failures.map(failureItem))
			: [],
		waiting.length > 0 ? ['', awaiting(waiting)] : [],
	);
}

/**
 * The lines of a summary saying what couldn't be checked: with `listed`, as the full report has them (see `problems`); otherwise, only how many (`count`, when one of `failures` stands for several), so that their size doesn't depend on how many there are.
 * @type {(failures: Failure[], waiting: string[], listed: boolean, fullReport: string, count?: number) => string[]}
 */
// eslint-disable-next-line max-params
export function summaryProblems(failures, waiting, listed, fullReport, count = failures.length) {
	if (listed) {
		return problems(failures, waiting);
	}
	return /** @type {string[]} */ ([]).concat(
		failures.length > 0
			? ['', `⚠️ ${count} repositories or installations could not be checked, so this report is incomplete; ${fullReport} lists them all.`]
			: [],
		waiting.length > 0
			? ['', `⏳ ${waiting.length} accounts are waiting on permission approval, so their repositories weren’t checked; ${fullReport} lists them.`]
			: [],
	);
}

/**
 * A summary's link to the full report in `written`, which `has` what it says (eg, `every repository, …`); or, when it couldn't be written, that it couldn't.
 * Without `detailed`, its size doesn't depend on anything.
 * @type {(written: Written, has: string, detailed: boolean) => string}
 */
export function reportLink(written, has, detailed) {
	if ('error' in written) {
		return `⚠️ **The full report could not be written to its gist**${detailed ? ` (${code(written.error)})` : ''}, so this run failed, and [its log](${runURL}) has the error; the next run will try again.`;
	}
	const inFiles = written.files.length > 1
		? ` It’s in ${written.files.length} files, each small enough (under 1 MB) for GitHub to show in full; read them in order${detailed ? `: ${written.files.map((f, i) => `[${i + 1}](${f.raw_url})`).join(' · ')}` : ''}.`
		: '';
	return `**[The full report](${written.html_url})** has ${has}; it’s a secret gist, updated in place on every run.${inFiles}`;
}

/** @type {(written: Written) => string} */
export function fullReportLink(written) {
	return 'error' in written ? 'the full report' : `[the full report](${written.html_url})`;
}

/**
 * The first of `texts` that fits in a summary; else, `fallback`'s, which must always fit.
 * @type {(texts: string[], fallback: () => string) => string}
 */
export function fitting(texts, fallback) {
	return texts.find((text) => text.length <= maxSummaryLength) ?? fallback();
}

/**
 * The token a report's full report is written to a gist with; a run without one fails, saying so, before anything else, so that a run that can't write the report wastes nothing on checking.
 * @type {() => string | null}
 */
export function gistToken() {
	const token = core.getInput('gist-token');
	if (!token) {
		core.setFailed('`gist-token` is required: the full report is kept in a secret gist. Add a `FLEET_GIST_TOKEN` repository secret with a token that can write gists: a fine-grained token with the “Gists” account permission set to “Read and write”, or a classic token with the `gist` scope.');
		return null;
	}
	core.setSecret(token);
	return token;
}

/**
 * Publishes `found` (or, when it's `null`, `none`): its full report to its gist (`gist.description`, or, in a dry run, `gist.dryRunDescription`, so that a dry run never changes what the issue links to; its files named for `gist.base`); then its summary to the run's; then, unless it's a dry run, its summary to its issue (see `upsertReportIssue`, which `issue` is passed to), as the App's bot.
 * A failure to write the gist is in the summary and the issue (which are still updated, so neither is left out of date), and in `written`, for the caller to fail the run with.
 * @type {(options: {
 *   auth: ReturnType<typeof appAuth>,
 *   token: string,
 *   gist: { description: string, dryRunDescription: string, base: string },
 *   issue: { marker: string, closing: string, unchanged: string },
 *   found: Report | null,
 *   none: string,
 * }) => Promise<{ written: Written, outcome: string }>}
 */
export async function publish({
	auth,
	token,
	gist,
	issue,
	found,
	none,
}) {
	const dryRun = core.getBooleanInput('dry-run');
	/** @type {Written} */
	let written;
	try {
		written = await upsertGist(
			octokitFor(token, false),
			{
				description: dryRun ? gist.dryRunDescription : gist.description,
				base: gist.base,
			},
			found ? found.parts : [none],
		);
	} catch (error) {
		written = { error: String(error) };
	}
	await core.summary.addRaw(found ? found.summary(written, false) : none).write();
	const [owner, repo] = (core.getInput('issue-repository') || thisRepository).split('/');
	// the issue is written by the App's bot, with a token for only its repository
	const outcome = dryRun
		? 'dry run: no issue changes'
		: await upsertReportIssue({
			octokit: await issueOctokit(auth, owner, repo),
			owner,
			repo,
			bot: await botLogin(auth),
			marker: issue.marker,
			closing: issue.closing,
			unchanged: issue.unchanged,
			found: found && { title: found.title, body: found.summary(written, true) },
		});
	return { written, outcome };
}
