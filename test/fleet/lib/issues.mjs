import nock from 'nock';
import test from 'tape';

import { appAuth } from '../../../fleet/lib/app.mjs';
import { isReportAuthor, issueOctokit, legacyAuthor } from '../../../fleet/lib/issues.mjs';
import { mockGitHub, privateKey } from './helpers/github.mjs';

/** @import { Recorded, Scenario } from './helpers/github.mjs' */
/** @import { Test } from 'tape' */

/** @type {(t: Test, scenario: Scenario) => Recorded[]} */
function setup(t, scenario) {
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const teardown = mockGitHub(scenario, (r) => requests.push(r));
	t.teardown(() => {
		teardown();
		// nock's net-connect block is process-wide; lift it so later test files in this tape process are unaffected
		nock.enableNetConnect();
	});
	return requests;
}

/**
 * Runs `fn`, returning the values it masks via `core.setSecret`, which writes `::add-mask::` commands to stdout.
 * @type {<T>(fn: () => Promise<T>) => Promise<{ result: T, masks: string[] }>}
 */
async function captureMasks(fn) {
	/** @type {string[]} */
	const masks = [];
	const { write } = process.stdout;
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk, /** @type {any[]} */ ...rest) {
		const match = String(chunk).match(/^::add-mask::(?<value>.*)$/m);
		if (match?.groups) {
			masks.push(match.groups.value);
			return true;
		}
		return write.call(process.stdout, chunk, ...rest);
	});
	try {
		return { result: await fn(), masks };
	} finally {
		process.stdout.write = write;
	}
}

const help = 'the App needs the “Issues: Read and write” repository permission, and must be installed on `o/r`. After that permission is added to the App, its installation on `o` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.';

test('issueOctokit', async (t) => {
	t.test('a token for only the repository, that can only write issues', async (st) => {
		const requests = setup(st, { repoInstallations: { 'o/r': 7 } });
		const { result: octokit, masks } = await captureMasks(() => issueOctokit(appAuth('1', privateKey()), 'o', 'r'));

		st.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['GET /repos/o/r/installation', 'POST /app/installations/7/access_tokens'], 'finds the App’s installation on the repository, then gets a token from it');
		st.match(requests[0].authorization, /^bearer /, 'finding it as the App');
		st.deepEqual(requests[1].body, { repositories: ['r'], permissions: { issues: 'write', metadata: 'read' } }, 'for only that repository, and only issues (and metadata)');
		st.deepEqual(masks, ['ghs_installation_7'], 'masking the token');

		await octokit.rest.issues.create({ owner: 'o', repo: 'r', title: 'x' });
		st.equal(requests.at(-1)?.authorization, 'token ghs_installation_7', 'which the Octokit uses');
		st.end();
	});

	/** @type {[string, Scenario, string][]} */
	const failures = [
		['without the Issues permission', { deniedPermissions: ['issues'] }, ' (HTTP 422)'],
		['not installed on the repository', { repoInstallations: { 'o/r': { status: 404 } } }, ' (HTTP 404)'],
		['an error without an HTTP status', { repoInstallations: { 'o/r': /** @type {any} */ ('not an id') } }, ''],
	];
	failures.forEach(([label, scenario, status]) => {
		t.test(label, async (st) => {
			setup(st, scenario);
			await issueOctokit(appAuth('1', privateKey()), 'o', 'r').then(
				() => st.fail('should reject'),
				(e) => st.equal(e.message, `the fleet GitHub App could not get a token to write issues in \`o/r\`${status}: ${help}`, 'rejects, saying what the App needs'),
			);
			st.end();
		});
	});

	t.end();
});

test('issueOctokit: GitHub failing to make a token isn’t blamed on the App’s permissions', async (t) => {
	/** @type {(status: number) => ReturnType<typeof appAuth>} */
	function failing(status) {
		return /** @type {ReturnType<typeof appAuth>} */ (/** @type {unknown} */ (async () => {
			throw Object.assign(new Error('Server Error'), { status });
		}));
	}
	await issueOctokit(failing(500), 'o', 'r').then(
		() => t.fail('should reject'),
		(e) => t.equal(e.message, 'the fleet GitHub App could not get a token to write issues in `o/r` (HTTP 500): GitHub failed to make one, even when asked again, which isn’t about the App’s permissions: try again later', 'a server error says GitHub failed'),
	);
	await issueOctokit(failing(403), 'o', 'r').then(
		() => t.fail('should reject'),
		(e) => t.equal(e.message, `the fleet GitHub App could not get a token to write issues in \`o/r\` (HTTP 403): ${help}`, 'a client error still says what the App needs'),
	);
});

test('isReportAuthor', (t) => {
	t.equal(legacyAuthor, 'github-actions[bot]', 'the legacy author is GitHub Actions’ bot');
	t.ok(isReportAuthor('fleet-bot[bot]', 'fleet-bot[bot]'), 'the App’s bot');
	t.ok(isReportAuthor('Fleet-Bot[bot]', 'fleet-bot[bot]'), 'case-insensitively');
	t.ok(isReportAuthor('github-actions[bot]', 'fleet-bot[bot]'), 'GitHub Actions’ bot, whose report is adopted');
	t.notOk(isReportAuthor('mallory', 'fleet-bot[bot]'), 'not anyone else');
	t.notOk(isReportAuthor('fleet-bot', 'fleet-bot[bot]'), 'not a user with the App’s slug as their login');
	t.notOk(isReportAuthor(undefined, 'fleet-bot[bot]'), 'not a missing login');

	t.end();
});
