import path from 'path';

import test from 'tape';

import { installedRepo, privateKey } from '../lib/helpers/github.mjs';
import { runChild } from './helpers/child.mjs';
import { nodeWorkflow, standardWorkflows, template } from './helpers/states.mjs';
import { versionFixture } from './helpers/versions.mjs';

/** @typedef {import('../lib/helpers/github.mjs').Scenario} Scenario */
/** @typedef {import('../lib/helpers/github.mjs').RepoSpec} RepoSpec */
/** @typedef {import('../lib/helpers/github.mjs').Recorded} Recorded */
/** @typedef {import('./helpers/child.mjs').ChildResult} ChildResult */

const marker = '<!-- ljharb/actions: fleet workflow drift -->';
const script = path.join('fleet', 'drift', 'index.mjs');

/**
 * @type {(options?: {
 *   workflows?: { name: string, text: string | null }[] | null,
 *   packageJson?: string,
 *   config?: string,
 *   archived?: boolean,
 *   isPrivate?: boolean,
 * }) => RepoSpec}
 */
function repo({
	workflows = standardWorkflows(), packageJson, config, archived = false, isPrivate = false,
} = {}) {
	return {
		data: {
			isArchived: archived,
			isPrivate,
			defaultBranchRef: { name: 'main' },
			config: typeof config === 'string' ? { text: config } : null,
			packageJson: typeof packageJson === 'string' ? { text: packageJson } : null,
			workflows: workflows && {
				entries: workflows.map(({ name, text }) => ({ name, type: 'blob', object: typeof text === 'string' ? { text } : {} })),
			},
		},
	};
}

/** @type {(name: string, text: string) => { name: string, text: string | null }[]} */
function replacing(name, text) {
	return [...standardWorkflows().filter((f) => f.name !== name), { name, text }];
}

/** @type {(github: Scenario, env?: Record<string, string>, extra?: { versions?: boolean, throwStringOnSplit?: string }) => ChildResult} */
function run(github, env = {}, extra = {}) {
	return runChild([script], {
		scenario: {
			github,
			...extra.versions ? { versions: versionFixture() } : {},
			...extra.throwStringOnSplit ? { throwStringOnSplit: extra.throwStringOnSplit } : {},
		},
		env: {
			'INPUT_APP-ID': '1234',
			'INPUT_PRIVATE-KEY': privateKey(),
			INPUT_ACCOUNTS: 'ljharb',
			INPUT_TOKEN: 'ghp_issues',
			'INPUT_ISSUE-AUTHOR': 'github-actions[bot]',
			'INPUT_DRY-RUN': 'false',
			GITHUB_REPOSITORY: 'ljharb/actions',
			GITHUB_RUN_ID: '42',
			...env,
		},
	});
}

/** @type {(requests: Recorded[], method: string, pattern: RegExp) => Recorded[]} */
function matching(requests, method, pattern) {
	return requests.filter((r) => r.method === method && pattern.test(r.path));
}

/** @type {(requests: Recorded[]) => Recorded[]} */
function issueWrites(requests) {
	return requests.filter((r) => r.method !== 'GET' && (/^\/repos\//).test(r.path));
}

test('fleet/drift: creates the report issue', (t) => {
	const bigText = `${'x'.repeat(7000)}\n`;
	const { status, stdout, stderr, requests, summary } = run({
		installations: [
			{ id: 1, account: { login: 'ljharb' } },
			{ id: 2, account: { login: 'stranger' } },
		],
		installationRepos: {
			1: [
				installedRepo('ljharb', 'clean'),
				installedRepo('ljharb', 'drifted'),
				installedRepo('ljharb', 'missing'),
				installedRepo('ljharb', 'secret', { private: true }),
				installedRepo('ljharb', 'archived'),
				installedRepo('ljharb', 'optout'),
				installedRepo('ljharb', 'gone'),
				installedRepo('ljharb', 'unreadable'),
				installedRepo('ljharb', 'unexpected'),
				installedRepo('ljharb', 'bigdiff'),
				installedRepo('ljharb', 'pipes'),
			],
		},
		repos: {
			'ljharb/clean': repo(),
			'ljharb/drifted': repo({ workflows: replacing('rebase.yml', `# has \`\`\` fences\n${template('rebase.yml')}`) }),
			'ljharb/missing': repo({ workflows: null }),
			'ljharb/secret': repo({ workflows: null }),
			'ljharb/archived': repo({ workflows: null, archived: true }),
			'ljharb/optout': repo({ workflows: null, config: '{ "workflows": false }' }),
			// `ljharb/gone` is not found by GraphQL
			'ljharb/unreadable': repo({ workflows: [...standardWorkflows(), { name: 'node.yml', text: null }] }),
			'ljharb/unexpected': repo({
				packageJson: '{ "engines": { "node": "^20" } }',
				workflows: [...standardWorkflows(), { name: 'node.yml', text: nodeWorkflow() }, { name: 'node-tens.yml', text: nodeWorkflow() }],
			}),
			'ljharb/bigdiff': repo({ workflows: replacing('rebase.yml', bigText) }),
			'ljharb/pipes': repo({ config: '{ "workflows": "a | b" }' }),
		},
		issues: [],
		created: { number: 77, html_url: 'https://github.example/ljharb/actions/issues/77' }, // eslint-disable-line camelcase
	}, { GITHUB_SERVER_URL: 'https://github.example' }, { versions: true });

	t.equal(status, 0, 'exits successfully');
	t.equal(stderr, '', 'nothing on stderr');
	t.match(stdout, /^::warning::installation 2: account `stranger` is not in the allowed accounts; skipped$/m, 'warns about each failure');
	t.match(stdout, /^8 of 9 repositories have discrepancies; created https:\/\/github\.example\/ljharb\/actions\/issues\/77$/m, 'logs the outcome');

	const list = matching(requests, 'GET', /^\/repos\/ljharb\/actions\/issues\?/);
	t.equal(list.length, 1, 'lists the report repo’s issues');
	const query = new URLSearchParams(list[0].path.split('?')[1]);
	t.equal(query.get('creator'), 'github-actions[bot]', 'by the issue author');
	t.equal(query.get('state'), 'all', 'open or closed');
	t.equal(list[0].authorization, 'token ghp_issues', 'with the issues token');

	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['POST /repos/ljharb/actions/issues'], 'creates one issue, and nothing else');
	const { title, body } = writes[0].body;
	t.equal(title, 'Workflow drift: 8 of 9 repositories', 'the title counts discrepancies of checked repos (archived and opted-out ones are not checked)');
	t.ok(body.startsWith(`${marker}\n`), 'the body starts with the marker');
	t.ok(body.includes('[This run](https://github.example/ljharb/actions/actions/runs/42) checked the workflow files of 9 repositories'), 'links the run');
	t.ok(body.includes('checked the workflow files of 9 repositories the fleet App is installed on, against the templates'), 'without fork sources, the intro counts only installed repositories');
	t.notOk(body.includes('sources of forks'), 'and never mentions them');
	t.ok(body.includes('[`fleet/drift/templates`](https://github.example/ljharb/actions/tree/HEAD/fleet/drift/templates)'), 'links the templates');
	t.ok(body.includes('8 have discrepancies (1 of them private, so not listed).'), 'counts private repos');
	t.ok(body.includes('⚠️ Some repositories could not be checked, so this report is incomplete:\n- installation 2: ``account `stranger` is not in the allowed accounts; skipped``'), 'lists failures, inertly');
	t.notOk(body.includes('secret'), 'never names a private repository');
	t.notOk(body.includes('ljharb/clean'), 'a clean repo is not listed');
	t.notOk(body.includes('ljharb/archived') || body.includes('ljharb/optout'), 'skipped repos are not listed');

	t.ok(body.includes('| Repository | Missing | Unexpected | Drifted | Other |\n| --- | --- | --- | --- | --- |\n'), 'has the table header');
	t.ok(body.includes('| [`ljharb/missing`](https://github.example/ljharb/missing) | `node-pretest.yml`, `rebase.yml`, `require-allow-edits.yml` |  |  |  |'), 'a row for missing files');
	t.ok(body.includes('| [`ljharb/drifted`](https://github.example/ljharb/drifted) |  |  | `rebase.yml` |  |'), 'a row for drifted files');
	t.ok(body.includes('| [`ljharb/gone`](https://github.example/ljharb/gone) |  |  |  | `could not read the repository’s state` |'), 'a row for an unreadable repository');
	t.ok(body.includes('| [`ljharb/unreadable`](https://github.example/ljharb/unreadable) |  |  |  | unreadable: `node.yml` |'), 'a row for unreadable files');
	t.ok(body.includes('| [`ljharb/unexpected`](https://github.example/ljharb/unexpected) |  | `node-tens.yml` |  |  |'), 'a row for unexpected files');
	t.ok(body.includes('| [`ljharb/pipes`](https://github.example/ljharb/pipes) |  |  |  | `` `.github/ljharb-actions.json`: `workflows` must be a boolean, or an object mapping workflow file names (`*.yml` or `*.yaml`) to booleans `` |'), 'a row for a config error, fenced longer than its backticks');

	t.ok(body.includes('<details><summary><a href="https://github.example/ljharb/drifted/tree/HEAD/.github/workflows"><code>ljharb/drifted</code></a></summary>'), 'a details section per repo');
	t.ok(body.includes('- missing: `node-pretest.yml`, `rebase.yml`, `require-allow-edits.yml`'), 'section: missing');
	t.ok(body.includes('- unexpected, per `engines.node`: `node-tens.yml`'), 'section: unexpected');
	t.ok(body.includes('- unreadable: `node.yml`'), 'section: unreadable');
	t.ok(body.includes('- ⚠️ `could not read the repository’s state`'), 'section: error');
	t.match(body, /\n`rebase\.yml`:\n\n````diff\n--- rebase\.yml \(actual\)\n\+\+\+ rebase\.yml \(expected\)\n[^]*?-# has ``` fences\n[^]*?\n````\n/, 'a diff with backticks is fenced longer than they are');
	t.match(body, /\n```diff\n--- rebase\.yml \(actual\)\n[^`]*\n… \(truncated\)\n```\n/, 'a long diff is truncated');
	t.notOk(body.includes('x'.repeat(6001)), 'only the first 6000 characters of a diff are kept');
	t.notOk(body.includes('omitted'), 'nothing is omitted');

	t.equal(summary, body, 'the run summary has the same full report');

	t.end();
});

test('fleet/drift: applies an account’s defaults, and skips its `.github` repository unless it opts in', (t) => {
	const { status, stdout, requests } = run({
		installations: [
			{ id: 1, account: { login: 'ljharb' } },
			{ id: 2, account: { login: 'es-shims' } },
		],
		installationRepos: {
			1: [
				installedRepo('ljharb', '.github'),
				installedRepo('ljharb', 'no-rebase'),
				installedRepo('ljharb', 'wants-rebase'),
			],
			2: [installedRepo('es-shims', '.github'), installedRepo('es-shims', 'opted-out')],
		},
		accounts: {
			ljharb: { text: '{ "workflows": { "rebase.yml": false } }' },
			'es-shims': { text: '{ "workflows": false }' },
		},
		repos: {
			'ljharb/.github': repo({ workflows: null }),
			'ljharb/no-rebase': repo({ workflows: standardWorkflows().filter((f) => f.name !== 'rebase.yml') }),
			'ljharb/wants-rebase': repo({
				workflows: standardWorkflows().filter((f) => f.name !== 'rebase.yml'),
				config: '{ "workflows": { "rebase.yml": true } }',
			}),
			'es-shims/.github': repo({ workflows: null, config: '{ "workflows": true }' }),
			'es-shims/opted-out': repo({ workflows: null }),
		},
		issues: [],
	}, { INPUT_ACCOUNTS: 'ljharb es-shims' });

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^2 of 3 repositories have discrepancies; created /m, 'only the repositories that are checked are counted');
	const [create] = issueWrites(requests);
	const { body } = create.body;
	t.notOk(body.includes('ljharb/.github'), 'an account’s `.github` repository is skipped');
	t.notOk(body.includes('ljharb/no-rebase'), 'an account default ignoring a workflow applies');
	t.ok(body.includes('| [`ljharb/wants-rebase`](https://github.com/ljharb/wants-rebase) | `rebase.yml` |  |  |  |'), 'a repository’s own setting overrides the account’s default');
	t.ok(body.includes('| [`es-shims/.github`](https://github.com/es-shims/.github) | `node-pretest.yml`, `rebase.yml`, `require-allow-edits.yml` |  |  |  |'), 'a `.github` repository can opt in, despite its account opting out');
	t.notOk(body.includes('es-shims/opted-out'), 'an account default opting out applies');

	t.end();
});

test('fleet/drift: updates the latest report issue, reopening it', (t) => {
	const { status, stdout, requests } = run({
		installations: [{ id: 1, account: { login: 'LJHarb' } }],
		installationRepos: { 1: [installedRepo('LJHarb', 'drifted')] },
		repos: { 'LJHarb/drifted': repo({ workflows: replacing('rebase.yml', 'nope') }) },
		issues: [
			{ number: 1, state: 'open', body: marker, created_at: '2026-09-01T00:00:00Z', pull_request: {}, html_url: 'https://github.com/x/1' }, // eslint-disable-line camelcase
			{ number: 2, state: 'open', body: 'unrelated', created_at: '2026-09-02T00:00:00Z', html_url: 'https://github.com/x/2' }, // eslint-disable-line camelcase
			{ number: 3, state: 'open', body: null, created_at: '2026-09-03T00:00:00Z', html_url: 'https://github.com/x/3' }, // eslint-disable-line camelcase
			{ number: 4, state: 'closed', body: `${marker}\nold`, created_at: '2026-08-01T00:00:00Z', html_url: 'https://github.com/x/4' }, // eslint-disable-line camelcase
			{ number: 5, state: 'closed', body: `${marker}\nnewer`, created_at: '2026-08-15T00:00:00Z', html_url: 'https://github.com/x/5' }, // eslint-disable-line camelcase
			{ number: 6, state: 'closed', body: `${marker}\noldest`, created_at: '2026-07-01T00:00:00Z', html_url: 'https://github.com/x/6' }, // eslint-disable-line camelcase
		],
	}, {
		INPUT_ACCOUNTS: '',
		GITHUB_REPOSITORY_OWNER: 'ljharb',
		GITHUB_REPOSITORY: '',
		'INPUT_ISSUE-REPOSITORY': 'ljharb/reports',
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^1 of 1 repositories have discrepancies; updated https:\/\/github\.com\/x\/5$/m, 'logs the outcome');
	t.equal(matching(requests, 'GET', /^\/repos\/ljharb\/reports\/issues\?/).length, 1, 'lists issues in `issue-repository`');

	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['PATCH /repos/ljharb/reports/issues/5'], 'updates the newest marked issue, ignoring PRs and unmarked issues');
	t.equal(writes[0].body.state, 'open', 'reopening it');
	t.equal(writes[0].body.title, 'Workflow drift: 1 of 1 repositories', 'with the new title');
	t.ok(String(writes[0].body.body).includes('| [`LJHarb/drifted`](https://github.com/LJHarb/drifted) |'), 'and the new body, linking to github.com by default');
	t.ok(String(writes[0].body.body).includes('[This run](https://github.com//actions/runs/42)'), 'the run link uses the (empty) GITHUB_REPOSITORY');
	t.ok(String(writes[0].body.body).includes('1 have discrepancies. This issue'), 'no private count when there are none');
	t.notOk(String(writes[0].body.body).includes('could not be checked'), 'no failures section when there are none');

	t.end();
});

test('fleet/drift: closes an open report issue when there are no discrepancies', (t) => {
	const { status, stdout, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'clean')] },
		repos: { 'ljharb/clean': repo() },
		issues: [
			{ number: 8, state: 'open', body: `${marker}\nstuff`, created_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/8' }, // eslint-disable-line camelcase
		],
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^0 of 1 repositories have discrepancies; closed https:\/\/github\.com\/ljharb\/actions\/issues\/8$/m, 'logs the outcome');
	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), [
		'POST /repos/ljharb/actions/issues/8/comments',
		'PATCH /repos/ljharb/actions/issues/8',
	], 'comments, then closes');
	t.deepEqual(writes[0].body, { body: 'No discrepancies remain; closing.' }, 'the comment');
	t.deepEqual(writes[1].body, { state: 'closed' }, 'closes it');
	t.equal(summary, 'No discrepancies.', 'the run summary says so');

	t.end();
});

test('fleet/drift: nothing to do when there are no discrepancies and no open report', (t) => {
	const closed = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'clean'), installedRepo('ljharb', 'archived')] },
		repos: { 'ljharb/clean': repo(), 'ljharb/archived': repo({ workflows: null, archived: true }) },
		issues: [
			{ number: 8, state: 'closed', body: marker, created_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/8' }, // eslint-disable-line camelcase
		],
	});
	t.equal(closed.status, 0, 'exits successfully');
	t.match(closed.stdout, /^0 of 1 repositories have discrepancies; no discrepancies$/m, 'a closed report stays closed');
	t.deepEqual(issueWrites(closed.requests), [], 'no issue changes');
	t.equal(closed.summary, 'No discrepancies.', 'the run summary says so');

	const none = run({ installations: [], issues: [] });
	t.equal(none.status, 0, 'exits successfully');
	t.match(none.stdout, /^0 of 0 repositories have discrepancies; no discrepancies$/m, 'no report issue at all');
	t.deepEqual(issueWrites(none.requests), [], 'no issue changes');

	t.end();
});

test('fleet/drift: dry run, and an incomplete check is never “no discrepancies”', (t) => {
	const installations = Array.from({ length: 450 }, (_, i) => ({ id: 1000 + i, account: { login: `stranger-${i}` } }));
	const { status, stdout, requests, summary } = run({ installations }, { 'INPUT_DRY-RUN': 'true' });

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^0 of 0 repositories have discrepancies; dry run: no issue changes$/m, 'logs the outcome');
	t.deepEqual(requests.filter((r) => (/^\/repos\//).test(r.path)), [], 'no issue requests at all');
	t.equal((stdout.match(/^::warning::/gm) ?? []).length, 450, 'warns about each failure');
	t.ok(summary.startsWith(`${marker}\n`), 'the summary has a report, since the check is incomplete');
	t.ok(summary.includes('0 have discrepancies'), 'with no discrepancies');
	t.ok(summary.includes('- installation 1449: ``account `stranger-449` is not in the allowed accounts; skipped``'), 'listing every failure');
	t.ok(summary.includes('| Repository | Missing | Unexpected | Drifted | Other |'), 'and the (empty) table');

	t.end();
});

test('fleet/drift: keeps the issue body and run summary within GitHub’s limits', (t) => {
	const names = Array.from({ length: 300 }, (_, i) => `a-repository-with-a-rather-long-name-for-testing-${String(i).padStart(3, '0')}`);
	const { status, stdout, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: names.map((n) => installedRepo('ljharb', n)) },
		repos: Object.fromEntries(names.map((n) => [`ljharb/${n}`, repo({ workflows: replacing('rebase.yml', `${n}\n${'y'.repeat(7000)}\n`) })])),
		issues: [],
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^300 of 300 repositories have discrepancies; created /m, 'logs the outcome');

	const [create] = issueWrites(requests);
	const { body } = create.body;
	t.ok(body.length <= 60000, `the body (${body.length} characters) fits in an issue`);
	t.ok(body.length > 50000, 'and uses most of the space');
	const tableOmitted = body.match(/\n\| _…(?<n>\d+) more repositories omitted for length; see \[the run summary\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\)_ \| \| \| \| \|\n/);
	t.ok(tableOmitted, 'the table notes how many rows were omitted');
	const rows = (body.match(/^\| \[`ljharb\/a-repository-[\w-]+`\]/gm) ?? []).length;
	t.equal(rows + Number(tableOmitted?.groups?.n), 300, 'shown and omitted rows add up');
	t.ok(rows > 100, 'many rows are shown');
	const sectionsOmitted = body.match(/\n_…details for (?<n>\d+) more repositories omitted for length; see \[the run summary\]\([^)]+\)\._$/);
	t.ok(sectionsOmitted, 'the details note how many sections were omitted, at the end');
	const sections = (body.match(/^<details>/gm) ?? []).length;
	t.equal(sections + Number(sectionsOmitted?.groups?.n), 300, 'shown and omitted sections add up');

	t.ok(Buffer.byteLength(summary) <= 1000000, 'the summary fits in a step summary');
	t.ok(Buffer.byteLength(summary) > 900000, 'and uses most of the space');
	t.notOk(summary.includes('more repositories omitted: the run summary is full_ |'), 'the whole table fits in the summary');
	t.equal((summary.match(/^\| \[`ljharb\/a-repository-[\w-]+`\]/gm) ?? []).length, 300, 'every row is in the summary');
	const fullOmitted = summary.match(/\n_…details for (?<n>\d+) more repositories omitted: the run summary is full\._$/);
	t.ok(fullOmitted, 'the summary notes how many sections were omitted');
	t.equal((summary.match(/^<details>/gm) ?? []).length + Number(fullOmitted?.groups?.n), 300, 'shown and omitted summary sections add up');

	t.end();
});

test('fleet/drift: checks a fork’s source, per the `source-accounts` and `committer` inputs', (t) => {
	/** @type {Scenario} */
	const scenario = {
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: {
			1: [
				installedRepo('ljharb', 'clean'),
				installedRepo('ljharb', 'fork'),
				installedRepo('ljharb', 'other-fork'),
			],
		},
		repos: {
			'ljharb/clean': repo(),
			'ljharb/fork': { data: { isFork: true, parent: { nameWithOwner: 'Upstream/source' } } },
			'ljharb/other-fork': { data: { isFork: true, parent: { nameWithOwner: 'elsewhere/source' } } },
			'Upstream/source': repo({ workflows: null }),
			'elsewhere/source': repo({ workflows: null }),
		},
		commits: { 'Upstream/source': 1, 'elsewhere/source': 1 },
	};
	const { status, stdout, requests, summary } = run(scenario, {
		'INPUT_SOURCE-ACCOUNTS': 'someone, upstream',
		INPUT_COMMITTER: 'the-committer',
		'INPUT_DRY-RUN': 'true',
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^1 of 2 repositories have discrepancies; dry run: no issue changes$/m, 'the source is checked, and the forks are not');
	const commits = matching(requests, 'GET', /\/commits\?/);
	t.deepEqual(commits.map((r) => r.path.split('?')[0]), ['/repos/Upstream/source/commits'], 'only the source in an allowed account is checked for commits');
	t.equal(new URLSearchParams(commits[0].path.split('?')[1]).get('committer'), 'the-committer', 'by the `committer` input');
	t.ok(summary.includes('| [`Upstream/source`](https://github.com/Upstream/source) | `node-pretest.yml`, `rebase.yml`, `require-allow-edits.yml` |  |  |  |'), 'the source is in the report');
	t.notOk(summary.includes('elsewhere/source'), 'a source in another account is not');
	t.notOk(summary.includes('ljharb/fork') || summary.includes('ljharb/other-fork'), 'nor are the forks');
	t.ok(summary.includes('checked the workflow files of 1 repositories the fleet App is installed on, and 1 sources of forks it’s installed on, against the templates'), 'the intro counts installed repositories and fork sources separately');

	const created = run({ ...scenario, issues: [] }, {
		'INPUT_SOURCE-ACCOUNTS': 'upstream',
		INPUT_COMMITTER: 'the-committer',
	});
	t.equal(created.status, 0, 'exits successfully, when not a dry run');
	const writes = issueWrites(created.requests);
	t.equal(writes.length, 1, 'creates the issue');
	t.equal(writes[0].body.title, 'Workflow drift: 1 of 2 repositories', 'the title counts installed repositories and fork sources together');
	t.ok(writes[0].body.body.includes('checked the workflow files of 1 repositories the fleet App is installed on, and 1 sources of forks it’s installed on, against'), 'and so does the issue body');

	const none = run(scenario, { 'INPUT_SOURCE-ACCOUNTS': 'upstream', 'INPUT_DRY-RUN': 'true' });
	t.equal(none.status, 0, 'exits successfully without a committer');
	t.match(none.stdout, /^0 of 1 repositories have discrepancies; dry run: no issue changes$/m, 'without a committer, no source is checked');
	t.deepEqual(matching(none.requests, 'GET', /\/commits\?/), [], 'and no commits are listed');

	const unset = run(scenario, { INPUT_COMMITTER: 'the-committer', 'INPUT_DRY-RUN': 'true' });
	t.match(unset.stdout, /^0 of 1 repositories have discrepancies; dry run: no issue changes$/m, 'without source accounts, no source is checked');
	t.deepEqual(matching(unset.requests, 'GET', /\/commits\?/), [], 'and no commits are listed');

	t.end();
});

test('fleet/drift: failures', (t) => {
	const missing = run({}, { 'INPUT_APP-ID': '' });
	t.equal(missing.status, 1, 'a missing required input fails');
	t.match(missing.stdout, /^::error::Error: Input required and not supplied: app-id$/m, 'with the error');
	t.deepEqual(missing.requests, [], 'before any request');

	const thrown = run({}, { INPUT_ACCOUNTS: 'fleet-test-throw' }, { throwStringOnSplit: 'fleet-test-throw' });
	t.equal(thrown.status, 1, 'a thrown non-Error fails');
	t.match(thrown.stdout, /^::error::fleet-test-throw$/m, 'with the stringified value');

	const issues = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'missing')] },
		repos: { 'ljharb/missing': repo({ workflows: null }) },
	}, { 'INPUT_ISSUE-AUTHOR': '' });
	t.equal(issues.status, 1, 'a missing issue author fails, when not a dry run');
	t.match(issues.stdout, /^::error::Error: Input required and not supplied: issue-author$/m, 'with the error');
	t.equal(issues.summary, '', 'and writes no summary');

	t.end();
});
