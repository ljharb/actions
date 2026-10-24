import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import { appAuth, discover, parseAccounts } from '../lib/app.mjs';
import { code, html } from '../lib/markdown.mjs';
import { checkSafely, templateFor } from './check.mjs';

/** @typedef {import('./check.mjs').Result} Result */
/** @typedef {import('../lib/app.mjs').Failure} Failure */
/** @typedef {{ title: string, body: string, full: string }} Report */

const marker = '<!-- ljharb/actions: fleet workflow drift -->';
const maxBodyLength = 60000; // GitHub's limit is 65536 characters
const maxSummaryBytes = 1000000; // GitHub's limit is 1 MiB

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
	GITHUB_RUN_ID,
} = process.env;
const runURL = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;

/** @type {(text: string, info?: string) => string} */
function fence(text, info = '') {
	// file contents are third-party input: fence them longer than any backtick run inside, so they can't break out
	const ticks = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	return `${ticks}${info}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

// third-party text in HTML: a blank line would end GitHub's HTML block and let the rest render as Markdown, so it's kept to one line
/** @type {(s: string) => string} */
function inline(s) {
	return html(s.replace(/\s*[\r\n]+\s*/g, ' ').trim());
}

/** @type {(href: string, name: string) => string} */
function fileLink(href, name) {
	return `<a href="${html(href)}"><code>${inline(name)}</code></a>`;
}

/** @type {(repository: string, name: string) => string} */
function workflowLink(repository, name) {
	return fileLink(`${GITHUB_SERVER_URL}/${repository}/blob/HEAD/.github/workflows/${encodeURIComponent(name)}`, name);
}

// a missing file has nothing to link to, so it links to the template it should match, if there is one
/** @type {(name: string) => string} */
function templateLink(name) {
	const template = templateFor(name);
	return template ? fileLink(`${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/HEAD/fleet/drift/templates/${template}`, name) : `<code>${inline(name)}</code>`;
}

/** @type {(items: string[]) => string} */
function list(items) {
	return items.length > 0 ? `<ul>\n${items.map((item) => `<li>${item}</li>`).join('\n')}\n</ul>` : '';
}

// GitHub renders a fenced block inside HTML only with blank lines around it
/** @type {(repository: string, drift: Result['drifted'][number]) => string} */
function diffSection(repository, { name, diff }) {
	return [
		`<details><summary>${workflowLink(repository, name)}</summary>`,
		'',
		fence(diff, 'diff'),
		'',
		'</details>',
	].join('\n');
}

/** @type {(result: Result, withDiffs: boolean) => string} */
function row({
	repository, missing, unexpected, drifted, unreadable, error,
}, withDiffs) {
	const repo = fileLink(`${GITHUB_SERVER_URL}/${repository}/tree/HEAD/.github/workflows`, repository);
	const drift = drifted.map((d) => (withDiffs ? diffSection(repository, d) : workflowLink(repository, d.name)));
	const other = [
		...error ? [`<code>${inline(error)}</code>`] : [],
		...unreadable.length > 0 ? [`unreadable: ${list(unreadable.map((name) => workflowLink(repository, name)))}`] : [],
	].join('\n');
	return [
		`<tr><td>${repo}</td>`,
		`<td>\n${list(missing.map(templateLink))}\n</td>`,
		`<td>\n${list(unexpected.map((name) => workflowLink(repository, name)))}\n</td>`,
		`<td>\n${list(drift)}\n</td>`,
		`<td>\n${other}\n</td></tr>`,
	].join('');
}

/** @type {(results: Result[]) => Map<string, number>} */
function accountTotals(results) {
	/** @type {Map<string, number>} */
	const totals = new Map();
	for (const { repository } of results) {
		const key = repository.split('/')[0].toLowerCase();
		totals.set(key, (totals.get(key) ?? 0) + 1);
	}
	return totals;
}

// one collapsed table per account, in the order the results are in; only the first `diffs` results get their diffs
/** @type {(results: Result[], diffs: number, totals: Map<string, number>) => string[]} */
function accountTables(results, diffs, totals) {
	/** @type {Map<string, { owner: string, rows: string[] }>} */
	const accounts = new Map();
	results.forEach((result, i) => {
		const [owner] = result.repository.split('/');
		const account = accounts.get(owner.toLowerCase()) ?? { owner, rows: [] };
		account.rows.push(row(result, i < diffs));
		accounts.set(owner.toLowerCase(), account);
	});
	return [...accounts.values()].map(({ owner, rows }) => [
		`<details><summary><b>${inline(owner)}</b>: ${rows.length}${totals.get(owner.toLowerCase()) === rows.length ? '' : ` of ${totals.get(owner.toLowerCase())}`} ${totals.get(owner.toLowerCase()) === 1 ? 'repository' : 'repositories'}</summary>`,
		'',
		'<table>',
		'<tr><th>Repository</th><th>Missing</th><th>Unexpected</th><th>Drifted</th><th>Other</th></tr>',
		...rows,
		'</table>',
		'',
		'</details>',
	].join('\n'));
}

// the largest `n` in [0, max] for which `ok(n)` holds, given that it holds for every smaller `n` too
/** @type {(max: number, ok: (n: number) => boolean) => number} */
function largest(max, ok) {
	let low = 0;
	let high = max;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (ok(mid)) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low;
}

/** @type {(results: Result[], privateCount: number, failures: Failure[], checked: { installed: number, external: number }) => Report} */
// eslint-disable-next-line max-params
function report(results, privateCount, failures, checked) {
	const total = results.length + privateCount;
	const count = checked.installed + checked.external;
	const sources = checked.external > 0 ? `, and ${checked.external} sources of forks it’s installed on` : '';
	/** @type {(shownFailures: number, where: string) => string[]} */
	const intro = (shownFailures, where) => [
		marker,
		`[This run](${runURL}) checked the workflow files of ${checked.installed} repositories the fleet App is installed on${sources}, against the templates in [\`fleet/drift/templates\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/tree/HEAD/fleet/drift/templates). ${total} have discrepancies${privateCount > 0 ? ` (${privateCount} of them private, so not listed)` : ''}. This issue is updated in place on every run, and closed when there are none.`,
		...failures.length > 0 ? [
			'',
			'⚠️ Some repositories could not be checked, so this report is incomplete:',
			...failures.slice(0, shownFailures).map(({ scope, message }) => `- ${scope}: ${code(message)}`),
			...shownFailures < failures.length ? [`- _…${failures.length - shownFailures} more ${where}._`] : [],
		] : [],
		'',
	];
	const totals = accountTotals(results);

	/** @type {(limit: (text: string) => boolean, where: string) => string} */
	const build = (limit, where) => {
		/** @type {(shownFailures: number, shown: number, diffs: number) => string} */
		const render = (shownFailures, shown, diffs) => {
			const drifted = results.slice(0, shown).filter((r) => r.drifted.length > 0).length;
			const withDiffs = results.slice(0, Math.min(shown, diffs)).filter((r) => r.drifted.length > 0).length;
			return [
				...intro(shownFailures, where),
				...accountTables(results.slice(0, shown), diffs, totals),
				...withDiffs < drifted ? ['', `_Diffs for ${drifted - withDiffs} more repositories are ${where}._`] : [],
				...shown < results.length ? ['', `_…${results.length - shown} more repositories ${where}._`] : [],
			].join('\n');
		};
		// failures first, then every row it can, then as many whole diffs as fit: a diff is never cut short
		const shownFailures = largest(failures.length, (n) => limit(render(n, 0, 0)));
		const shown = largest(results.length, (n) => limit(render(shownFailures, n, 0)));
		return render(shownFailures, shown, largest(shown, (n) => limit(render(shownFailures, shown, n))));
	};

	return {
		title: `Workflow drift: ${total} of ${count} repositories`,
		body: build((t) => t.length <= maxBodyLength, `omitted for length; see [the run summary](${runURL})`),
		full: build((t) => Buffer.byteLength(t) <= maxSummaryBytes, 'omitted: the run summary is full'),
	};
}

/**
 * @type {(options: {
 *   octokit: ReturnType<typeof getOctokit>,
 *   owner: string,
 *   repo: string,
 *   author: string,
 *   found: Report | null,
 * }) => Promise<string>}
 */
async function upsertIssue({
	octokit, owner, repo, author, found,
}) {
	const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
		owner,
		repo,
		state: 'all',
		creator: author,
		per_page: 100, // eslint-disable-line camelcase
	});
	const [issue] = issues
		.filter((i) => !i.pull_request && i.body?.includes(marker))
		.sort((a, b) => b.created_at.localeCompare(a.created_at));

	if (!found) {
		if (issue?.state === 'open') {
			await octokit.rest.issues.createComment({
				owner, repo, issue_number: issue.number, body: 'No discrepancies remain; closing.', // eslint-disable-line camelcase
			});
			await octokit.rest.issues.update({
				owner, repo, issue_number: issue.number, state: 'closed', // eslint-disable-line camelcase
			});
			return `closed ${issue.html_url}`;
		}
		return 'no discrepancies';
	}
	if (issue) {
		await octokit.rest.issues.update({
			owner, repo, issue_number: issue.number, title: found.title, body: found.body, state: 'open', // eslint-disable-line camelcase
		});
		return `updated ${issue.html_url}`;
	}
	const { data: created } = await octokit.rest.issues.create({
		owner, repo, title: found.title, body: found.body,
	});
	return `created ${created.html_url}`;
}

async function main() {
	const auth = appAuth(core.getInput('app-id', { required: true }), core.getInput('private-key', { required: true }));
	const accounts = parseAccounts(core.getInput('accounts'), process.env.GITHUB_REPOSITORY_OWNER || '');
	const { states, failures } = await discover(auth, accounts, {
		sourceAccounts: parseAccounts(core.getInput('source-accounts'), ''),
		committer: core.getInput('committer'),
	});
	for (const { scope, message } of failures) {
		core.warning(`${scope}: ${message}`);
	}

	const checked = states.filter((s) => s.stateError || (!s.archived && s.config.workflows !== false));
	const all = (await Promise.all(checked.map(async (s) => {
		const result = await checkSafely(s);
		return result ? [{ result, private: s.private }] : [];
	}))).flat();
	// the issue and the run summary are public, so private repositories are only counted
	const results = all.filter((r) => !r.private).map((r) => r.result);
	const privateCount = all.length - results.length;
	// an incomplete check is never reported as "no discrepancies"
	const found = all.length > 0 || failures.length > 0 ? report(results, privateCount, failures, { installed: checked.filter((s) => !s.external).length, external: checked.filter((s) => s.external).length }) : null;

	const [owner, repo] = (core.getInput('issue-repository') || GITHUB_REPOSITORY).split('/');
	// written first, so a failure to update the issue still leaves the report in the run
	await core.summary.addRaw(found ? found.full : 'No discrepancies.').write();
	const outcome = core.getBooleanInput('dry-run')
		? 'dry run: no issue changes'
		: await upsertIssue({
			octokit: getOctokit(core.getInput('token', { required: true })),
			owner,
			repo,
			author: core.getInput('issue-author', { required: true }),
			found,
		});

	core.info(`${all.length} of ${checked.length} repositories have discrepancies; ${outcome}`);
}

main().catch((error) => {
	core.setFailed(error instanceof Error ? error : String(error));
});
