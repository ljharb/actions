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

const header = '<tr><th>Repository</th><th>Missing</th><th>Unexpected</th><th>Drifted</th><th>Other</th></tr>';

/** @type {(server: string, repository: string, name: string) => string} */
function workflowLink(server, repository, name) {
	return `<a href="${server}/${repository}/blob/HEAD/.github/workflows/${name}"><code>${name}</code></a>`;
}

/** @type {(server: string, name: string, templateName?: string) => string} */
function templateLink(server, name, templateName = name) {
	return `<a href="${server}/ljharb/actions/blob/HEAD/fleet/drift/templates/${templateName}"><code>${name}</code></a>`;
}

/** @type {(items: string[]) => string} */
function ul(items) {
	return items.length > 0 ? `<ul>\n${items.map((item) => `<li>${item}</li>`).join('\n')}\n</ul>` : '';
}

/**
 * @type {(server: string, repository: string, cells?: {
 *   missing?: string[],
 *   unexpected?: string[],
 *   drifted?: string[],
 *   other?: string,
 * }) => string}
 */
function row(server, repository, {
	missing = [], unexpected = [], drifted = [], other = '',
} = {}) {
	return [
		`<tr><td><a href="${server}/${repository}/tree/HEAD/.github/workflows"><code>${repository}</code></a></td>`,
		`<td>\n${ul(missing)}\n</td>`,
		`<td>\n${ul(unexpected)}\n</td>`,
		`<td>\n${ul(drifted)}\n</td>`,
		`<td>\n${other}\n</td></tr>`,
	].join('');
}

/** @type {(server: string, repository: string, name: string, diff: string, ticks?: string) => string} */
function diffItem(server, repository, name, diff, ticks = '```') {
	return `<details><summary>${workflowLink(server, repository, name)}</summary>\n\n${ticks}diff\n${diff}\n${ticks}\n\n</details>`;
}

/** @type {(owner: string, summary: string, rows: string[]) => string} */
function accountTable(owner, summary, rows) {
	return [
		`<details><summary><b>${owner}</b>: ${summary}</summary>`,
		'',
		'<table>',
		header,
		...rows,
		'</table>',
		'',
		'</details>',
	].join('\n');
}

// how much longer `text` would be if one more drifted file, now a plain link, got its diff (all such items here are the same size)
/** @type {(text: string) => number} */
function diffCost(text) {
	const withDiff = text.match(/<li><details><summary>[^]*?<\/details><\/li>/)?.[0] ?? '';
	const plain = text.match(/<li><a href="[^"]*"><code>rebase\.yml<\/code><\/a><\/li>/)?.[0] ?? '';
	return withDiff.length - plain.length;
}

// how much longer `text` would be with one more row like its first (all such rows here are the same size), given the counts it shows
/** @type {(text: string, counts: { shown: number, omitted: number, diffsNoted?: number }) => number} */
function rowCost(text, { shown, omitted, diffsNoted }) {
	/** @type {(n: number) => number} */
	const digits = (n) => String(n).length;
	const first = text.match(/<tr><td>[^]*?<\/td><\/tr>/)?.[0] ?? '';
	const newline = 1; // joining it to the previous row
	const accountCount = digits(shown + 1) - digits(shown);
	const diffsNote = typeof diffsNoted === 'number' ? digits(diffsNoted + 1) - digits(diffsNoted) : 0;
	const omittedNote = digits(omitted - 1) - digits(omitted);
	return first.length + newline + accountCount + diffsNote + omittedNote;
}

/** @type {(text: string, pattern: RegExp) => number} */
function count(text, pattern) {
	return (text.match(pattern) ?? []).length;
}

test('fleet/drift: creates the report issue', (t) => {
	const server = 'https://github.example';
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
				installedRepo('ljharb', 'escaped'),
			],
		},
		repos: {
			'ljharb/clean': repo(),
			'ljharb/drifted': repo({ workflows: replacing('rebase.yml', `# has \`\`\` fences\n${template('rebase.yml')}`) }),
			'ljharb/missing': repo({ workflows: null, config: '{ "workflows": { "custom.yml": true, "node-twenties.yml": true } }' }),
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
			'ljharb/escaped': repo({
				packageJson: '{ "engines": { "node": "<b>&\\"\'" } }',
				workflows: [...standardWorkflows(), { name: 'node.yml', text: null }],
			}),
		},
		issues: [],
		created: { number: 77, html_url: 'https://github.example/ljharb/actions/issues/77' }, // eslint-disable-line camelcase
	}, { GITHUB_SERVER_URL: 'https://github.example' }, { versions: true });

	t.equal(status, 0, 'exits successfully');
	t.equal(stderr, '', 'nothing on stderr');
	t.match(stdout, /^::warning::installation 2: its account is not in the allowed accounts; skipped$/m, 'warns about each failure');
	t.match(stdout, /^9 of 10 repositories have discrepancies; created https:\/\/github\.example\/ljharb\/actions\/issues\/77$/m, 'logs the outcome');

	const list = matching(requests, 'GET', /^\/repos\/ljharb\/actions\/issues\?/);
	t.equal(list.length, 1, 'lists the report repo’s issues');
	const query = new URLSearchParams(list[0].path.split('?')[1]);
	t.equal(query.get('creator'), 'github-actions[bot]', 'by the issue author');
	t.equal(query.get('state'), 'all', 'open or closed');
	t.equal(list[0].authorization, 'token ghp_issues', 'with the issues token');

	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['POST /repos/ljharb/actions/issues'], 'creates one issue, and nothing else');
	const { title, body } = writes[0].body;
	t.equal(title, 'Workflow drift: 9 of 10 repositories', 'the title counts discrepancies of checked repos (archived and opted-out ones are not checked)');
	t.ok(body.startsWith(`${marker}\n`), 'the body starts with the marker');
	t.ok(body.includes('[This run](https://github.example/ljharb/actions/actions/runs/42) checked the workflow files of 10 repositories'), 'links the run');
	t.ok(body.includes('checked the workflow files of 10 repositories the fleet App is installed on, against the templates'), 'without fork sources, the intro counts only installed repositories');
	t.notOk(body.includes('sources of forks'), 'and never mentions them');
	t.ok(body.includes('[`fleet/drift/templates`](https://github.example/ljharb/actions/tree/HEAD/fleet/drift/templates)'), 'links the templates');
	t.ok(body.includes('9 have discrepancies (1 of them private, so not listed).'), 'counts private repos');
	t.ok(body.includes('⚠️ Some repositories could not be checked, so this report is incomplete:\n- installation 2: `its account is not in the allowed accounts; skipped`'), 'lists failures, inertly');
	t.notOk(body.includes('stranger') || stdout.includes('stranger'), 'never naming an account that isn’t allowed: it may have installed the App only on private repositories');
	t.notOk(body.includes('ljharb/secret'), 'never names a private repository');
	t.notOk(body.includes('ljharb/clean'), 'a clean repo is not listed');
	t.notOk(body.includes('ljharb/archived') || body.includes('ljharb/optout'), 'skipped repos are not listed');

	const rebase = template('rebase.yml').split('\n');
	const fencedDiff = [
		'--- rebase.yml (actual)',
		'+++ rebase.yml (expected)',
		'@@ -1,4 +1,3 @@',
		'-# has ``` fences',
		...rebase.slice(0, 3).map((line) => ` ${line}`),
	].join('\n');
	const bigDiff = [
		'--- rebase.yml (actual)',
		'+++ rebase.yml (expected)',
		`@@ -1 +1,${rebase.length - 1} @@`,
		`-${'x'.repeat(7000)}`,
		...rebase.slice(0, -1).map((line) => `+${line}`),
	].join('\n');
	// in the order of the results, which is by repository name
	const rows = [
		row(server, 'ljharb/bigdiff', { drifted: [diffItem(server, 'ljharb/bigdiff', 'rebase.yml', bigDiff)] }),
		row(server, 'ljharb/drifted', { drifted: [diffItem(server, 'ljharb/drifted', 'rebase.yml', fencedDiff, '````')] }),
		row(server, 'ljharb/escaped', {
			other: `<code>\`engines.node\` in \`package.json\` is not a valid semver range: &#60;b&#62;&#38;&#34;&#39;</code>\nunreadable: ${ul([workflowLink(server, 'ljharb/escaped', 'node.yml')])}`,
		}),
		row(server, 'ljharb/gone', { other: '<code>could not read the repository’s state</code>' }),
		row(server, 'ljharb/missing', {
			missing: [
				'<code>custom.yml</code>',
				templateLink(server, 'node-pretest.yml'),
				templateLink(server, 'node-twenties.yml', 'node.yml'),
				templateLink(server, 'rebase.yml'),
				templateLink(server, 'require-allow-edits.yml'),
			],
		}),
		row(server, 'ljharb/pipes', { other: '<code>`.github/ljharb-actions.json`: `workflows` must be a boolean, or an object mapping workflow file names (`*.yml` or `*.yaml`) to booleans</code>' }),
		row(server, 'ljharb/unexpected', { unexpected: [workflowLink(server, 'ljharb/unexpected', 'node-tens.yml')] }),
		row(server, 'ljharb/unreadable', { other: `unreadable: ${ul([workflowLink(server, 'ljharb/unreadable', 'node.yml')])}` }),
	];
	t.ok(body.includes(`\n\n${accountTable('ljharb', '8 repositories', rows)}`), 'one collapsed table for the account, with a row per listed repository, in order, and every cell exactly as expected');
	t.equal(count(body, /<table>/g), 1, 'and no other table');
	t.ok(body.endsWith(`\n${accountTable('ljharb', '8 repositories', rows)}`), 'nothing follows the table, since nothing is omitted');
	t.ok(body.includes('x'.repeat(7000)), 'a diff over 6000 characters is kept whole');
	t.notOk(body.includes('truncated'), 'and never truncated');
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
	const server = 'https://github.com';
	t.ok(body.includes(row(server, 'ljharb/wants-rebase', { missing: [templateLink(server, 'rebase.yml')] })), 'a repository’s own setting overrides the account’s default');
	t.ok(body.includes(row(server, 'es-shims/.github', {
		missing: ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink(server, name)),
	})), 'a `.github` repository can opt in, despite its account opting out');
	t.deepEqual(
		body.match(/^<details><summary><b>[^<]*<\/b>: [^<]*<\/summary>$/gm),
		['<details><summary><b>es-shims</b>: 1 repository</summary>', '<details><summary><b>ljharb</b>: 1 repository</summary>'],
		'one table per account, in result order (by repository name), each counting its one repository',
	);
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
	t.ok(String(writes[0].body.body).includes('<tr><td><a href="https://github.com/LJHarb/drifted/tree/HEAD/.github/workflows"><code>LJHarb/drifted</code></a></td>'), 'and the new body, linking to github.com by default');
	t.ok(String(writes[0].body.body).includes('<li><details><summary><a href="https://github.com/LJHarb/drifted/blob/HEAD/.github/workflows/rebase.yml"><code>rebase.yml</code></a></summary>'), 'linking the drifted file on github.com too');
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
	t.ok(summary.includes('- installation 1449: `its account is not in the allowed accounts; skipped`'), 'listing every failure');
	t.notOk(summary.includes('<table>') || summary.includes('<details>'), 'and no tables, since no repository is listed');
	t.notOk(summary.includes('more repositories'), 'nor any note of omitted ones');

	t.end();
});

test('fleet/drift: groups repositories by account, case-insensitively, in result order', (t) => {
	const server = 'https://github.com';
	const { status, stdout, summary } = run({
		installations: [
			{ id: 1, account: { login: 'ljharb' } },
			{ id: 2, account: { login: 'es-shims' } },
		],
		installationRepos: {
			1: [
				installedRepo('ljharb', 'beta'),
				installedRepo('LJHarb', 'alpha'),
				installedRepo('ljharb', 'clean'),
			],
			2: [installedRepo('es-shims', 'three')],
		},
		repos: {
			'ljharb/beta': repo({ workflows: null }),
			'LJHarb/alpha': repo({ workflows: replacing('rebase.yml', 'nope') }),
			'ljharb/clean': repo(),
			'es-shims/three': repo({ workflows: null }),
		},
	}, { INPUT_ACCOUNTS: 'ljharb es-shims', 'INPUT_DRY-RUN': 'true' });

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^3 of 4 repositories have discrepancies; dry run: no issue changes$/m, 'logs the outcome');
	const missing = ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink(server, name));
	const alphaDiff = summary.match(/<li><details><summary><a href="https:\/\/github\.com\/LJHarb\/alpha\/blob\/HEAD\/\.github\/workflows\/rebase\.yml"><code>rebase\.yml<\/code><\/a><\/summary>\n\n```diff\n(?<diff>[^`]+)\n```\n\n<\/details><\/li>/)?.groups?.diff ?? '';
	t.ok(alphaDiff.startsWith('--- rebase.yml (actual)\n+++ rebase.yml (expected)\n'), 'the drifted file has its diff');
	t.ok(summary.endsWith([
		'',
		accountTable('es-shims', '1 repository', [row(server, 'es-shims/three', { missing })]),
		accountTable('LJHarb', '2 repositories', [
			row(server, 'LJHarb/alpha', { drifted: [diffItem(server, 'LJHarb/alpha', 'rebase.yml', alphaDiff)] }),
			row(server, 'ljharb/beta', { missing }),
		]),
	].join('\n')), 'one table per account, in result order (by repository name): one counted in the singular, and one whose repositories share it whatever the case of the owner, named as it first appears, counted in the plural');
	t.equal(count(summary, /<table>/g), 2, 'one table per account');

	t.end();
});

test('fleet/drift: leaves out whole diffs that don’t fit, keeping every row', (t) => {
	const server = 'https://github.com';
	const names = Array.from({ length: 20 }, (_, i) => `drifted-${String(i).padStart(2, '0')}`);
	const { status, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: names.map((n) => installedRepo('ljharb', n)) },
		repos: Object.fromEntries(names.map((n) => [`ljharb/${n}`, repo({ workflows: replacing('rebase.yml', `${n}\n${'y'.repeat(7000)}\n`) })])),
		issues: [],
	});

	t.equal(status, 0, 'exits successfully');
	const [create] = issueWrites(requests);
	const { body } = create.body;
	t.ok(body.length <= 60000, `the body (${body.length} characters) fits in an issue`);
	t.ok(body.length + diffCost(body) - 1 > 60000, 'with no room for another diff (the note’s count could lose a digit)');
	t.equal(count(body, /<tr><td>/g), 20, 'every row is shown');
	t.notOk(body.includes('_…'), 'so no rows are noted as omitted');
	const omitted = body.match(/\n\n_Diffs for (?<n>\d+) more repositories are omitted for length; see \[the run summary\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\)\._$/);
	t.ok(omitted, 'the body ends noting how many repositories’ diffs were omitted');
	const shown = count(body, /<li><details><summary>/g);
	t.ok(shown > 0, 'some diffs are shown');
	t.equal(shown + Number(omitted?.groups?.n), 20, 'shown and omitted diffs add up');
	t.equal(count(body, /y{7000}/g), shown, 'every diff shown is whole');
	names.forEach((n, i) => {
		const link = workflowLink(server, `ljharb/${n}`, 'rebase.yml');
		if (i < shown) {
			t.ok(body.includes(`<li><details><summary>${link}</summary>\n\n\`\`\`diff\n--- rebase.yml (actual)\n`), `${n}: a leading row has its diff`);
		} else {
			t.ok(body.includes(`<td>\n<ul>\n<li>${link}</li>\n</ul>\n</td>`), `${n}: a later row just links the drifted file`);
		}
	});

	t.equal(count(summary, /<tr><td>/g), 20, 'the run summary has every row');
	t.equal(count(summary, /<li><details><summary>/g), 20, 'and every diff');
	t.equal(count(summary, /y{7000}/g), 20, 'each whole');
	t.notOk(summary.includes('omitted'), 'with nothing omitted');

	t.end();
});

test('fleet/drift: leaves out whole rows that don’t fit, then diffs', (t) => {
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
	const rows = count(body, /<tr><td><a href="https:\/\/github\.com\/ljharb\/a-repository-/g);
	t.ok(rows > 50, 'many rows are shown');
	const notes = body.match(/\n\n_Diffs for (?<diffs>\d+) more repositories are omitted for length; see \[the run summary\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\)\._\n\n_…(?<rows>\d+) more repositories omitted for length; see \[the run summary\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\)\._$/);
	t.ok(notes, 'the body ends noting the omitted diffs, then the omitted rows');
	t.equal(rows + Number(notes?.groups?.rows), 300, 'shown and omitted rows add up');
	t.ok(body.length + rowCost(body, { shown: rows, omitted: 300 - rows, diffsNoted: rows }) > 60000, 'with no room for another row');
	t.equal(count(body, /<li><details><summary>/g), 0, 'no diff fits beside the rows');
	t.equal(Number(notes?.groups?.diffs), rows, 'so every shown row’s diff is noted as omitted');
	t.ok(body.includes(`<tr><td><a href="https://github.com/ljharb/${names[rows - 1]}/tree/HEAD/.github/workflows">`), 'the leading rows are shown');
	t.notOk(body.includes(names[rows]), 'and the rest are not');

	t.ok(Buffer.byteLength(summary) <= 1000000, 'the summary fits in a step summary');
	t.ok(Buffer.byteLength(summary) + diffCost(summary) - 1 > 1000000, 'with no room for another diff (the note’s count could lose a digit)');
	t.equal(count(summary, /<tr><td><a href="https:\/\/github\.com\/ljharb\/a-repository-/g), 300, 'every row is in the summary');
	t.notOk(summary.includes('_…'), 'so no rows are noted as omitted');
	const fullOmitted = summary.match(/\n\n_Diffs for (?<n>\d+) more repositories are omitted: the run summary is full\._$/);
	t.ok(fullOmitted, 'the summary ends noting how many repositories’ diffs were omitted');
	const shown = count(summary, /<li><details><summary>/g);
	t.ok(shown > 100, 'many diffs are in the summary');
	t.equal(shown + Number(fullOmitted?.groups?.n), 300, 'shown and omitted summary diffs add up');
	t.equal(count(summary, /y{7000}/g), shown, 'every diff shown is whole');

	t.end();
});

test('fleet/drift: leaves out rows that don’t fit, even when none do', (t) => {
	const names = Array.from({ length: 15 }, (_, i) => `long-error-${String(i).padStart(2, '0')}`);
	const range = 'q'.repeat(100000);
	const { status, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: names.map((n) => installedRepo('ljharb', n)) },
		repos: Object.fromEntries(names.map((n) => [`ljharb/${n}`, repo({ packageJson: JSON.stringify({ engines: { node: range } }) })])),
		issues: [],
	});

	t.equal(status, 0, 'exits successfully');
	const [create] = issueWrites(requests);
	const { body } = create.body;
	t.match(body, /15 have discrepancies\. This issue is updated in place on every run, and closed when there are none\.\n+_…15 more repositories omitted for length; see \[the run summary\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\)\._$/, 'when not even one row fits, the body has no rows, and notes them all as omitted');
	t.notOk(body.includes('<table>') || body.includes('long-error-'), 'with no table, and no repository named');
	t.notOk(body.includes('Diffs for'), 'and no diffs to note, since none drifted');

	t.ok(Buffer.byteLength(summary) <= 1000000, 'the summary fits in a step summary');
	const rows = count(summary, /<tr><td>/g);
	t.ok(rows > 0 && rows < 14, `some rows (${rows}) are in the summary`);
	t.ok(Buffer.byteLength(summary) + rowCost(summary, { shown: rows, omitted: 15 - rows }) > 1000000, 'with no room for another row');
	t.ok(summary.includes(`<code>\`engines.node\` in \`package.json\` is not a valid semver range: ${range}</code>`), 'each with its whole error');
	t.ok(summary.endsWith(`\n\n_…${15 - rows} more repositories omitted: the run summary is full._`), 'and the summary ends noting the rest as omitted');
	t.ok(summary.includes(`<code>ljharb/${names[rows - 1]}</code>`), 'the leading rows are shown');
	t.notOk(summary.includes(names[rows]), 'and the rest are not');
	t.ok(summary.includes(`<b>ljharb</b>: ${rows} of 15 repositories</summary>`), 'the account counts the rows shown, of all of its rows');
	t.notOk(summary.includes('Diffs for'), 'and there are no diffs to note');

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
	t.ok(summary.includes(accountTable('Upstream', '1 repository', [
		row('https://github.com', 'Upstream/source', {
			missing: ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink('https://github.com', name)),
		}),
	])), 'the source is in the report, under its own account');
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
	t.ok(issues.summary.startsWith(`${marker}\n`), 'but still writes the summary first');
	t.ok(issues.summary.includes('<code>ljharb/missing</code>'), 'with the report');

	t.end();
});

test('fleet/drift: nothing about a private repository reaches the log, the summary, or the issue', (t) => {
	const { status, stdout, stderr, requests, summary } = run({
		installations: [
			{ id: 1, account: { login: 'ljharb' } },
			{ id: 2, account: { login: 'es-shims' } },
		],
		installationRepos: {
			1: [
				installedRepo('ljharb', 'visible'),
				installedRepo('ljharb', 'hidden', { private: true }),
				installedRepo('ljharb', 'zero', { private: true }),
			],
			2: [installedRepo('es-shims', 'shown')],
		},
		accounts: {
			ljharb: { private: true, text: JSON.stringify({ workflows: { 'secret-deploy.yml': true, 'internal-ci.yml': false } }) },
			'es-shims': { private: true, text: JSON.stringify({ workflows: { 'secret-deploy.yml': 'yes' } }) },
		},
		repos: {
			// a file the private defaults forbid would be unexpected, were they applied
			'ljharb/visible': repo({ workflows: [...standardWorkflows(), { name: 'internal-ci.yml', text: 'name: ci\n' }] }),
			'ljharb/hidden': repo({ isPrivate: true, workflows: null }),
			// `0.x` once made checking it throw, failing the run with an error that quoted it
			'ljharb/zero': repo({ isPrivate: true, packageJson: JSON.stringify({ engines: { node: '0.x' } }) }),
			'es-shims/shown': repo(),
		},
	}, { INPUT_ACCOUNTS: 'ljharb es-shims' }, { versions: true });

	t.equal(status, 0, 'exits successfully: no private repository’s error fails the run');
	const [created] = matching(requests, 'POST', /^\/repos\/ljharb\/actions\/issues$/);
	t.ok(created, 'and the issue is still written');
	const body = String(created?.body.body);
	t.ok(body.includes('2 have discrepancies (2 of them private, so not listed)'), 'counting only the private repositories: a private `.github` repository’s defaults give no public repository a discrepancy');
	t.notOk(body.includes('ljharb/visible'), 'not one it requires, nor one it forbids');
	t.notOk(body.includes('es-shims/shown'), 'nor its being invalid');
	const secrets = ['secret', 'hidden', 'zero', '0.x', 'preset', 'defaults', 'internal-ci.yml'];
	for (const [where, text] of [['the log', stdout], ['stderr', stderr], ['the summary', summary], ['the issue', body], ['the title', String(created?.body.title)]]) {
		t.deepEqual(secrets.filter((secret) => text.includes(secret)), [], `${where} reveals nothing about a private repository`);
	}
	t.end();
});

test('fleet/drift: third-party text in HTML is kept to one inert line', (t) => {
	const server = 'https://github.com';
	const range = '>=1\n\n[x](https://evil.example)\r\n \r\n![i](https://evil.example/i.png)\n\n````\n\n<b>bold</b>\n';
	const { status, requests, summary } = run({
		installations: [
			{ id: 1, account: { login: 'ljharb' } },
			{ id: 2, account: { login: 'zzz' } },
		],
		installationRepos: {
			1: [installedRepo('ljharb', 'evil')],
			2: [installedRepo('zzz', 'after')],
		},
		repos: {
			'ljharb/evil': repo({ packageJson: JSON.stringify({ engines: { node: range } }) }),
			'zzz/after': repo({ workflows: null }),
		},
		issues: [],
	}, { INPUT_ACCOUNTS: 'ljharb zzz' });

	t.equal(status, 0, 'exits successfully');

	const [create] = issueWrites(requests);
	const { body } = create.body;
	const other = '<code>`engines.node` in `package.json` is not a valid semver range: &#62;=1 [x](https://evil.example) ![i](https://evil.example/i.png) ```` &#60;b&#62;bold&#60;/b&#62;</code>';
	t.ok(body.includes(row(server, 'ljharb/evil', { other })), 'the error is one line, HTML-escaped, inside its `<code>`');
	const cell = body.match(/<td>\n<code>`engines\.node`[^]*?<\/code>\n<\/td>/)?.[0] ?? '';
	t.notOk((/\n\s*\n/).test(cell), 'with no blank line to end the HTML block');
	t.notOk((/^\s*(?:\[x\]|!\[i\]|````|<b>)/m).test(body), 'so no link, image, fence, or markup starts a line of its own');
	const missing = ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink(server, name));
	t.ok(body.endsWith(`\n${accountTable('zzz', '1 repository', [row(server, 'zzz/after', { missing })])}`), 'and a later account’s table is intact');
	t.equal(summary, body, 'the summary is the same');

	t.end();
});

test('fleet/drift: repository and owner names are kept to one line', (t) => {
	const server = 'https://github.com';
	const { status, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'new\nline'), installedRepo('odd\r\n owner', 'x')] },
		repos: {
			'ljharb/new\nline': repo({ workflows: null }),
			'odd\r\n owner/x': repo({ workflows: null }),
		},
	}, { 'INPUT_DRY-RUN': 'true' });

	t.equal(status, 0, 'exits successfully');
	t.ok(summary.includes('"><code>ljharb/new line</code></a></td>'), 'a newline in a repository’s name is a space in its link text');
	t.notOk(summary.includes('<code>ljharb/new\nline</code>'), 'and not a newline');
	t.ok(summary.includes('<details><summary><b>odd owner</b>: 1 repository</summary>'), 'a run of whitespace with a newline in an owner’s name is one space');
	t.ok(summary.includes('"><code>odd owner/x</code></a></td>'), 'in its repositories’ names too');
	t.ok(summary.includes(templateLink(server, 'rebase.yml')), 'each with its missing files');

	t.end();
});

test('fleet/drift: a repository’s link escapes HTML in its href', (t) => {
	const { status, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'a"b&c')] },
		repos: { 'ljharb/a"b&c': repo({ workflows: null }) },
	}, { 'INPUT_DRY-RUN': 'true' });

	t.equal(status, 0, 'exits successfully');
	t.ok(
		summary.includes('<a href="https://github.com/ljharb/a&#34;b&#38;c/tree/HEAD/.github/workflows"><code>ljharb/a&#34;b&#38;c</code></a>'),
		'the href and the link text are both escaped',
	);
	t.notOk(summary.includes('href="https://github.com/ljharb/a"b'), 'no raw quote ends the href early');

	t.end();
});

test('fleet/drift: an account whose rows don’t all fit counts the rows shown, of all of its rows', (t) => {
	const range = 'q'.repeat(70000);
	const { status, requests } = run({
		installations: [
			{ id: 1, account: { login: 'aaa' } },
			{ id: 2, account: { login: 'bbb' } },
			{ id: 3, account: { login: 'ccc' } },
		],
		installationRepos: {
			1: [installedRepo('aaa', 'one')],
			2: [installedRepo('bbb', 'one'), installedRepo('bbb', 'two')],
			3: [installedRepo('ccc', 'one'), installedRepo('ccc', 'two'), installedRepo('ccc', 'three')],
		},
		repos: {
			'aaa/one': repo({ workflows: null }),
			'bbb/one': repo({ workflows: null }),
			'bbb/two': repo({ packageJson: JSON.stringify({ engines: { node: range } }) }),
			'ccc/one': repo({ workflows: null }),
			'ccc/two': repo({ workflows: null }),
			'ccc/three': repo({ workflows: null }),
		},
		issues: [],
	}, { INPUT_ACCOUNTS: 'aaa bbb ccc' });

	t.equal(status, 0, 'exits successfully');
	const [create] = issueWrites(requests);
	const { body } = create.body;
	t.ok(body.length <= 60000, 'the body fits in an issue');
	t.deepEqual(
		body.match(/^<details><summary><b>[^<]*<\/b>: [^<]*<\/summary>$/gm),
		['<details><summary><b>aaa</b>: 1 repository</summary>', '<details><summary><b>bbb</b>: 1 of 2 repositories</summary>'],
		'an account with every row shown counts them plainly, in the singular; one with only some shown counts “N of M”, in the plural, by M',
	);
	t.ok(body.endsWith('\n\n_…4 more repositories omitted for length; see [the run summary](https://github.com/ljharb/actions/actions/runs/42)._'), 'and the rest are noted as omitted');

	t.end();
});

test('fleet/drift: fits a huge failures list, noting how many more there are', (t) => {
	const installations = [
		{ id: 1, account: { login: 'ljharb' } },
		...Array.from({ length: 1500 }, (_, i) => ({ id: 1000 + i, account: { login: `stranger-${i}` } })),
	];
	const { status, requests, summary } = run({
		installations,
		installationRepos: { 1: [installedRepo('ljharb', 'missing')] },
		repos: { 'ljharb/missing': repo({ workflows: null }) },
		issues: [],
	});

	t.equal(status, 0, 'exits successfully');
	const [create] = issueWrites(requests);
	const { body } = create.body;
	t.ok(body.length <= 60000, `the body (${body.length} characters) fits in an issue`);
	t.ok(body.length > 59800, 'using nearly all of it for failures');
	const shown = count(body, /^- installation \d+: `its account is not in the allowed accounts; skipped`$/gm);
	t.ok(shown > 0 && shown < 1500, `some failures (${shown}) are listed`);
	const more = body.match(/^- _…(?<n>\d+) more omitted for length; see \[the run summary\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\)\._$/m);
	t.ok(more, 'then a line noting the rest');
	t.equal(shown + Number(more?.groups?.n), 1500, 'shown and omitted failures add up');
	t.ok(body.includes(`- installation ${1000 + shown - 1}: `) && !body.includes(`- installation ${1000 + shown}: `), 'the leading failures are listed, and the rest are not');
	const tail = body.slice(body.indexOf(more?.[0] ?? '\0'));
	t.match(tail, /^- _…\d+ more omitted for length; [^\n]*\n\n+_…1 more repositories omitted for length; see \[the run summary\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\)\._$/, 'and no row fits after them, so it is noted as omitted');

	t.equal(count(summary, /^- installation \d+: /gm), 1500, 'the summary lists every failure');
	t.notOk(summary.includes('more omitted'), 'with none omitted');
	t.ok(summary.includes('<code>ljharb/missing</code>'), 'and the row');

	t.end();
});

test('fleet/drift: writes the summary even when the issue write fails', (t) => {
	const { status, stdout, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'missing')] },
		repos: { 'ljharb/missing': repo({ workflows: null }) },
		issues: [],
		createError: { status: 422, body: { message: 'Validation Failed' } },
	});

	t.equal(status, 1, 'fails');
	t.match(stdout, /^::error::.*Validation Failed/m, 'with the error');
	t.deepEqual(issueWrites(requests).map((r) => `${r.method} ${r.path}`), ['POST /repos/ljharb/actions/issues'], 'having tried to create the issue');
	t.ok(summary.startsWith(`${marker}\n`), 'the summary was still written');
	t.ok(summary.includes('<code>ljharb/missing</code>'), 'with the report');

	t.end();
});
