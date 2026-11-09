import * as core from '@actions/core';

import {
	appAuth,
	discover,
	parseAccounts,
} from '../lib/app.mjs';
import { gistToken, publish } from '../lib/report.mjs';
import { checkRepos, permissions } from './check.mjs';
import { marker, report } from './report.mjs';

/** @import { Failure } from '../lib/app.mjs' */
/** @import { Result } from './report.mjs' */

// how the full report's gist is found again on the next run; a dry run has its own, so it never changes what the issue links to
const gistMarker = 'ljharb/actions fleet optional-job failures report';

async function main() {
	// checked first, so that a run that can't write the report wastes nothing on checking
	const token = gistToken();
	if (!token) {
		return;
	}

	const auth = appAuth(core.getInput('app-id', { required: true }), core.getInput('private-key', { required: true }));
	const accounts = parseAccounts(core.getInput('accounts'), process.env.GITHUB_REPOSITORY_OWNER || '');
	const {
		states,
		failures: discovered,
		waiting,
	} = await discover(auth, accounts, {
		sourceAccounts: parseAccounts(core.getInput('source-accounts'), ''),
		committer: core.getInput('committer'),
		needs: permissions,
	});
	discovered.forEach(({ scope, message }) => {
		core.warning(`${scope}: ${message}`);
	});

	// the repositories the workflow drift report checks, but an empty one, which has no CI to check
	const checked = states.filter((s) => s.stateError || (!s.archived && s.config.workflows !== false && s.defaultBranch));
	const all = await checkRepos(auth, checked);
	// the issue, the run summary, and the gist (which is secret, but readable by anyone with its link) are public, so private repositories are only counted
	/** @type {Result[]} */
	const results = all.flatMap((r) => (!r.private && 'jobs' in r && r.jobs.length > 0 ? [r] : []));
	const privateCount = all.filter((r) => r.private && 'jobs' in r && r.jobs.length > 0).length;
	const privateErrors = all.filter((r) => r.private && 'error' in r).length;
	/** @type {Failure[]} */
	const failures = discovered.concat(all.flatMap((r) => (!r.private && 'error' in r ? [{ scope: r.repository, message: r.error }] : [])));
	const total = results.length + privateCount;
	// an incomplete check is never reported as "no optional-job failures"
	const found = total > 0 || failures.length > 0 || privateErrors > 0 || waiting.length > 0
		? report(
			results,
			privateCount,
			failures,
			{
				installed: checked.filter((s) => !s.external).length,
				external: checked.filter((s) => s.external).length,
			},
			waiting,
			privateErrors,
		)
		: null;

	const { written, outcome } = await publish({
		auth,
		token,
		gist: {
			description: gistMarker,
			dryRunDescription: `${gistMarker} (dry runs)`,
			base: 'optional-failures',
		},
		issue: {
			marker,
			closing: 'No optional-job failures remain; closing.',
			unchanged: 'no optional-job failures',
		},
		found,
		none: 'No optional-job failures.',
	});

	core.info(`${total} of ${checked.length} repositories have optional-job failures; ${'error' in written ? 'the full report could not be written to its gist' : `the full report is ${written.html_url}`}; ${outcome}`);
	if ('error' in written) {
		core.setFailed(`the full report could not be written to its gist: ${written.error}`);
	}
}

main().catch((error) => {
	core.setFailed(error instanceof Error ? error : String(error));
});
