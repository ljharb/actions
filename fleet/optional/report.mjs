import { code, split } from '../lib/markdown.mjs';
import {
	byAccount,
	fitting,
	fullReportLink,
	inline,
	maxPartLength,
	problems,
	reportLink,
	runURL,
	serverURL,
	summaryProblems,
} from '../lib/report.mjs';

/** @import { Failure } from '../lib/app.mjs' */
/** @import { OptionalFailure } from '../lib/ci.mjs' */
/** @import { Unit } from '../lib/markdown.mjs' */
/** @import { Report } from '../lib/report.mjs' */
/** @typedef {{ repository: string, head: string, jobs: OptionalFailure[] }} Result */
/** @typedef {{ owner: string, results: Result[] }} Account */
/** @typedef {{ installed: number, external: number }} Checked */

// identifies the report issue, which is not the workflow drift report's
export const marker = '<!-- ljharb/actions: fleet optional-job failures -->';

// a path in a URL: each segment encoded, and parentheses too, since a Markdown link's URL ends at one
/** @type {(path: string) => string} */
function urlPath(path) {
	return path.split('/').map((segment) => encodeURIComponent(segment).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

/** @type {(result: Result, failure: OptionalFailure) => string} */
function jobItem({ repository, head }, failure) {
	const where = failure.file ? `[${code(failure.file)}](${serverURL}/${repository}/blob/${head}/${urlPath(failure.file)})` : 'an unknown workflow file';
	return `  - ${where}, ${code(failure.job)}: ${failure.messages.join(', ')}`;
}

// a repository, linked to its default branch's tip, with each of its jobs whose failures `continue-on-error` hides
/** @type {(result: Result) => string} */
function repoItem(result) {
	return [`- [${code(result.repository)}](${serverURL}/${result.repository}/commit/${result.head})`].concat(result.jobs.map((job) => jobItem(result, job))).join('\n');
}

/**
 * One collapsed list per account, with every one of its repositories as a unit of the full report:
 * a file of it that starts partway through the list opens it again, and one that ends partway through it closes it.
 * @type {(account: Account) => Unit[]}
 */
function accountList({ owner, results }) {
	const label = `<b>${inline(owner)}</b>: ${results.length} ${results.length === 1 ? 'repository' : 'repositories'}`;
	// GitHub renders Markdown inside HTML only with blank lines around it
	const group = {
		open: `<details><summary>${label} (continued)</summary>\n`,
		close: '\n</details>',
	};
	return /** @type {Unit[]} */ ([]).concat(
		{ text: `<details><summary>${label}</summary>\n`, group },
		results.map((result) => ({ text: repoItem(result), group })),
		{ text: group.close, group },
	);
}

/** @type {(results: Result[]) => number} */
function jobCount(results) {
	return results.reduce((n, r) => n + r.jobs.length, 0);
}

// a row per account: how many of its repositories and jobs have such failures, but not which, so its size depends only on how many accounts there are
/** @type {(accounts: Account[]) => string[]} */
function accountCounts(accounts) {
	return [
		'| Account | Repositories with failures | Jobs with failures |',
		'| --- | --: | --: |',
	].concat(accounts.map(({ owner, results }) => `| ${code(owner)} | ${results.length} | ${jobCount(results)} |`));
}

/**
 * The report of the failures `continue-on-error` hides, on the tip of each repository's default branch: `results` are the public repositories with any (see `Result`), and `privateCount` how many private ones have any, which are only counted.
 * `failures` are what couldn't be checked, `waiting` the logins of the accounts whose installation is waiting on them to approve the App's permissions, so their repositories weren't checked, and `privateErrors` how many private repositories couldn't be checked, which are only counted; any of them makes the report incomplete.
 * @type {(results: Result[], privateCount: number, failures: Failure[], checked: Checked, waiting?: string[], privateErrors?: number) => Report}
 */
// eslint-disable-next-line max-params
export function report(results, privateCount, failures, checked, waiting = [], privateErrors = 0) {
	const total = results.length + privateCount;
	/** @type {Failure[]} */
	const unchecked = failures.concat(privateErrors > 0 ? [{ scope: `${privateErrors} private repositories`, message: 'could not be checked' }] : []);
	const count = checked.installed + checked.external;
	const sources = checked.external > 0 ? `, and ${checked.external} sources of forks it’s installed on` : '';
	/** @type {(updated: string) => string} */
	const intro = (updated) => [
		`[This run](${runURL}) checked CI on the tip of the default branch of ${checked.installed} repositories the fleet App is installed on${sources}, for failures that \`continue-on-error\` hides, which GitHub doesn’t count as CI failing.`,
		`${total} have such failures${privateCount > 0 ? ` (${privateCount} of them private, so not listed)` : ''}.`,
	].concat(updated ? [updated] : []).join(' ');
	const accounts = byAccount(results);
	const title = `Optional-job failures: ${total} of ${count} repositories`;
	const lists = accounts.flatMap((account) => /** @type {(string | Unit)[]} */ (['']).concat(accountList(account)));

	// everything: every failure, every repository, and every job, in as many files as it takes
	const parts = split(
		/** @type {(string | Unit)[]} */ ([]).concat(
			`# ${title}`,
			'',
			intro('This report is updated in place on every run.'),
			problems(unchecked, waiting),
			lists,
		),
		maxPartLength,
	);

	return {
		title,
		parts,
		summary(written, forIssue) {
			const fullReport = fullReportLink(written);
			/** @type {(kind: 'jobs' | 'counts' | false) => string[]} */
			const accountLines = (kind) => {
				if (accounts.length === 0) {
					return [];
				}
				if (kind === 'jobs') {
					return lists.map((unit) => (typeof unit === 'string' ? unit : unit.text));
				}
				return [''].concat(kind === 'counts'
					? accountCounts(accounts)
					: [`${accounts.length} accounts have repositories with such failures; ${fullReport} lists them all.`]);
			};
			/** @type {(listFailures: boolean, withAccounts: 'jobs' | 'counts' | false, detailed?: boolean) => string} */
			const render = (listFailures, withAccounts, detailed = true) => /** @type {string[]} */ ([]).concat(
				forIssue ? [marker] : [],
				intro(forIssue ? 'This issue is updated in place on every run, and closed when there are none.' : ''),
				'',
				reportLink(written, 'every repository, and every job, with every one of its failures', detailed),
				summaryProblems(unchecked, waiting, listFailures, fullReport, failures.length + privateErrors),
				accountLines(withAccounts),
			).join('\n');
			// every job, then only each account's counts, then neither, with the failures (and the accounts waiting on approval) listed, then only counted; then without the links to each file (or the gist's error), so that nothing in it grows with the fleet, and it always fits
			return fitting(
				[
					render(true, 'jobs'),
					render(false, 'jobs'),
					render(true, 'counts'),
					render(false, 'counts'),
					render(true, false),
					render(false, false),
				],
				() => render(false, false, false),
			);
		},
	};
}
