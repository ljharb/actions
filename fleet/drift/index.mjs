import * as core from '@actions/core';

import {
	appAuth,
	discover,
	parseAccounts,
} from '../lib/app.mjs';
import { gistToken, publish } from '../lib/report.mjs';
import { checkSafely } from './check.mjs';
import { marker } from './marker.mjs';
import { report } from './report.mjs';

// how the full report's gist is found again on the next run; a dry run has its own, so it never changes what the issue links to
const gistMarker = 'ljharb/actions fleet workflow drift report';

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
		failures,
		waiting,
	} = await discover(auth, accounts, {
		sourceAccounts: parseAccounts(core.getInput('source-accounts'), ''),
		committer: core.getInput('committer'),
	});
	failures.forEach(({ scope, message }) => {
		core.warning(`${scope}: ${message}`);
	});

	const checked = states.filter((s) => s.stateError || (!s.archived && s.config.workflows !== false));
	const all = (await Promise.all(checked.map(async (s) => {
		const result = await checkSafely(s);
		return result ? [{ result, private: s.private }] : [];
	}))).flat();
	// the issue, the run summary, and the gist (which is secret, but readable by anyone with its link) are public, so private repositories are only counted
	const results = all.filter((r) => !r.private).map((r) => r.result);
	const privateCount = all.length - results.length;
	// an incomplete check is never reported as "no discrepancies"
	const found = all.length > 0 || failures.length > 0 || waiting.length > 0
		? report(
			results,
			privateCount,
			failures,
			{
				installed: checked.filter((s) => !s.external).length,
				external: checked.filter((s) => s.external).length,
			},
			waiting,
		)
		: null;

	const { written, outcome } = await publish({
		auth,
		token,
		gist: {
			description: gistMarker,
			dryRunDescription: `${gistMarker} (dry runs)`,
			base: 'workflow-drift',
		},
		issue: {
			marker,
			closing: 'No discrepancies remain; closing.',
			unchanged: 'no discrepancies',
		},
		found,
		none: 'No discrepancies.',
	});

	core.info(`${all.length} of ${checked.length} repositories have discrepancies; ${'error' in written ? 'the full report could not be written to its gist' : `the full report is ${written.html_url}`}; ${outcome}`);
	if ('error' in written) {
		core.setFailed(`the full report could not be written to its gist: ${written.error}`);
	}
}

main().catch((error) => {
	core.setFailed(error instanceof Error ? error : String(error));
});
