import { legend } from '../commands/syntax.mjs';
import {
	code,
	fence,
	html,
	split,
} from '../lib/markdown.mjs';
import { templateFor } from './check.mjs';
import { marker } from './marker.mjs';

/** @typedef {import('./check.mjs').Result} Result */
/** @typedef {import('../lib/app.mjs').Failure} Failure */
/** @typedef {{ installed: number, external: number }} Checked */
/** @typedef {import('../lib/markdown.mjs').Unit} Unit */
/** @typedef {import('./gist.mjs').Gist} Gist */
/** @typedef {Gist | { error: string }} Written */
/** @typedef {{ title: string, parts: string[], summary: (written: Written, forIssue: boolean) => string }} Report */

// GitHub's limit for an issue's body is 65536 characters; a run summary's is 1 MiB, so this fits in both
export const maxSummaryLength = 60000;
/*
 * a gist's API (and its page) cut a file short past 1 MB, so the full report is in files of at most this many characters:
 * each is at most 3 bytes in UTF-8 (a surrogate pair is 2 characters, and 4 bytes), with room left for saying which part it is
 */
export const maxPartLength = 300000;

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
	GITHUB_RUN_ID,
} = process.env;
const runURL = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;

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

/** @type {(result: Result) => string} */
function row({
	repository, missing, unexpected, drifted, unreadable, error,
}) {
	const repo = fileLink(`${GITHUB_SERVER_URL}/${repository}/tree/HEAD/.github/workflows`, repository);
	const other = [
		...error ? [`<code>${inline(error)}</code>`] : [],
		...unreadable.length > 0 ? [`unreadable: ${list(unreadable.map((name) => workflowLink(repository, name)))}`] : [],
	].join('\n');
	return [
		`<tr><td>${repo}</td>`,
		`<td>\n${list(missing.map(templateLink))}\n</td>`,
		`<td>\n${list(unexpected.map((name) => workflowLink(repository, name)))}\n</td>`,
		`<td>\n${list(drifted.map((d) => diffSection(repository, d)))}\n</td>`,
		`<td>\n${other}\n</td></tr>`,
	].join('');
}

/** @typedef {{ owner: string, results: Result[] }} Account */

// accounts' repositories, grouped case-insensitively, in the order the results are in
/** @type {(results: Result[]) => Account[]} */
function byAccount(results) {
	/** @type {Map<string, Account>} */
	const accounts = new Map();
	for (const result of results) {
		const [owner] = result.repository.split('/');
		const account = accounts.get(owner.toLowerCase()) ?? { owner, results: [] };
		account.results.push(result);
		accounts.set(owner.toLowerCase(), account);
	}
	return [...accounts.values()];
}

const tableHeader = '<tr><th>Repository</th><th>Missing</th><th>Unexpected</th><th>Drifted</th><th>Other</th></tr>';

/**
 * One collapsed table per account, with every one of its repositories, and every diff, as units of the full report:
 * a file of it that starts partway through the table opens it again, and one that ends partway through it closes it.
 * @type {(account: Account) => Unit[]}
 */
function accountTable({ owner, results }) {
	const label = `<b>${inline(owner)}</b>: ${results.length} ${results.length === 1 ? 'repository' : 'repositories'}`;
	const group = {
		open: [
			`<details><summary>${label} (continued)</summary>`,
			'',
			'<table>',
			tableHeader,
		].join('\n'),
		close: '</table>\n\n</details>',
	};
	return [
		{
			text: [
				`<details><summary>${label}</summary>`,
				'',
				'<table>',
				tableHeader,
			].join('\n'),
			group,
		},
		...results.map((result) => ({ text: row(result), group })),
		{ text: group.close, group },
	];
}

/** @type {(failure: Failure) => string} */
function failureItem({ scope, message }) {
	return `- ${scope}: ${code(message)}`;
}

/** @type {(results: Result[], key: 'missing' | 'unexpected' | 'drifted') => number} */
function files(results, key) {
	return results.reduce((n, r) => n + r[key].length, 0);
}

// a row per account: what it has, but not which repositories or files, so its size depends only on how many accounts there are
/** @type {(accounts: Account[]) => string[]} */
function accountCounts(accounts) {
	return [
		'| Account | Repositories with discrepancies | Missing files | Unexpected files | Drifted files | Repositories with other problems |',
		'| --- | --: | --: | --: | --: | --: |',
		...accounts.map(({ owner, results }) => `| ${code(owner.replace(/\s*[\r\n]+\s*/g, ' '))} | ${results.length} | ${files(results, 'missing')} | ${files(results, 'unexpected')} | ${files(results, 'drifted')} | ${results.filter((r) => r.error || r.unreadable.length > 0).length} |`),
	];
}

/** @type {(results: Result[], privateCount: number, failures: Failure[], checked: Checked) => Report} */
// eslint-disable-next-line max-params
export function report(results, privateCount, failures, checked) {
	const total = results.length + privateCount;
	const count = checked.installed + checked.external;
	const sources = checked.external > 0 ? `, and ${checked.external} sources of forks it’s installed on` : '';
	/** @type {(updated: string) => string} */
	const intro = (updated) => [
		`[This run](${runURL}) checked the workflow files of ${checked.installed} repositories the fleet App is installed on${sources}, against the templates in [\`fleet/drift/templates\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/tree/HEAD/fleet/drift/templates).`,
		`${total} have discrepancies${privateCount > 0 ? ` (${privateCount} of them private, so not listed)` : ''}.`,
		...updated ? [updated] : [],
	].join(' ');
	const incomplete = '⚠️ Some repositories could not be checked, so this report is incomplete:';
	const accounts = byAccount(results);
	const title = `Workflow drift: ${total} of ${count} repositories`;

	// everything: every failure, every repository, and every diff, in as many files as it takes
	const parts = split([
		`# ${title}`,
		'',
		intro('This report is updated in place on every run.'),
		...failures.length > 0 ? [
			'', incomplete, ...failures.map(failureItem),
		] : [],
		...accounts.flatMap((account) => ['', ...accountTable(account)]),
		'',
		legend(),
	], maxPartLength);

	return {
		title,
		parts,
		summary(written, forIssue) {
			const where = 'error' in written ? '' : written.html_url;
			// without `detailed`, its size doesn't depend on anything
			/** @type {(detailed: boolean) => string} */
			const link = (detailed) => {
				if ('error' in written) {
					return `⚠️ **The full report could not be written to its gist**${detailed ? ` (${code(written.error)})` : ''}, so this run failed, and [its log](${runURL}) has the error; the next run will try again.`;
				}
				const inFiles = written.files.length > 1
					? ` It’s in ${written.files.length} files, each small enough (under 1 MB) for GitHub to show in full; read them in order${detailed ? `: ${written.files.map((f, i) => `[${i + 1}](${f.raw_url})`).join(' · ')}` : ''}.`
					: '';
				return `**[The full report](${where})** has every repository, every discrepancy, and every diff; it’s a secret gist, updated in place on every run.${inFiles}`;
			};
			const fullReport = where ? `[the full report](${where})` : 'the full report';
			/** @type {(listFailures: boolean, withAccounts: boolean, detailed?: boolean) => string} */
			const render = (listFailures, withAccounts, detailed = true) => [
				...forIssue ? [marker] : [],
				intro(forIssue ? 'This issue is updated in place on every run, and closed when there are none.' : ''),
				'',
				link(detailed),
				...failures.length > 0 ? [
					'',
					...listFailures
						? [incomplete, ...failures.map(failureItem)]
						: [`⚠️ ${failures.length} repositories or installations could not be checked, so this report is incomplete; ${fullReport} lists them all.`],
				] : [],
				...accounts.length > 0 ? [
					'',
					...withAccounts
						? accountCounts(accounts)
						: [`${accounts.length} accounts have repositories with discrepancies; ${fullReport} has a table for each.`],
				] : [],
				// last, so it's where anyone looking for how to act on the report expects it
				...forIssue ? [
					'', '<details><summary><b>Commands</b></summary>', '', legend({ heading: false }), '', '</details>',
				] : [],
			].join('\n');
			// the failures, the accounts' counts, or the links to each file (or the gist's error), are left to the full report (or the log) only when there are too many for this; without all three, nothing in it grows with the fleet, so it always fits
			return [
				render(true, true),
				render(false, true),
				render(true, false),
				render(false, false),
			].find((text) => text.length <= maxSummaryLength) ?? render(false, false, false);
		},
	};
}
