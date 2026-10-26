import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import { appAuth, discover, parseAccounts } from '../lib/app.mjs';
import { checkSafely } from './check.mjs';
import { marker } from './marker.mjs';
import { upsertGist } from './gist.mjs';
import { report } from './report.mjs';

/** @typedef {import('./report.mjs').Written} Written */

// how the full report's gist is found again on the next run; a dry run has its own, so it never changes what the issue links to
const gistMarker = 'ljharb/actions fleet workflow drift report';
const dryRunGistMarker = `${gistMarker} (dry runs)`;

const { GITHUB_REPOSITORY = '' } = process.env;

/**
 * @type {(options: {
 *   octokit: ReturnType<typeof getOctokit>,
 *   owner: string,
 *   repo: string,
 *   author: string,
 *   found: { title: string, body: string } | null,
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
	// checked first, so that a run that can't write the report wastes nothing on checking
	const gistToken = core.getInput('gist-token');
	if (!gistToken) {
		core.setFailed('`gist-token` is required: the full report is kept in a secret gist. Add a `FLEET_GIST_TOKEN` repository secret with a token that can write gists: a fine-grained token with the “Gists” account permission set to “Read and write”, or a classic token with the `gist` scope.');
		return;
	}
	core.setSecret(gistToken);

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
	// the issue, the run summary, and the gist (which is secret, but readable by anyone with its link) are public, so private repositories are only counted
	const results = all.filter((r) => !r.private).map((r) => r.result);
	const privateCount = all.length - results.length;
	// an incomplete check is never reported as "no discrepancies"
	const found = all.length > 0 || failures.length > 0 ? report(results, privateCount, failures, { installed: checked.filter((s) => !s.external).length, external: checked.filter((s) => s.external).length }) : null;

	const dryRun = core.getBooleanInput('dry-run');
	// the gist first, since the summary and the issue link to it; then the summary, so a failure to update the issue still leaves the report in the run
	/** @type {Written} */
	let written;
	try {
		written = await upsertGist(getOctokit(gistToken), dryRun ? dryRunGistMarker : gistMarker, found ? found.parts : ['No discrepancies.']);
	} catch (error) {
		// the summary and the issue are still updated, saying so, so neither is left out of date
		written = { error: String(error) };
	}
	await core.summary.addRaw(found ? found.summary(written, false) : 'No discrepancies.').write();
	const [owner, repo] = (core.getInput('issue-repository') || GITHUB_REPOSITORY).split('/');
	const outcome = dryRun
		? 'dry run: no issue changes'
		: await upsertIssue({
			octokit: getOctokit(core.getInput('token', { required: true })),
			owner,
			repo,
			author: core.getInput('issue-author', { required: true }),
			found: found && { title: found.title, body: found.summary(written, true) },
		});

	core.info(`${all.length} of ${checked.length} repositories have discrepancies; ${'error' in written ? 'the full report could not be written to its gist' : `the full report is ${written.html_url}`}; ${outcome}`);
	if ('error' in written) {
		core.setFailed(`the full report could not be written to its gist: ${written.error}`);
	}
}

main().catch((error) => {
	core.setFailed(error instanceof Error ? error : String(error));
});
