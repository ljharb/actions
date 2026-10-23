import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import { appAuth, discover, parseAccounts } from '../lib/app.mjs';
import { code, html } from '../lib/markdown.mjs';
import { checkRepo } from './check.mjs';

/** @typedef {import('./check.mjs').Result} Result */
/** @typedef {import('../lib/app.mjs').Failure} Failure */
/** @typedef {{ title: string, body: string, full: string }} Report */

const marker = '<!-- ljharb/actions: fleet workflow drift -->';
const maxBodyLength = 60000; // GitHub's limit is 65536 characters
const maxSummaryBytes = 1000000; // GitHub's limit is 1 MiB
const maxDiffLength = 6000;

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

/** @type {(names: string[]) => string} */
function list(names) {
	return names.map(code).join(', ');
}

/** @type {(result: Result) => string} */
function row({
	repository, missing, unexpected, drifted, unreadable, error,
}) {
	const other = [...error ? [code(error)] : [], ...unreadable.length > 0 ? [`unreadable: ${list(unreadable)}`] : []].join('; ');
	return `| [${code(repository)}](${GITHUB_SERVER_URL}/${repository}) | ${list(missing)} | ${list(unexpected)} | ${list(drifted.map((d) => d.name))} | ${other} |`;
}

/** @type {(result: Result) => string} */
function section({
	repository, missing, unexpected, drifted, unreadable, error,
}) {
	return [
		`<details><summary><a href="${GITHUB_SERVER_URL}/${repository}/tree/HEAD/.github/workflows"><code>${repository}</code></a></summary>`,
		'',
		...error ? [`- ⚠️ ${code(error)}`] : [],
		...missing.length > 0 ? [`- missing: ${list(missing)}`] : [],
		...unexpected.length > 0 ? [`- unexpected, per \`engines.node\`: ${list(unexpected)}`] : [],
		...unreadable.length > 0 ? [`- unreadable: ${list(unreadable)}`] : [],
		...drifted.flatMap(({ name, diff }) => [
			'',
			`<details><summary>drifted: <code>${html(name)}</code></summary>`,
			'',
			fence(diff.length > maxDiffLength ? `${diff.slice(0, maxDiffLength)}\n… (truncated)` : diff, 'diff'),
			'',
			'</details>',
		]),
		'',
		'</details>',
	].join('\n');
}

// keeps as many of `items` as fit, noting how many were omitted
/** @type {(head: string[], items: string[], fits: (text: string) => boolean, omitted: (n: number) => string) => string} */
// eslint-disable-next-line max-params
function fit(head, items, fits, omitted) {
	let text = '';
	let shown = items.length;
	do {
		const n = items.length - shown;
		text = [
			...head, ...items.slice(0, shown), ...n > 0 ? [omitted(n)] : [],
		].join('\n');
		shown -= 1;
	} while (!fits(text) && shown >= 0);
	return text;
}

/** @type {(results: Result[], privateCount: number, failures: Failure[], checked: { installed: number, external: number }) => Report} */
// eslint-disable-next-line max-params
function report(results, privateCount, failures, checked) {
	const total = results.length + privateCount;
	const count = checked.installed + checked.external;
	const sources = checked.external > 0 ? `, and ${checked.external} sources of forks it’s installed on` : '';
	const intro = [
		marker,
		`[This run](${runURL}) checked the workflow files of ${checked.installed} repositories the fleet App is installed on${sources}, against the templates in [\`fleet/drift/templates\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/tree/HEAD/fleet/drift/templates). ${total} have discrepancies${privateCount > 0 ? ` (${privateCount} of them private, so not listed)` : ''}. This issue is updated in place on every run, and closed when there are none.`,
		...failures.length > 0 ? [
			'',
			'⚠️ Some repositories could not be checked, so this report is incomplete:',
			...failures.map(({ scope, message }) => `- ${scope}: ${code(message)}`),
		] : [],
		'',
	];
	const tableHead = ['| Repository | Missing | Unexpected | Drifted | Other |', '| --- | --- | --- | --- | --- |'];
	const rows = results.map(row);
	const sections = results.map(section);

	/** @type {(limit: (text: string) => boolean, where: string) => string} */
	const build = (limit, where) => {
		// the table gets up to half the budget; the details get what's left
		const table = fit([...intro, ...tableHead], rows, (t) => limit(`${t}${t}`), (n) => `| _…${n} more repositories ${where}_ | | | | |`);
		return fit([table, ''], sections, limit, (n) => `\n_…details for ${n} more repositories ${where}._`);
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
		const result = await checkRepo(s);
		return result ? [{ result, private: s.private }] : [];
	}))).flat();
	// the issue and the run summary are public, so private repositories are only counted
	const results = all.filter((r) => !r.private).map((r) => r.result);
	const privateCount = all.length - results.length;
	// an incomplete check is never reported as "no discrepancies"
	const found = all.length > 0 || failures.length > 0 ? report(results, privateCount, failures, { installed: checked.filter((s) => !s.external).length, external: checked.filter((s) => s.external).length }) : null;

	const [owner, repo] = (core.getInput('issue-repository') || GITHUB_REPOSITORY).split('/');
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
	await core.summary.addRaw(found ? found.full : 'No discrepancies.').write();
}

main().catch((error) => {
	core.setFailed(error instanceof Error ? error : String(error));
});
