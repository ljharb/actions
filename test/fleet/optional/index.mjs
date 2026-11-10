import path from 'path';
import { pathToFileURL } from 'url';

import test from 'tape';

import { installedRepo, privateKey } from '../lib/helpers/github.mjs';
import { runChild } from '../drift/helpers/child.mjs';

/** @import { Scenario as GitHubScenario, Recorded } from '../lib/helpers/github.mjs' */
/** @import { MergeScenario, CI } from '../commands/helpers/merge.mjs' */
/** @import { ChildResult } from '../drift/helpers/child.mjs' */

const marker = '<!-- ljharb/actions: fleet optional-job failures -->';
const bot = { login: 'fleet-bot[bot]' };
const issueToken = 'token ghs_installation_99';
const script = path.join('fleet', 'optional', 'index.mjs');
// the commands' preload mocks both the App's API (as the drift report's does) and CI (as `/merge`'s does)
const preload = pathToFileURL(path.join(import.meta.dirname, '..', 'commands', 'helpers', 'preload.mjs')).href;
const gistMarker = 'ljharb/actions fleet optional-job failures report';

/** @type {(options?: { isPrivate?: boolean, archived?: boolean, config?: string, branch?: string | null }) => { data: Record<string, unknown> }} */
function repo({
	isPrivate = false,
	archived = false,
	config,
	branch = 'main',
} = {}) {
	return {
		data: {
			isArchived: archived,
			isPrivate,
			defaultBranchRef: branch === null ? null : { name: branch },
			config: typeof config === 'string' ? { text: config } : null,
			workflows: null,
		},
	};
}

/** @type {(id: number, file: string, jobs: Record<string, unknown>[]) => { id: number, jobs: Record<string, unknown>[] } & Record<string, unknown>} */
function workflowRun(id, file, jobs) {
	return {
		id,
		path: file,
		check_suite_id: id, // eslint-disable-line camelcase
		jobs,
	};
}

/** @type {(repository: string, id: number, name: string, conclusion: string, annotations?: string[]) => Record<string, unknown>} */

function checkRun(repository, id, name, conclusion, annotations = []) {
	return {
		app: { slug: 'github-actions' },
		id,
		name,
		status: 'completed',
		conclusion,
		url: `https://api.github.com/repos/${repository}/check-runs/${id}`,
		check_suite: { id: Math.floor(id / 10) }, // eslint-disable-line camelcase
		annotations: annotations.map((message) => ({ annotation_level: 'failure', message })), // eslint-disable-line camelcase
	};
}

/** @type {(repository: string, id: number, runId: number) => Record<string, unknown>} */
function failingStepJob(repository, id, runId) {
	return {
		check_run_url: `https://api.github.com/repos/${repository}/check-runs/${id}`, // eslint-disable-line camelcase
		run_id: runId, // eslint-disable-line camelcase
		steps: [{ name: 'lint', conclusion: 'failure' }],
	};
}

/**
 * CI on a commit with a job whose `continue-on-error` hides its failure (`hidden`), in `.github/workflows/node.yml`, and one whose step's does, in two runs of `.github/workflows/tests.yml`, which say the same.
 * Each check run is in the check suite of the workflow run whose id is a tenth of its own.
 * @type {(repository: string, base: number) => CI}
 */
function failingCI(repository, base) {
	return {
		runs: [
			workflowRun(base, '.github/workflows/node.yml', []),
			workflowRun(base + 1, '.github/workflows/tests.yml', [failingStepJob(repository, (base + 1) * 10, base + 1)]),
			workflowRun(base + 2, '.github/workflows/tests.yml@refs/pull/1/merge', [failingStepJob(repository, (base + 2) * 10, base + 2)]),
		],
		checkRuns: [
			checkRun(repository, base * 10, 'hidden', 'failure'),
			checkRun(repository, (base + 1) * 10, 'tests', 'success', ['Process completed with exit code 1.']),
			checkRun(repository, (base + 2) * 10, 'tests', 'success', ['Process completed with exit code 1.']),
		],
	};
}

/** @type {(github: GitHubScenario, merge?: MergeScenario, env?: Record<string, string>, throwStringOnSplit?: string) => ChildResult} */

function run(github, merge = {}, env = {}, throwStringOnSplit = '') {
	return runChild([script], {
		preload,
		scenario: /** @type {any} */ ({ github, merge, ...throwStringOnSplit ? { throwStringOnSplit } : {} }),
		env: {
			'INPUT_APP-ID': '1234',
			'INPUT_PRIVATE-KEY': privateKey(),
			INPUT_ACCOUNTS: 'ljharb',
			'INPUT_DRY-RUN': 'false',
			'INPUT_GIST-TOKEN': 'ghp_gist',
			GITHUB_REPOSITORY: 'ljharb/actions',
			GITHUB_RUN_ID: '42',
			...env,
		},
	});
}

/** @type {(requests: Recorded[]) => Recorded[]} */
function gistWrites(requests) {
	return requests.filter((r) => r.method !== 'GET' && (/^\/gists/).test(r.path));
}

/** @type {(requests: Recorded[]) => Recorded[]} */
function issueWrites(requests) {
	return requests.filter((r) => r.method !== 'GET' && (/^\/repos\/ljharb\/actions\/issues/).test(r.path));
}

/** @type {(requests: Recorded[]) => string} */
function gistContent(requests) {
	return gistWrites(requests).flatMap((r) => Object.values(r.body.files).filter(Boolean).map((file) => String(/** @type {{ content: string }} */ (file).content))).join('\n');
}

/** @type {Record<string, unknown>} */
const openIssue = {
	number: 5,
	state: 'open',
	title: 'Optional-job failures: 1 of 1 repositories',
	body: `${marker}\nold`,
	user: bot,
	html_url: 'https://github.com/ljharb/actions/issues/5', // eslint-disable-line camelcase
	created_at: '2026-01-01T00:00:00Z', // eslint-disable-line camelcase
};

test('fleet/optional: lists the failures `continue-on-error` hides, in a new secret gist, and summarizes them in a new issue and the run summary', (t) => {
	const server = 'https://github.example';
	const {
		status,
		stdout,
		stderr,
		requests,
		summary,
	} = run(
		{
			installations: [
				{ id: 1, account: { login: 'ljharb' } },
				{ id: 2, account: { login: 'stranger' } },
			],
			installationRepos: {
				1: [
					installedRepo('ljharb', 'archived'),
					installedRepo('ljharb', 'broken'),
					installedRepo('ljharb', 'clean'),
					installedRepo('ljharb', 'empty'),
					installedRepo('ljharb', 'flaky'),
					installedRepo('ljharb', 'gone'),
					installedRepo('ljharb', 'optout'),
					installedRepo('ljharb', 'secret', { private: true }),
					installedRepo('ljharb', 'secret-broken', { private: true }),
				],
			},
			repos: {
				'ljharb/archived': repo({ archived: true }),
				'ljharb/broken': repo(),
				'ljharb/clean': repo(),
				'ljharb/empty': repo({ branch: null }),
				'ljharb/flaky': repo({ branch: 'trunk' }),
				// `ljharb/gone` is not found by GraphQL
				'ljharb/optout': repo({ config: '{ "workflows": false }' }),
				'ljharb/secret': repo({ isPrivate: true }),
				'ljharb/secret-broken': repo({ isPrivate: true }),
			},
			issues: [],
			gists: [],
			created: { number: 77, html_url: `${server}/ljharb/actions/issues/77` }, // eslint-disable-line camelcase
		},
		{
			refs: {
				'ljharb/broken': { status: 500, body: { message: 'ljharb/broken exploded' } },
				'ljharb/clean': 'sha-clean',
				'ljharb/flaky': 'sha-flaky',
				'ljharb/secret': 'sha-secret',
				'ljharb/secret-broken': 'sha-secret-broken',
			},
			ci: {
				'sha-flaky': failingCI('ljharb/flaky', 100),
				'sha-secret': failingCI('ljharb/secret', 200),
				'sha-secret-broken': { error: { status: 502 } },
			},
		},
		{ GITHUB_SERVER_URL: server },
	);

	t.equal(status, 0, 'exits successfully');
	t.equal(stderr, '', 'nothing on stderr');
	t.match(stdout, /^::add-mask::ghp_gist$/m, 'masks the gist token');
	t.match(stdout, /^::warning::installation 2: its account is not in the allowed accounts; skipped$/m, 'warns about each failure to discover');
	t.match(stdout, /^2 of 6 repositories have optional-job failures; the full report is https:\/\/gist\.github\.com\/new-gist; created https:\/\/github\.example\/ljharb\/actions\/issues\/77$/m, 'logs the outcome: archived, opted-out, and empty repositories aren’t checked');
	t.notOk(stdout.includes('secret'), 'the log never names a private repository');

	const refReads = requests.filter((r) => (/\/git\/ref\//).test(r.path));
	t.deepEqual(
		refReads.map((r) => r.path),
		[
			'/repos/ljharb/broken/git/ref/heads%2Fmain',
			'/repos/ljharb/clean/git/ref/heads%2Fmain',
			'/repos/ljharb/flaky/git/ref/heads%2Ftrunk',
			'/repos/ljharb/secret/git/ref/heads%2Fmain',
			'/repos/ljharb/secret-broken/git/ref/heads%2Fmain',
		],
		'reads each default branch’s tip, one at a time, private repositories last',
	);
	const tokens = requests.filter((r) => (/\/access_tokens$/).test(r.path) && r.body?.permissions?.checks);
	t.deepEqual(
		tokens.map((r) => r.body),
		[{
			permissions: {
				contents: 'read',
				metadata: 'read',
				checks: 'read',
				actions: 'read',
				statuses: 'read',
			},
		}],
		'with one token for the installation, that can only read',
	);

	const [gistWrite] = gistWrites(requests);
	t.equal(`${gistWrite.method} ${gistWrite.path}`, 'POST /gists', 'creates the gist, since there is none');
	t.equal(gistWrite.body.public, false, 'a secret one');
	t.equal(gistWrite.body.description, gistMarker, 'described so it’s found again next time');
	t.deepEqual(Object.keys(gistWrite.body.files), ['optional-failures.md'], 'in its one file');

	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['POST /repos/ljharb/actions/issues'], 'creates one issue, and nothing else');
	t.ok(writes.every((r) => r.authorization === issueToken), 'as the App’s bot');
	const { title, body } = writes[0].body;
	t.equal(title, 'Optional-job failures: 2 of 6 repositories', 'titled with how many repositories have such failures, of how many were checked');

	const intro = `[This run](${server}/ljharb/actions/actions/runs/42) checked CI on the tip of the default branch of 6 repositories the fleet App is installed on, for failures that \`continue-on-error\` hides, which GitHub doesn’t count as CI failing. 2 have such failures (1 of them private, so not listed).`;
	const incomplete = [
		'⚠️ Some repositories could not be checked, so this report is incomplete:',
		'- installation 2: `its account is not in the allowed accounts; skipped`',
		'- ljharb/broken: `could not be read (HTTP 500)`',
		'- ljharb/gone: `could not read the repository’s state`',
		'- 1 private repositories: `could not be checked`',
	].join('\n');
	const flaky = [
		'<details><summary><b>ljharb</b>: 1 repository</summary>',
		'',
		`- [\`ljharb/flaky\`](${server}/ljharb/flaky/commit/sha-flaky)`,
		`  - [\`.github/workflows/node.yml\`](${server}/ljharb/flaky/blob/sha-flaky/.github/workflows/node.yml), \`hidden\`: \`failure\``,
		`  - [\`.github/workflows/tests.yml\`](${server}/ljharb/flaky/blob/sha-flaky/.github/workflows/tests.yml), \`tests\`: \`step lint: failure\`, \`Process completed with exit code 1.\``,
		'',
		'</details>',
	].join('\n');
	const link = '**[The full report](https://gist.github.com/new-gist)** has every repository, and every job, with every one of its failures; it’s a secret gist, updated in place on every run.';
	t.equal(
		body,
		[
			marker,
			`${intro} This issue is updated in place on every run, and closed when there are none.`,
			'',
			link,
			'',
			incomplete,
			'',
			flaky,
		].join('\n'),
		'the issue: the counts, the gist’s link, what couldn’t be checked, and each failing job, by account and repository, with its workflow file and its messages, each once',
	);
	t.equal(
		summary,
		[
			intro,
			'',
			link,
			'',
			incomplete,
			'',
			flaky,
		].join('\n'),
		'the run summary is the same, without the marker',
	);
	t.equal(
		gistContent(requests),
		[
			'# Optional-job failures: 2 of 6 repositories',
			'',
			`${intro} This report is updated in place on every run.`,
			'',
			incomplete,
			'',
			flaky,
		].join('\n'),
		'the full report has it all',
	);
	[body, summary, gistContent(requests)].forEach((text) => {
		t.notOk(text.includes('ljharb/secret') || text.includes('stranger') || text.includes('exploded'), 'never names a private repository, an account that isn’t allowed, or quotes an error');
	});

	t.end();
});

test('fleet/optional: a dry run writes its own gist, and changes no issue', (t) => {
	const { status, stdout, requests } = run(
		{
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			installationRepos: { 1: [installedRepo('ljharb', 'flaky')] },
			repos: { 'ljharb/flaky': repo() },
			gists: [{
				id: 'dry',
				description: `${gistMarker} (dry runs)`,
				public: false,
				files: { 'optional-failures.md': {} },
			}],
		},
		{
			refs: { 'ljharb/flaky': 'sha-flaky' },
			ci: { 'sha-flaky': failingCI('ljharb/flaky', 100) },
		},
		{ 'INPUT_DRY-RUN': 'true' },
	);

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^1 of 1 repositories have optional-job failures; the full report is https:\/\/gist\.github\.com\/dry; dry run: no issue changes$/m, 'logs the outcome');
	t.deepEqual(gistWrites(requests).map((r) => `${r.method} ${r.path}`), ['PATCH /gists/dry'], 'updates the dry runs’ gist');
	t.deepEqual(requests.filter((r) => (/^\/repos\/ljharb\/actions\//).test(r.path)), [], 'never touches the report repository’s issues');
	t.end();
});

test('fleet/optional: closes the issue when nothing fails, and reopens it when something does', (t) => {
	const clean = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'clean')] },
		repos: { 'ljharb/clean': repo() },
		issues: [openIssue],
	});
	t.equal(clean.status, 0, 'exits successfully');
	t.match(clean.stdout, /^0 of 1 repositories have optional-job failures; the full report is https:\/\/gist\.github\.com\/new-gist; closed https:\/\/github\.com\/ljharb\/actions\/issues\/5$/m, 'logs the outcome');
	t.deepEqual(
		issueWrites(clean.requests).map((r) => [`${r.method} ${r.path}`, r.body]),
		[
			['POST /repos/ljharb/actions/issues/5/comments', { body: 'No optional-job failures remain; closing.' }],
			['PATCH /repos/ljharb/actions/issues/5', { state: 'closed' }],
		],
		'comments, and closes the open issue',
	);
	t.equal(gistContent(clean.requests), 'No optional-job failures.', 'the gist says so');
	t.equal(clean.summary, 'No optional-job failures.', 'as does the run summary');

	const none = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'clean')] },
		repos: { 'ljharb/clean': repo() },
		issues: [{ ...openIssue, state: 'closed' }],
	});
	t.match(none.stdout, /; no optional-job failures$/m, 'a closed issue is left as it is');
	t.deepEqual(issueWrites(none.requests), [], 'unchanged');

	const failing = run(
		{
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			installationRepos: { 1: [installedRepo('ljharb', 'flaky')] },
			repos: { 'ljharb/flaky': repo() },
			issues: [
				{ ...openIssue, state: 'closed' },
				// a newer one, opened by someone else, is never written to
				{
					...openIssue,
					number: 6,
					user: { login: 'someone' },
					created_at: '2026-02-01T00:00:00Z', // eslint-disable-line camelcase
				},
				// the drift report's issue is another report's
				{
					...openIssue,
					number: 7,
					body: '<!-- ljharb/actions: fleet workflow drift -->',
					created_at: '2026-03-01T00:00:00Z', // eslint-disable-line camelcase
				},
			],
		},
		{
			refs: { 'ljharb/flaky': 'sha-flaky' },
			ci: { 'sha-flaky': failingCI('ljharb/flaky', 100) },
		},
	);
	t.equal(failing.status, 0, 'exits successfully');
	const writes = issueWrites(failing.requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['PATCH /repos/ljharb/actions/issues/5'], 'updates its own issue, and no other');
	t.equal(writes[0].body.state, 'open', 'reopening it');
	t.equal(writes[0].body.title, 'Optional-job failures: 1 of 1 repositories', 'with its new title');
	t.ok(String(writes[0].body.body).startsWith(`${marker}\n`), 'and its new body');
	t.end();
});

test('fleet/optional: an incomplete run says so, and never closes the issue', (t) => {
	const { status, requests, summary } = run(
		{
			installations: [
				{ id: 1, account: { login: 'ljharb' }, permissions: { contents: 'read', metadata: 'read' } },
				{ id: 3, account: { login: 'other' } },
			],
			accounts: {},
			appPermissions: {
				contents: 'read',
				metadata: 'read',
				checks: 'read',
				actions: 'read',
				statuses: 'read',
			},
			installationRepos: {
				1: [installedRepo('ljharb', 'flaky')],
				3: [installedRepo('other', 'denied'), installedRepo('other', 'hidden', { private: true })],
			},
			repos: {
				'ljharb/flaky': repo(),
				'other/denied': repo(),
				'other/hidden': repo({ isPrivate: true }),
			},
			deniedPermissions: ['checks'],
			issues: [openIssue],
		},
		{},
		{ INPUT_ACCOUNTS: 'ljharb other' },
	);

	t.equal(status, 0, 'exits successfully');
	t.notOk(requests.some((r) => r.path.startsWith('/repos/ljharb/flaky/')), 'an installation waiting on its account to approve the permissions this needs is skipped');
	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['PATCH /repos/ljharb/actions/issues/5'], 'nothing fails, but the issue is updated, not closed');
	t.equal(writes[0].body.title, 'Optional-job failures: 0 of 2 repositories', 'counting what was checked');
	const text = String(writes[0].body.body);
	t.ok(text.includes('⏳ Waiting on permission approval: `ljharb`.'), 'naming the account waiting on approval');
	t.ok(text.includes('- other/denied: `could not be read (HTTP 422)`'), 'and a public repository whose token was refused');
	t.ok(text.includes('- 1 private repositories: `could not be checked`'), 'counting a private one');
	t.notOk(text.includes('hidden'), 'without naming it');
	t.ok(summary.includes('⏳ Waiting on permission approval'), 'the run summary says so too');
	t.end();
});

test('fleet/optional: failures', (t) => {
	const noToken = run({}, {}, { 'INPUT_GIST-TOKEN': '' });
	t.equal(noToken.status, 1, 'without a gist token, fails');
	t.match(noToken.stdout, /^::error::`gist-token` is required/m, 'saying so');
	t.deepEqual(noToken.requests, [], 'before reading anything');

	const gistFails = run(
		{
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			installationRepos: { 1: [installedRepo('ljharb', 'flaky')] },
			repos: { 'ljharb/flaky': repo() },
			gistError: { status: 500 },
		},
		{
			refs: { 'ljharb/flaky': 'sha-flaky' },
			ci: { 'sha-flaky': failingCI('ljharb/flaky', 100) },
		},
	);
	t.equal(gistFails.status, 1, 'a gist that can’t be written fails the run');
	t.match(gistFails.stdout, /^::error::the full report could not be written to its gist: HttpError/m, 'saying why');
	const writes = issueWrites(gistFails.requests);
	t.equal(writes.length, 1, 'after still writing the issue');
	t.ok(String(writes[0].body.body).includes('⚠️ **The full report could not be written to its gist**'), 'saying so');

	const appFails = run({
		installations: { status: 500 },
	});
	t.equal(appFails.status, 1, 'an error reading the App’s installations fails the run');
	t.match(appFails.stdout, /^::error::/m, 'as an error');

	const thrown = run({}, {}, { INPUT_ACCOUNTS: 'fleet-test-throw' }, 'fleet-test-throw');
	t.equal(thrown.status, 1, 'a thrown non-Error fails');
	t.match(thrown.stdout, /^::error::fleet-test-throw$/m, 'with the stringified value');
	t.end();
});
