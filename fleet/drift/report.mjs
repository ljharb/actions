import { legend } from '../commands/syntax.mjs';
import { code, fence, split } from '../lib/markdown.mjs';
import {
	byAccount,
	fileLink,
	fitting,
	fullReportLink,
	inline,
	list,
	maxPartLength,
	problems,
	reportLink,
	runURL,
	serverURL,
	summaryProblems,
	thisRepository,
} from '../lib/report.mjs';
import { marker } from './marker.mjs';
import { templateFor } from './template.mjs';

/** @import { Drift, Result } from './check.mjs' */
/** @import { Failure } from '../lib/app.mjs' */
/** @typedef {{ installed: number, external: number }} Checked */
/** @import { Unit } from '../lib/markdown.mjs' */
/** @import { Report } from '../lib/report.mjs' */

export { maxPartLength, maxSummaryLength } from '../lib/report.mjs';

/** @type {(repository: string, name: string) => string} */
function workflowURL(repository, name) {
	return `${serverURL}/${repository}/blob/HEAD/.github/workflows/${encodeURIComponent(name)}`;
}

/** @type {(repository: string, name: string) => string} */
function workflowLink(repository, name) {
	return fileLink(workflowURL(repository, name), name);
}

// a missing file has nothing to link to, so it links to the template it should match, if there is one
/** @type {(name: string) => string} */
function templateLink(name) {
	const template = templateFor(name);
	return template ? fileLink(`${serverURL}/${thisRepository}/blob/HEAD/fleet/drift/templates/${template}`, name) : `<code>${inline(name)}</code>`;
}

/** @typedef {{ number: number, name: string, diff: string, repositories: string[] }} Shared */

/** @type {(drift: Drift) => string} */
function sharedKey({ name, diff }) {
	return JSON.stringify([name, diff]);
}

/**
 * Each drifted file whose diff is exactly the same (hunk headers and all) in more than one repository, numbered, by how many repositories it's in (most first), then by name, then by diff, each with every one of those repositories, in the order the report has them, keyed by `sharedKey`.
 * Hundreds of repositories can have the same diff (eg, when a template changes), and it's shown once instead of in each of their rows.
 * @type {(results: Result[]) => Map<string, Shared>}
 */
function sharedDiffs(results) {
	/** @type {Map<string, Omit<Shared, 'number'>>} */
	const all = new Map();
	results.forEach(({ repository, drifted }) => {
		drifted.forEach((drift) => {
			const key = sharedKey(drift);
			const found = all.get(key) ?? {
				name: drift.name,
				diff: drift.diff,
				repositories: [],
			};
			found.repositories.push(repository);
			all.set(key, found);
		});
	});
	/** @type {(a: string, b: string) => number} */
	const compare = (a, b) => (a < b ? -1 : Number(a > b));
	const sorted = Array.from(all, ([key, shared]) => ({ key, shared }))
		.filter(({ shared }) => shared.repositories.length > 1)
		.sort((a, b) => b.shared.repositories.length - a.shared.repositories.length || compare(a.shared.name, b.shared.name) || compare(a.shared.diff, b.shared.diff));
	return new Map(sorted.map(({ key, shared }, i) => [key, { number: i + 1, ...shared }]));
}

// GitHub renders a fenced block inside HTML only with blank lines around it
/** @type {(repository: string, drift: Drift, shared: Map<string, Shared>) => string} */
function diffSection(repository, { name, diff }, shared) {
	const sharedDiff = shared.get(sharedKey({ name, diff }));
	if (sharedDiff) {
		return `${workflowLink(repository, name)} (shared diff ${sharedDiff.number})`;
	}
	return [
		`<details><summary>${workflowLink(repository, name)}</summary>`,
		'',
		fence(diff, 'diff'),
		'',
		'</details>',
	].join('\n');
}

/** @type {(result: Result, shared: Map<string, Shared>) => string} */
function row({
	repository,
	missing,
	unexpected,
	drifted,
	unreadable,
	error,
}, shared) {
	const repo = fileLink(`${serverURL}/${repository}/tree/HEAD/.github/workflows`, repository);
	const other = [
		...error ? [`<code>${inline(error)}</code>`] : [],
		...unreadable.length > 0 ? [`unreadable: ${list(unreadable.map((name) => workflowLink(repository, name)))}`] : [],
	].join('\n');
	return [
		`<tr><td>${repo}</td>`,
		`<td>\n${list(missing.map(templateLink))}\n</td>`,
		`<td>\n${list(unexpected.map((name) => workflowLink(repository, name)))}\n</td>`,
		`<td>\n${list(drifted.map((d) => diffSection(repository, d, shared)))}\n</td>`,
		`<td>\n${other}\n</td></tr>`,
	].join('');
}

/** @typedef {{ owner: string, results: Result[] }} Account */

const tableHeader = '<tr><th>Repository</th><th>Missing</th><th>Unexpected</th><th>Drifted</th><th>Other</th></tr>';

/**
 * One collapsed table per account, with every one of its repositories, and every diff, as units of the full report:
 * a file of it that starts partway through the table opens it again, and one that ends partway through it closes it.
 * A drifted file with a shared diff names it, rather than showing it.
 * @type {(account: Account, shared: Map<string, Shared>) => Unit[]}
 */
function accountTable({ owner, results }, shared) {
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
		...results.map((result) => ({ text: row(result, shared), group })),
		{ text: group.close, group },
	];
}

/**
 * A shared diff, once, and every repository it's in, each linking to its file, as units of the full report: like an account's table, a file of it that starts partway through its list of repositories opens it again.
 * @type {(shared: Shared) => Unit[]}
 */
function sharedSection({
	number,
	name,
	diff,
	repositories,
}) {
	const label = `<b>Shared diff ${number}</b>: <code>${inline(name)}</code>, in ${repositories.length} repositories`;
	const group = {
		open: [
			`<details><summary>${label} (continued)</summary>`,
			'',
			'<ul>',
		].join('\n'),
		close: '</ul>\n\n</details>',
	};
	/** @type {Unit[]} */
	const noUnits = [];
	return noUnits.concat(
		{
			text: [
				`<details><summary>${label}</summary>`,
				'',
				fence(diff, 'diff'),
				'',
				'<ul>',
			].join('\n'),
			group,
		},
		repositories.map((repository) => ({ text: `<li>${fileLink(workflowURL(repository, name), repository)}</li>`, group })),
		{ text: group.close, group },
	);
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

// `waiting` are the logins of the accounts whose installation is waiting on them to approve the App's permissions, so their repositories weren't checked; that's not a failure, but the report says so
/** @type {(results: Result[], privateCount: number, failures: Failure[], checked: Checked, waiting?: string[]) => Report} */
// eslint-disable-next-line max-params
export function report(results, privateCount, failures, checked, waiting = []) {
	const total = results.length + privateCount;
	const count = checked.installed + checked.external;
	const sources = checked.external > 0 ? `, and ${checked.external} sources of forks it’s installed on` : '';
	/** @type {(updated: string) => string} */
	const intro = (updated) => [
		`[This run](${runURL}) checked the workflow files of ${checked.installed} repositories the fleet App is installed on${sources}, against the templates in [\`fleet/drift/templates\`](${serverURL}/${thisRepository}/tree/HEAD/fleet/drift/templates).`,
		`${total} have discrepancies${privateCount > 0 ? ` (${privateCount} of them private, so not listed)` : ''}.`,
		...updated ? [updated] : [],
	].join(' ');
	const accounts = byAccount(results);
	// in the order the tables have them, so each shared diff lists its repositories in that order
	const shared = sharedDiffs(accounts.flatMap((account) => account.results));
	const title = `Workflow drift: ${total} of ${count} repositories`;

	/** @type {(string | Unit)[]} */
	const noUnits = [];
	// everything: every failure, every repository, and every diff, in as many files as it takes
	const parts = split(
		noUnits.concat(
			`# ${title}`,
			'',
			intro('This report is updated in place on every run.'),
			problems(failures, waiting),
			accounts.flatMap((account) => noUnits.concat('', accountTable(account, shared))),
			shared.size > 0
				? noUnits.concat(
					'',
					'## Shared diffs',
					'',
					'Each of these diffs is exactly the same in every repository listed with it, so it’s shown here once, rather than in each of their rows; each of those rows names it by its number.',
					Array.from(shared.values()).flatMap((sharedDiff) => noUnits.concat('', sharedSection(sharedDiff))),
				)
				: [],
			'',
			legend(),
		),
		maxPartLength,
	);

	return {
		title,
		parts,
		summary(written, forIssue) {
			const fullReport = fullReportLink(written);
			/** @type {string[]} */
			const noLines = [];
			/** @type {(listFailures: boolean, withAccounts: boolean, detailed?: boolean) => string} */
			const render = (listFailures, withAccounts, detailed = true) => noLines.concat(
				forIssue ? [marker] : [],
				intro(forIssue ? 'This issue is updated in place on every run, and closed when there are none.' : ''),
				'',
				reportLink(written, 'every repository, every discrepancy, and every diff', detailed),
				summaryProblems(failures, waiting, listFailures, fullReport),
				accounts.length > 0
					? [''].concat(withAccounts
						? accountCounts(accounts)
						: [`${accounts.length} accounts have repositories with discrepancies; ${fullReport} has a table for each.`])
					: [],
				// last, so it's where anyone looking for how to act on the report expects it
				forIssue
					? [
						'',
						'<details><summary><b>Commands</b></summary>',
						'',
						legend({ heading: false }),
						'',
						'</details>',
					]
					: [],
			).join('\n');
			// the failures (and the accounts waiting on approval), the accounts' counts, or the links to each file (or the gist's error), are left to the full report (or the log) only when there are too many for this; without all three, nothing in it grows with the fleet, so it always fits
			return fitting(
				[
					render(true, true),
					render(false, true),
					render(true, false),
					render(false, false),
				],
				() => render(false, false, false),
			);
		},
	};
}
