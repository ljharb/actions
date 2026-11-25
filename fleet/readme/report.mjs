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
} from '../lib/report.mjs';
import { marker } from './marker.mjs';
import { readmePath } from './readme.mjs';

/** @import { Result } from './check.mjs' */
/** @import { Failure } from '../lib/app.mjs' */
/** @import { Unit } from '../lib/markdown.mjs' */
/** @import { Report } from '../lib/report.mjs' */
/** @typedef {{ installed: number, external: number }} Checked */

/** @type {(repository: string, name: string) => string} */
function readmeLink(repository, name) {
	return fileLink(`${serverURL}/${repository}/blob/HEAD/${encodeURIComponent(name)}`, repository);
}

// GitHub renders a fenced block inside HTML only with blank lines around it
/** @type {(result: Result) => string} */
function row({
	repository,
	readme = readmePath,
	drifted,
	diff,
	error,
}) {
	return [
		`<tr><td>${readmeLink(repository, readme)}</td>`,
		`<td>\n${list(drifted.map((c) => `<code>${c}</code>`))}\n</td>`,
		`<td>\n${diff ? [
			'<details><summary>diff</summary>', '', fence(diff, 'diff'), '', '</details>',
		].join('\n') : ''}\n</td>`,
		`<td>\n${error ? `<code>${inline(error)}</code>` : ''}\n</td></tr>`,
	].join('');
}

/** @typedef {{ owner: string, results: Result[] }} Account */

const tableHeader = '<tr><th>Repository</th><th>Drifted</th><th>Diff</th><th>Other</th></tr>';

/**
 * One collapsed table per account, with every one of its repositories, and every diff, as units of the full report (see `accountTable` in `../drift/report.mjs`).
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

/** @type {(results: Result[], category: Result['drifted'][number]) => number} */
function count(results, category) {
	return results.filter((r) => r.drifted.includes(category)).length;
}

// a row per account: how many of its repositories have each kind of discrepancy, but not which, so its size depends only on how many accounts there are
/** @type {(accounts: Account[]) => string[]} */
function accountCounts(accounts) {
	return [
		'| Account | Repositories with discrepancies | File name | Heading | Badges | Links | Repositories with other problems |',
		'| --- | --: | --: | --: | --: | --: | --: |',
	].concat(accounts.map(({ owner, results }) => `| ${code(owner.replace(/\s*[\r\n]+\s*/g, ' '))} | ${results.length} | ${count(results, 'filename')} | ${count(results, 'heading')} | ${count(results, 'badges')} | ${count(results, 'links')} | ${results.filter((r) => r.error).length} |`));
}

/**
 * The README drift report, as `report` in `../drift/report.mjs` makes the workflow drift report: `waiting` are the accounts waiting on permission approval.
 * @type {(results: Result[], privateCount: number, failures: Failure[], checked: Checked, waiting?: string[]) => Report}
 */
// eslint-disable-next-line max-params
export function report(results, privateCount, failures, checked, waiting = []) {
	const total = results.length + privateCount;
	const covered = checked.installed + checked.external;
	const sources = checked.external > 0 ? `, and ${checked.external} sources of forks it’s installed on` : '';
	/** @type {(updated: string) => string} */
	const intro = (updated) => [
		`[This run](${runURL}) checked the README file name, heading, badges, and their link definitions of ${checked.installed} repositories that publish a package, that the fleet App is installed on${sources}.`,
		`${total} have discrepancies${privateCount > 0 ? ` (${privateCount} of them private, so not listed)` : ''}.`,
		...updated ? [updated] : [],
	].join(' ');
	const accounts = byAccount(results);
	const title = `README drift: ${total} of ${covered} repositories`;

	/** @type {(string | Unit)[]} */
	const noUnits = [];
	const parts = split(
		noUnits.concat(
			`# ${title}`,
			'',
			intro('This report is updated in place on every run.'),
			problems(failures, waiting),
			accounts.flatMap((account) => noUnits.concat('', accountTable(account))),
			'',
			legend({ report: 'readme' }),
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
				forIssue
					? [
						'',
						'<details><summary><b>Commands</b></summary>',
						'',
						legend({ heading: false, report: 'readme' }),
						'',
						'</details>',
					]
					: [],
			).join('\n');
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
