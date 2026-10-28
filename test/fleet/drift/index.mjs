import path from 'path';

import test from 'tape';

import { legend } from '../../../fleet/commands/syntax.mjs';
import { installedRepo, privateKey } from '../lib/helpers/github.mjs';
import { runChild } from './helpers/child.mjs';
import { nodeWorkflow, standardWorkflows, template } from './helpers/states.mjs';
import { versionFixture } from './helpers/versions.mjs';

/** @typedef {import('../lib/helpers/github.mjs').Scenario} Scenario */
/** @typedef {import('../lib/helpers/github.mjs').RepoSpec} RepoSpec */
/** @typedef {import('../lib/helpers/github.mjs').Recorded} Recorded */
/** @typedef {import('./helpers/child.mjs').ChildResult} ChildResult */

const marker = '<!-- ljharb/actions: fleet workflow drift -->';
// the report issue's authors: the App's bot, and GitHub Actions' bot, which opened the report before the App wrote it
const bot = { login: 'fleet-bot[bot]' };
const legacy = { login: 'github-actions[bot]' };
// the token for the report issue's repository, from its installation
const issueToken = 'token ghs_installation_99';
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
			'INPUT_DRY-RUN': 'false',
			'INPUT_GIST-TOKEN': 'ghp_gist',
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
function gistWrites(requests) {
	return requests.filter((r) => r.method !== 'GET' && (/^\/gists/).test(r.path));
}

// the full report, as written to its gist: in one file, unless it's too big for one
/** @type {(t: import('tape').Test, requests: Recorded[]) => string} */
function gistContent(t, requests) {
	const writes = gistWrites(requests);
	t.equal(writes.length, 1, 'writes the gist once');
	t.deepEqual(Object.keys(writes[0]?.body.files ?? {}), ['workflow-drift.md'], 'with its one file');
	return String(writes[0]?.body.files['workflow-drift.md'].content);
}

// the full report's files, as written to its gist, in order, one in each request
/** @type {(requests: Recorded[]) => [string, string][]} */
function gistFiles(requests) {
	return gistWrites(requests).flatMap((r) => Object.entries(r.body.files).filter(([, file]) => file !== null).map(([name, file]) => /** @type {[string, string]} */ ([name, String(file.content)]))); // eslint-disable-line no-extra-parens
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

// every report ends with the commands' legend; this is the rest of it
/** @type {(t: import('tape').Test, text: string) => string} */
function withoutLegend(t, text) {
	const tail = `\n\n${legend()}`;
	t.ok(text.endsWith(tail), 'ends with the commands’ legend');
	return text.slice(0, -tail.length);
}

/** @type {(text: string, pattern: RegExp) => number} */
function count(text, pattern) {
	return (text.match(pattern) ?? []).length;
}

const gistMarker = 'ljharb/actions fleet workflow drift report';
const reportFiles = { 'workflow-drift.md': {} };
const accountsHeader = [
	'| Account | Repositories with discrepancies | Missing files | Unexpected files | Drifted files | Repositories with other problems |',
	'| --- | --: | --: | --: | --: | --: |',
].join('\n');

/** @type {(server: string, counts: { installed: number, total: number, privateCount?: number, sources?: number }) => string} */
function intro(server, {
	installed, total, privateCount = 0, sources = 0,
}) {
	return `[This run](${server}/ljharb/actions/actions/runs/42) checked the workflow files of ${installed} repositories the fleet App is installed on${sources > 0 ? `, and ${sources} sources of forks it’s installed on` : ''}, against the templates in [\`fleet/drift/templates\`](${server}/ljharb/actions/tree/HEAD/fleet/drift/templates). ${total} have discrepancies${privateCount > 0 ? ` (${privateCount} of them private, so not listed)` : ''}.`;
}

/** @type {(id: string) => string} */
function gistLink(id) {
	return `**[The full report](https://gist.github.com/${id})** has every repository, every discrepancy, and every diff; it’s a secret gist, updated in place on every run.`;
}

/** @type {(text: string) => void} */
function neverOmits(text) {
	for (const word of ['omitted', 'more repositories', 'truncated', '…', 'more entries', 'cut short']) {
		if (text.includes(word)) {
			throw new Error(`“${word}” in: ${text.slice(Math.max(0, text.indexOf(word) - 200), text.indexOf(word) + 200)}`);
		}
	}
}

test('fleet/drift: keeps the full report in a new secret gist, and summarizes it in a new issue and the run summary', (t) => {
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
		gists: [],
		created: { number: 77, html_url: 'https://github.example/ljharb/actions/issues/77' }, // eslint-disable-line camelcase
	}, { GITHUB_SERVER_URL: 'https://github.example' }, { versions: true });

	t.equal(status, 0, 'exits successfully');
	t.equal(stderr, '', 'nothing on stderr');
	t.match(stdout, /^::add-mask::ghp_gist$/m, 'masks the gist token');
	t.match(stdout, /^::warning::installation 2: its account is not in the allowed accounts; skipped$/m, 'warns about each failure');
	t.match(stdout, /^9 of 10 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; created https:\/\/github\.example\/ljharb\/actions\/issues\/77$/m, 'logs the outcome');

	const listed = matching(requests, 'GET', /^\/gists\?/);
	t.deepEqual(listed.map((r) => r.path), ['/gists?per_page=100'], 'looks for the gist among the token user’s gists');
	t.equal(listed[0].authorization, 'token ghp_gist', 'with the gist token');
	const [gistWrite] = gistWrites(requests);
	t.equal(`${gistWrite.method} ${gistWrite.path}`, 'POST /gists', 'creates the gist, since there is none');
	t.equal(gistWrite.authorization, 'token ghp_gist', 'with the gist token');
	t.equal(gistWrite.body.public, false, 'a secret one');
	t.equal(gistWrite.body.description, gistMarker, 'described so it’s found again next time');

	const list = matching(requests, 'GET', /^\/repos\/ljharb\/actions\/issues\?/);
	t.equal(list.length, 2, 'lists the report repo’s issues, twice');
	const queries = list.map((r) => new URLSearchParams(r.path.split('?')[1]));
	t.deepEqual(queries.map((q) => q.get('creator')), [bot.login, legacy.login], 'by the App’s bot, and by GitHub Actions’ bot, whose report the App adopts');
	t.deepEqual(queries.map((q) => q.get('state')), ['all', 'all'], 'open or closed');
	t.deepEqual(list.map((r) => r.authorization), [issueToken, issueToken], 'with the App’s token for the report repo');
	t.ok(requests.indexOf(gistWrite) < requests.indexOf(list[0]), 'the gist is written before the issue, which links to it');
	t.equal(issueWrites(requests)[0]?.authorization, issueToken, 'and the issue is created by the App’s bot, with the same token');
	t.match(stdout, /^::add-mask::ghs_installation_99$/m, 'which is masked');

	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['POST /repos/ljharb/actions/issues'], 'creates one issue, and nothing else');
	const { title, body } = writes[0].body;
	t.equal(title, 'Workflow drift: 9 of 10 repositories', 'the title counts discrepancies of checked repos (archived and opted-out ones are not checked)');

	const counts = intro(server, { installed: 10, total: 9, privateCount: 1 });
	const failures = '⚠️ Some repositories could not be checked, so this report is incomplete:\n- installation 2: `its account is not in the allowed accounts; skipped`';
	const accounts = `${accountsHeader}\n| \`ljharb\` | 8 | 5 | 1 | 2 | 4 |`;
	t.equal(body, [
		marker,
		`${counts} This issue is updated in place on every run, and closed when there are none.`,
		'',
		gistLink('new-gist'),
		'',
		failures,
		'',
		accounts,
		'',
		['<details><summary><b>Commands</b></summary>', '', legend({ heading: false }), '', '</details>'].join('\n'),
	].join('\n'), 'the issue is a summary: the counts, the gist’s link, every failure, each account’s counts, and the commands, collapsed');
	t.equal(summary, [
		counts,
		'',
		gistLink('new-gist'),
		'',
		failures,
		'',
		accounts,
	].join('\n'), 'the run summary is the same, without the marker or the commands');
	t.notOk((/ljharb\/(?!actions\b)/).test(body) || (/ljharb\/(?!actions\b)/).test(summary), 'neither names a repository: that’s for the full report');
	t.notOk(body.includes('stranger') || stdout.includes('stranger'), 'never naming an account that isn’t allowed: it may have installed the App only on private repositories');

	const full = gistContent(t, requests);
	t.ok(full.startsWith(`# Workflow drift: 9 of 10 repositories\n\n${counts} This report is updated in place on every run.\n\n${failures}\n\n`), 'the full report starts with the title, the counts, and every failure');
	t.notOk(full.includes(marker), 'it isn’t marked as the issue');
	t.notOk(full.includes('ljharb/secret'), 'never names a private repository');
	t.notOk(full.includes('ljharb/clean'), 'a clean repo is not listed');
	t.notOk(full.includes('ljharb/archived') || full.includes('ljharb/optout'), 'skipped repos are not listed');

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
	t.equal(withoutLegend(t, full), `# Workflow drift: 9 of 10 repositories\n\n${counts} This report is updated in place on every run.\n\n${failures}\n\n${accountTable('ljharb', '8 repositories', rows)}`, 'then one collapsed table for the account, with a row per listed repository, in order, and every cell exactly as expected, and the commands');
	t.ok(full.includes('x'.repeat(7000)), 'a long diff is kept whole');
	neverOmits(full);
	neverOmits(body);
	neverOmits(summary);
	t.equal(full.split(legend()).length, 2, 'the legend appears once');

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
	t.match(stdout, /^2 of 3 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; created /m, 'only the repositories that are checked are counted');
	const full = gistContent(t, requests);
	t.notOk(full.includes('ljharb/.github'), 'an account’s `.github` repository is skipped');
	t.notOk(full.includes('ljharb/no-rebase'), 'an account default ignoring a workflow applies');
	const server = 'https://github.com';
	t.ok(full.includes(row(server, 'ljharb/wants-rebase', { missing: [templateLink(server, 'rebase.yml')] })), 'a repository’s own setting overrides the account’s default');
	t.ok(full.includes(row(server, 'es-shims/.github', {
		missing: ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink(server, name)),
	})), 'a `.github` repository can opt in, despite its account opting out');
	t.deepEqual(
		full.match(/^<details><summary><b>[^<]*<\/b>: [^<]*<\/summary>$/gm),
		['<details><summary><b>es-shims</b>: 1 repository</summary>', '<details><summary><b>ljharb</b>: 1 repository</summary>'],
		'one table per account, in result order (by repository name), each counting its one repository',
	);
	t.notOk(full.includes('es-shims/opted-out'), 'an account default opting out applies');
	const [create] = issueWrites(requests);
	t.ok(create.body.body.includes(`${accountsHeader}\n| \`es-shims\` | 1 | 3 | 0 | 0 | 0 |\n| \`ljharb\` | 1 | 1 | 0 | 0 | 0 |`), 'the issue counts each account’s discrepancies, in the same order');

	t.end();
});

test('fleet/drift: updates the gist found by its description, through every page, and the latest report issue, reopening it', (t) => {
	/** @type {import('../lib/helpers/github.mjs').Gist[]} */
	const gists = [
		...Array.from({ length: 120 }, (_, i) => ({ id: `other-${i}`, description: i % 2 ? `something else ${i}` : null, public: false })),
		{ id: 'public-one', description: gistMarker, public: true, files: reportFiles },
		...Array.from({ length: 10 }, (_, i) => ({ id: `more-${i}`, description: 'unrelated', public: true })),
		// only mentioning the marker isn't enough
		{ id: 'mentions-it', description: `notes about the ${gistMarker}`, public: false, files: reportFiles },
		// nor is a gist with other files
		{ id: 'other-files', description: gistMarker, public: false, files: { 'workflow-drift.md': {}, 'notes.txt': {} } },
		{ id: 'no-files', description: gistMarker, public: false, files: {} },
		{ id: 'files-unlisted', description: gistMarker, public: false },
		{ id: 'dry-runs', description: `${gistMarker} (dry runs)`, public: false, files: reportFiles },
		// a previous run's report, in two files
		{ id: 'the-gist', description: gistMarker, public: false, files: { 'workflow-drift-001.md': {}, 'workflow-drift-002.md': {} } },
	];
	const { status, stdout, requests } = run({
		installations: [{ id: 1, account: { login: 'LJHarb' } }],
		installationRepos: { 1: [installedRepo('LJHarb', 'drifted')] },
		repos: { 'LJHarb/drifted': repo({ workflows: replacing('rebase.yml', 'nope') }) },
		gists,
		issues: [
			{ number: 1, user: bot, state: 'open', body: marker, created_at: '2026-09-01T00:00:00Z', pull_request: {}, html_url: 'https://github.com/x/1' }, // eslint-disable-line camelcase
			{ number: 2, user: bot, state: 'open', body: 'unrelated', created_at: '2026-09-02T00:00:00Z', html_url: 'https://github.com/x/2' }, // eslint-disable-line camelcase
			{ number: 3, user: legacy, state: 'open', body: null, created_at: '2026-09-03T00:00:00Z', html_url: 'https://github.com/x/3' }, // eslint-disable-line camelcase
			{ number: 4, user: legacy, state: 'closed', body: `${marker}\nold`, created_at: '2026-08-01T00:00:00Z', html_url: 'https://github.com/x/4' }, // eslint-disable-line camelcase
			{ number: 5, user: bot, state: 'closed', body: `${marker}\nnewer`, created_at: '2026-08-15T00:00:00Z', html_url: 'https://github.com/x/5' }, // eslint-disable-line camelcase
			{ number: 6, user: legacy, state: 'closed', body: `${marker}\noldest`, created_at: '2026-07-01T00:00:00Z', html_url: 'https://github.com/x/6' }, // eslint-disable-line camelcase
		],
	}, {
		INPUT_ACCOUNTS: '',
		GITHUB_REPOSITORY_OWNER: 'ljharb',
		GITHUB_REPOSITORY: '',
		'INPUT_ISSUE-REPOSITORY': 'ljharb/reports',
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^1 of 1 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/the-gist; updated https:\/\/github\.com\/x\/5$/m, 'logs the outcome');
	t.deepEqual(matching(requests, 'GET', /^\/gists\?/).map((r) => r.path), ['/gists?per_page=100', '/gists?per_page=100&page=2'], 'lists every page of gists');
	const [gistWrite, cleanup] = gistWrites(requests);
	t.equal(`${gistWrite.method} ${gistWrite.path}`, 'PATCH /gists/the-gist', 'updates the secret gist whose description is exactly the marker, and that has only the report’s files, never a public one, a dry run’s, or one that only mentions the marker');
	t.equal(gistWrite.body.description, gistMarker, 'keeping its description');
	t.deepEqual(Object.keys(gistWrite.body.files), ['workflow-drift.md'], 'writing the report, which fits in one file now');
	t.deepEqual(cleanup && [`${cleanup.method} ${cleanup.path}`, cleanup.body], ['PATCH /gists/the-gist', { files: { 'workflow-drift-001.md': null, 'workflow-drift-002.md': null } }], 'then deleting the files it no longer needs');
	t.equal(gistWrites(requests).length, 2, 'and writing nothing else');
	t.ok(String(gistWrite.body.files['workflow-drift.md'].content).includes('<tr><td><a href="https://github.com/LJHarb/drifted/tree/HEAD/.github/workflows"><code>LJHarb/drifted</code></a></td>'), 'with the new full report, linking to github.com by default');
	t.equal(matching(requests, 'GET', /^\/repos\/ljharb\/reports\/issues\?/).length, 2, 'lists issues in `issue-repository`, by each of the report’s authors');
	t.deepEqual(matching(requests, 'GET', /\/installation$/).map((r) => r.path), ['/repos/ljharb/reports/installation'], 'with a token from the App’s installation on it');

	const writes = issueWrites(requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['PATCH /repos/ljharb/reports/issues/5'], 'updates the newest marked issue, whichever of the report’s authors opened it, ignoring PRs and unmarked issues');
	t.equal(writes[0].body.state, 'open', 'reopening it');
	t.equal(writes[0].body.title, 'Workflow drift: 1 of 1 repositories', 'with the new title');
	const body = String(writes[0].body.body);
	t.ok(body.includes(gistLink('the-gist')), 'and the new body, linking the gist');
	t.ok(body.includes('[This run](https://github.com//actions/runs/42)'), 'the run link uses the (empty) GITHUB_REPOSITORY');
	t.ok(body.includes('1 have discrepancies. This issue'), 'no private count when there are none');
	t.notOk(body.includes('could not be checked'), 'no failures section when there are none');
	t.ok(body.includes('| `LJHarb` | 1 | 0 | 0 | 1 | 0 |'), 'counting the drifted file');

	t.end();
});

test('fleet/drift: closes an open report issue when there are no discrepancies', (t) => {
	const { status, stdout, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'clean')] },
		repos: { 'ljharb/clean': repo() },
		gists: [{ id: 'the-gist', description: gistMarker, public: false, files: reportFiles }],
		issues: [
			{ number: 8, user: legacy, state: 'open', body: `${marker}\nstuff`, created_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/8' }, // eslint-disable-line camelcase
		],
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^0 of 1 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/the-gist; closed https:\/\/github\.com\/ljharb\/actions\/issues\/8$/m, 'logs the outcome');
	t.equal(gistContent(t, requests), 'No discrepancies.', 'the gist says so, so it’s never out of date');
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

test('fleet/drift: the App’s bot adopts a report opened by GitHub Actions’ bot, and ignores any other author’s', (t) => {
	const scenario = {
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'missing')] },
		repos: { 'ljharb/missing': repo({ workflows: null }) },
	};
	const mallory = { login: 'mallory' };
	const adopted = run({
		...scenario,
		issues: [
			// newer, and marked, but someone else's, so never written to
			{ number: 20, user: mallory, state: 'open', body: marker, created_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/20' }, // eslint-disable-line camelcase
			{ number: 9, user: legacy, state: 'open', body: `${marker}\nold`, created_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/9' }, // eslint-disable-line camelcase
		],
	});
	t.equal(adopted.status, 0, 'exits successfully');
	t.match(adopted.stdout, /; updated https:\/\/github\.com\/ljharb\/actions\/issues\/9$/m, 'updates the report GitHub Actions’ bot opened');
	const writes = issueWrites(adopted.requests);
	t.deepEqual(writes.map((r) => `${r.method} ${r.path}`), ['PATCH /repos/ljharb/actions/issues/9'], 'and nothing else');
	t.equal(writes[0].authorization, issueToken, 'as the App’s bot');

	const token = matching(adopted.requests, 'POST', /^\/app\/installations\/99\/access_tokens$/);
	t.deepEqual(token.map((r) => r.body), [{ repositories: ['actions'], permissions: { issues: 'write', metadata: 'read' } }], 'with a token for only the report repo, that can only write issues');
	t.deepEqual(matching(adopted.requests, 'GET', /^\/repos\/[^/]+\/[^/]+\/installation$/).map((r) => [r.path, (/^bearer /i).test(r.authorization)]), [['/repos/ljharb/actions/installation', true]], 'from the App’s installation on it, found as the App');
	t.deepEqual(matching(adopted.requests, 'GET', /^\/app$/).length, 1, 'and the App’s bot’s login is read once');

	const others = run({
		...scenario,
		appSlug: 'ljharb-fleet',
		issues: [
			{ number: 20, user: mallory, state: 'open', body: marker, created_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/20' }, // eslint-disable-line camelcase
			{ number: 21, user: legacy, state: 'open', body: 'unmarked', created_at: '2026-10-02T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/21' }, // eslint-disable-line camelcase
		],
		created: { number: 22, html_url: 'https://github.com/ljharb/actions/issues/22' }, // eslint-disable-line camelcase
	});
	t.equal(others.status, 0, 'exits successfully');
	t.match(others.stdout, /; created https:\/\/github\.com\/ljharb\/actions\/issues\/22$/m, 'creates a report when only someone else’s is marked');
	t.deepEqual(matching(others.requests, 'GET', /\/issues\?/).map((r) => new URLSearchParams(r.path.split('?')[1]).get('creator')), ['ljharb-fleet[bot]', 'github-actions[bot]'], 'looking for the App’s bot’s by its slug');
	const [created] = issueWrites(others.requests);
	t.equal(created && `${created.method} ${created.path} ${created.authorization}`, `POST /repos/ljharb/actions/issues ${issueToken}`, 'as the App’s bot');

	t.end();
});

test('fleet/drift: nothing to do when there are no discrepancies and no open report', (t) => {
	const closed = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'clean'), installedRepo('ljharb', 'archived')] },
		repos: { 'ljharb/clean': repo(), 'ljharb/archived': repo({ workflows: null, archived: true }) },
		issues: [
			{ number: 8, user: legacy, state: 'closed', body: marker, created_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/ljharb/actions/issues/8' }, // eslint-disable-line camelcase
		],
	});
	t.equal(closed.status, 0, 'exits successfully');
	t.match(closed.stdout, /^0 of 1 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; no discrepancies$/m, 'a closed report stays closed');
	t.deepEqual(issueWrites(closed.requests), [], 'no issue changes');
	t.equal(closed.summary, 'No discrepancies.', 'the run summary says so');

	const none = run({ installations: [], issues: [] });
	t.equal(none.status, 0, 'exits successfully');
	t.match(none.stdout, /^0 of 0 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; no discrepancies$/m, 'no report issue at all');
	t.deepEqual(issueWrites(none.requests), [], 'no issue changes');

	t.end();
});

test('fleet/drift: a dry run writes the gist, and an incomplete check is never “no discrepancies”', (t) => {
	const installations = Array.from({ length: 450 }, (_, i) => ({ id: 1000 + i, account: { login: `stranger-${i}` } }));
	const { status, stdout, requests, summary } = run({ installations }, { 'INPUT_DRY-RUN': 'true' });

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^0 of 0 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; dry run: no issue changes$/m, 'logs the outcome');
	t.deepEqual(requests.filter((r) => (/^\/repos\//).test(r.path)), [], 'no issue requests at all');
	t.equal((stdout.match(/^::warning::/gm) ?? []).length, 450, 'warns about each failure');
	const full = gistContent(t, requests);
	t.equal(gistWrites(requests)[0].body.description, `${gistMarker} (dry runs)`, 'in a gist of its own, so the issue’s link still shows what the issue says');
	t.ok(full.includes('0 have discrepancies'), 'the gist has a report, since the check is incomplete, with no discrepancies');
	t.equal(count(full, /^- installation \d+: `its account is not in the allowed accounts; skipped`$/gm), 450, 'listing every failure');
	t.notOk(full.includes('<table>') || full.includes('<details>'), 'and no tables, since no repository is listed');
	t.ok(summary.startsWith(intro('https://github.com', { installed: 0, total: 0 })), 'the summary has the counts');
	t.ok(summary.includes(gistLink('new-gist')), 'and the gist’s link, since a dry run’s full report is there too');
	t.equal(count(summary, /^- installation \d+: `its account is not in the allowed accounts; skipped`$/gm), 450, 'and every failure, since they fit');
	t.notOk(summary.includes('| Account |'), 'and no account’s counts, since none has discrepancies');
	neverOmits(summary);

	t.end();
});

test('fleet/drift: groups repositories by account, case-insensitively, in result order', (t) => {
	const server = 'https://github.com';
	const { status, stdout, requests } = run({
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
	t.match(stdout, /^3 of 4 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; dry run: no issue changes$/m, 'logs the outcome');
	const full = gistContent(t, requests);
	const missing = ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink(server, name));
	const alphaDiff = full.match(/<li><details><summary><a href="https:\/\/github\.com\/LJHarb\/alpha\/blob\/HEAD\/\.github\/workflows\/rebase\.yml"><code>rebase\.yml<\/code><\/a><\/summary>\n\n```diff\n(?<diff>[^`]+)\n```\n\n<\/details><\/li>/)?.groups?.diff ?? '';
	t.ok(alphaDiff.startsWith('--- rebase.yml (actual)\n+++ rebase.yml (expected)\n'), 'the drifted file has its diff');
	t.ok(withoutLegend(t, full).endsWith([
		'',
		accountTable('es-shims', '1 repository', [row(server, 'es-shims/three', { missing })]),
		'',
		accountTable('LJHarb', '2 repositories', [
			row(server, 'LJHarb/alpha', { drifted: [diffItem(server, 'LJHarb/alpha', 'rebase.yml', alphaDiff)] }),
			row(server, 'ljharb/beta', { missing }),
		]),
	].join('\n')), 'one table per account, in result order (by repository name): one counted in the singular, and one whose repositories share it whatever the case of the owner, named as it first appears, counted in the plural');
	t.equal(count(full, /<table>/g), 2, 'one table per account');

	t.end();
});

test('fleet/drift: every row and every diff is in the gist, however many there are, in files each small enough to show in full', (t) => {
	const names = Array.from({ length: 300 }, (_, i) => `a-repository-with-a-rather-long-name-for-testing-${String(i).padStart(3, '0')}`);
	const { status, stdout, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: names.map((n) => installedRepo('ljharb', n)) },
		repos: Object.fromEntries(names.map((n) => [`ljharb/${n}`, repo({ workflows: replacing('rebase.yml', `${n}\n${'y'.repeat(7000)}\n`) })])),
		issues: [],
		// a previous, bigger report's files, and one that's no longer needed
		gists: [{ id: 'the-gist', description: gistMarker, public: false, files: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`workflow-drift-${String(i + 1).padStart(3, '0')}.md`, {}])) }],
		gistNoRawURL: true,
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^300 of 300 repositories have discrepancies; /m, 'logs the outcome');

	const files = gistFiles(requests);
	t.ok(files.length > 2, `the full report is in several files (${files.length})`);
	t.deepEqual(files.map(([name]) => name), files.map((_, i) => `workflow-drift-${String(i + 1).padStart(3, '0')}.md`), 'named in order');
	t.ok(files.every(([, content]) => Buffer.byteLength(content) < 1000000), 'each under 1 MB');
	const writes = gistWrites(requests);
	t.ok(writes.every((w) => `${w.method} ${w.path}` === 'PATCH /gists/the-gist'), 'each written to the gist it was in');
	t.ok(writes.slice(0, files.length).every((w) => Object.keys(w.body.files).length === 1), 'one file to a request');
	t.deepEqual(writes.slice(files.length).map((w) => w.body), [{ files: Object.fromEntries(Array.from({ length: 12 - files.length }, (_, i) => [`workflow-drift-${String(files.length + i + 1).padStart(3, '0')}.md`, null])) }], 'then the files no longer needed are deleted');
	const full = files.map(([, content]) => content).join('\n');
	t.ok(Buffer.byteLength(full) > 2000000, 'the full report is over 2 MB');
	t.equal(count(full, /<tr><td><a href="https:\/\/github\.com\/ljharb\/a-repository-/g), 300, 'with every row');
	t.equal(count(full, /<li><details><summary>/g), 300, 'and every diff');
	t.equal(count(full, /y{7000}/g), 300, 'each whole');
	neverOmits(full);

	const [create] = issueWrites(requests);
	const { body } = create.body;
	const links = files.map(([name], i) => `[${i + 1}](https://gist.github.com/the-gist/raw/${name})`).join(' · ');
	const note = `${gistLink('the-gist')} It’s in ${files.length} files, each small enough (under 1 MB) for GitHub to show in full; read them in order: ${links}.`;
	t.ok(body.includes(`\n\n${note}\n\n`), 'the issue says how many files, linking each (by the gist’s own link, when a reply has no raw link)');
	t.ok(summary.includes(`\n\n${note}\n\n`), 'and so does the run summary');
	t.ok(body.length < 5000, `the issue (${body.length} characters) is short`);
	t.ok(body.includes('| `ljharb` | 300 | 0 | 0 | 300 | 0 |'), 'counting the account’s drifted files');
	neverOmits(body);

	t.end();
});

test('fleet/drift: a row too long for an issue is whole in the gist', (t) => {
	const names = Array.from({ length: 15 }, (_, i) => `long-error-${String(i).padStart(2, '0')}`);
	const range = 'q'.repeat(100000);
	const { status, requests } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: names.map((n) => installedRepo('ljharb', n)) },
		repos: Object.fromEntries(names.map((n) => [`ljharb/${n}`, repo({ packageJson: JSON.stringify({ engines: { node: range } }) })])),
		issues: [],
	});

	t.equal(status, 0, 'exits successfully');
	const files = gistFiles(requests);
	t.ok(files.length > 1, `the gist has several files (${files.length})`);
	const full = files.map(([, content]) => content).join('\n');
	t.equal(count(full, /<tr><td>/g), 15, 'every row is in the gist');
	t.equal(count(full, new RegExp(`<code>\`engines\\.node\` in \`package\\.json\` is not a valid semver range: ${range}</code>`, 'g')), 15, 'each with its whole error');
	const [create] = issueWrites(requests);
	t.ok(create.body.body.length <= 60000, 'the issue fits');
	t.ok(create.body.body.includes('| `ljharb` | 15 | 0 | 0 | 0 | 15 |'), 'counting the repositories with other problems');

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
	t.match(stdout, /^1 of 2 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; dry run: no issue changes$/m, 'the source is checked, and the forks are not');
	const commits = matching(requests, 'GET', /\/commits\?/);
	t.deepEqual(commits.map((r) => r.path.split('?')[0]), ['/repos/Upstream/source/commits'], 'only the source in an allowed account is checked for commits');
	t.equal(new URLSearchParams(commits[0].path.split('?')[1]).get('committer'), 'the-committer', 'by the `committer` input');
	const full = gistContent(t, requests);
	t.ok(full.includes(accountTable('Upstream', '1 repository', [
		row('https://github.com', 'Upstream/source', {
			missing: ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink('https://github.com', name)),
		}),
	])), 'the source is in the report, under its own account');
	t.notOk(full.includes('elsewhere/source'), 'a source in another account is not');
	t.notOk(full.includes('ljharb/fork') || full.includes('ljharb/other-fork'), 'nor are the forks');
	t.ok(summary.startsWith(intro('https://github.com', { installed: 1, total: 1, sources: 1 })), 'the intro counts installed repositories and fork sources separately');

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
	t.match(none.stdout, /^0 of 1 repositories have discrepancies; [^\n]*; dry run: no issue changes$/m, 'without a committer, no source is checked');
	t.deepEqual(matching(none.requests, 'GET', /\/commits\?/), [], 'and no commits are listed');

	const unset = run(scenario, { INPUT_COMMITTER: 'the-committer', 'INPUT_DRY-RUN': 'true' });
	t.match(unset.stdout, /^0 of 1 repositories have discrepancies; [^\n]*; dry run: no issue changes$/m, 'without source accounts, no source is checked');
	t.deepEqual(matching(unset.requests, 'GET', /\/commits\?/), [], 'and no commits are listed');

	t.end();
});

test('fleet/drift: failures', (t) => {
	const noGist = run({}, { 'INPUT_GIST-TOKEN': '' });
	t.equal(noGist.status, 1, 'a missing gist token fails');
	t.match(noGist.stdout, /^::error::`gist-token` is required: the full report is kept in a secret gist\. Add a `FLEET_GIST_TOKEN` repository secret with a token that can write gists: a fine-grained token with the “Gists” account permission set to “Read and write”, or a classic token with the `gist` scope\.$/m, 'saying how to set it up');
	t.deepEqual(noGist.requests, [], 'before any request, so nothing is wasted');
	t.equal(noGist.summary, '', 'and no summary');

	const missing = run({}, { 'INPUT_APP-ID': '' });
	t.equal(missing.status, 1, 'a missing required input fails');
	t.match(missing.stdout, /^::error::Error: Input required and not supplied: app-id$/m, 'with the error');
	t.deepEqual(missing.requests, [], 'before any request');

	const thrown = run({}, { INPUT_ACCOUNTS: 'fleet-test-throw' }, { throwStringOnSplit: 'fleet-test-throw' });
	t.equal(thrown.status, 1, 'a thrown non-Error fails');
	t.match(thrown.stdout, /^::error::fleet-test-throw$/m, 'with the stringified value');

	const scenario = {
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'missing')] },
		repos: { 'ljharb/missing': repo({ workflows: null }) },
	};
	const permission = 'the App needs the “Issues: Read and write” repository permission, and must be installed on `ljharb/actions`. After that permission is added to the App, its installation on `ljharb` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.';
	const denied = run({ ...scenario, issues: [], deniedPermissions: ['issues'] });
	t.equal(denied.status, 1, 'an App without the Issues permission fails, when not a dry run');
	t.ok(denied.stdout.split('\n').includes(`::error::Error: the fleet GitHub App could not get a token to write issues in \`ljharb/actions\` (HTTP 422): ${permission}`), 'saying which permission it needs, and that its installation must approve it');
	t.ok(denied.summary.includes(gistLink('new-gist')), 'but still writes the gist and the summary first');
	t.ok(gistContent(t, denied.requests).includes('<code>ljharb/missing</code>'), 'with the full report');
	t.deepEqual(issueWrites(denied.requests), [], 'and touches no issue');

	const uninstalled = run({ ...scenario, issues: [], repoInstallations: { 'ljharb/actions': { status: 404 } } });
	t.equal(uninstalled.status, 1, 'an App not installed on the report repo fails');
	t.ok(uninstalled.stdout.split('\n').includes(`::error::Error: the fleet GitHub App could not get a token to write issues in \`ljharb/actions\` (HTTP 404): ${permission}`), 'saying the same');
	t.ok(uninstalled.summary.includes(gistLink('new-gist')), 'after writing the summary');
	t.deepEqual(matching(uninstalled.requests, 'POST', /\/access_tokens$/).filter((r) => r.body?.permissions?.issues), [], 'without asking for a token');

	const noSlug = run({ ...scenario, issues: [], appSlug: null });
	t.equal(noSlug.status, 1, 'an App whose slug can’t be read fails');
	t.match(noSlug.stdout, /^::error::Error: could not determine the GitHub App’s slug$/m, 'saying so');
	t.deepEqual(issueWrites(noSlug.requests), [], 'touching no issue');

	const gist = run({ ...scenario, issues: [], gistError: { status: 403, body: { message: 'Resource not accessible by personal access token' } } });
	t.equal(gist.status, 1, 'failing to write the gist fails');
	t.match(gist.stdout, /^::error::the full report could not be written to its gist: HttpError: Resource not accessible by personal access token/m, 'with the error');
	t.match(gist.stdout, /^1 of 1 repositories have discrepancies; the full report could not be written to its gist; created /m, 'logging the outcome');
	const failedNote = /\n\n⚠️ \*\*The full report could not be written to its gist\*\* \(`HttpError: Resource not accessible by personal access token[^`]*`\), so this run failed, and \[its log\]\(https:\/\/github\.com\/ljharb\/actions\/actions\/runs\/42\) has the error; the next run will try again\.\n\n/;
	t.match(gist.summary, failedNote, 'but still writing the summary, saying so');
	const [created] = issueWrites(gist.requests);
	t.equal(created && `${created.method} ${created.path}`, 'POST /repos/ljharb/actions/issues', 'and the issue, so it’s never out of date');
	t.match(String(created?.body.body), failedNote, 'saying so there, too');
	t.ok(String(created?.body.body).includes('| `ljharb` | 1 | 3 | 0 | 0 | 0 |'), 'with its counts');

	t.end();
});

test('fleet/drift: nothing about a private repository reaches the log, the summary, the issue, or the gist', (t) => {
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
	const full = gistContent(t, requests);
	t.notOk(full.includes('ljharb/visible'), 'not one it requires, nor one it forbids');
	t.notOk(full.includes('es-shims/shown'), 'nor its being invalid');
	t.notOk(body.includes('| `'), 'and no account has public discrepancies to count');
	const secrets = ['secret', 'hidden', 'zero', '0.x', 'preset', 'defaults', 'internal-ci.yml'];
	for (const [where, text] of [['the log', stdout], ['stderr', stderr], ['the summary', summary], ['the issue', body], ['the title', String(created?.body.title)], ['the gist', full]]) {
		// the gist's link says it's a secret gist, which is GitHub's name for one only those with its link can see
		t.deepEqual(secrets.filter((secret) => text.replace(gistLink('new-gist'), '').includes(secret)), [], `${where} reveals nothing about a private repository`);
	}
	t.end();
});

test('fleet/drift: third-party text in HTML is kept to one inert line', (t) => {
	const server = 'https://github.com';
	const range = '>=1\n\n[x](https://evil.example)\r\n \r\n![i](https://evil.example/i.png)\n\n````\n\n<b>bold</b>\n';
	const { status, requests } = run({
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

	const full = gistContent(t, requests);
	const other = '<code>`engines.node` in `package.json` is not a valid semver range: &#62;=1 [x](https://evil.example) ![i](https://evil.example/i.png) ```` &#60;b&#62;bold&#60;/b&#62;</code>';
	t.ok(full.includes(row(server, 'ljharb/evil', { other })), 'the error is one line, HTML-escaped, inside its `<code>`');
	const cell = full.match(/<td>\n<code>`engines\.node`[^]*?<\/code>\n<\/td>/)?.[0] ?? '';
	t.notOk((/\n\s*\n/).test(cell), 'with no blank line to end the HTML block');
	t.notOk((/^\s*(?:\[x\]|!\[i\]|````|<b>)/m).test(full), 'so no link, image, fence, or markup starts a line of its own');
	const missing = ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => templateLink(server, name));
	t.ok(withoutLegend(t, full).endsWith(`\n${accountTable('zzz', '1 repository', [row(server, 'zzz/after', { missing })])}`), 'and a later account’s table is intact');
	t.notOk(issueWrites(requests)[0].body.body.includes('evil'), 'the issue has none of it');

	t.end();
});

test('fleet/drift: repository and owner names are kept to one line', (t) => {
	const server = 'https://github.com';
	const { status, requests, summary } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'new\nline'), installedRepo('odd\r\n owner', 'x')] },
		repos: {
			'ljharb/new\nline': repo({ workflows: null }),
			'odd\r\n owner/x': repo({ workflows: null }),
		},
	}, { 'INPUT_DRY-RUN': 'true' });

	t.equal(status, 0, 'exits successfully');
	const full = gistContent(t, requests);
	t.ok(full.includes('"><code>ljharb/new line</code></a></td>'), 'a newline in a repository’s name is a space in its link text');
	t.notOk(full.includes('<code>ljharb/new\nline</code>'), 'and not a newline');
	t.ok(full.includes('<details><summary><b>odd owner</b>: 1 repository</summary>'), 'a run of whitespace with a newline in an owner’s name is one space');
	t.ok(full.includes('"><code>odd owner/x</code></a></td>'), 'in its repositories’ names too');
	t.ok(full.includes(templateLink(server, 'rebase.yml')), 'each with its missing files');
	t.ok(summary.includes('| `odd owner` | 1 | 3 | 0 | 0 | 0 |'), 'and in the summary’s counts');

	t.end();
});

test('fleet/drift: a repository’s link escapes HTML in its href', (t) => {
	const { status, requests } = run({
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [installedRepo('ljharb', 'a"b&c')] },
		repos: { 'ljharb/a"b&c': repo({ workflows: null }) },
	}, { 'INPUT_DRY-RUN': 'true' });

	t.equal(status, 0, 'exits successfully');
	const full = gistContent(t, requests);
	t.ok(
		full.includes('<a href="https://github.com/ljharb/a&#34;b&#38;c/tree/HEAD/.github/workflows"><code>ljharb/a&#34;b&#38;c</code></a>'),
		'the href and the link text are both escaped',
	);
	t.notOk(full.includes('href="https://github.com/ljharb/a"b'), 'no raw quote ends the href early');

	t.end();
});

test('fleet/drift: too many failures for the issue are counted there, and every one is in the gist', (t) => {
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
	t.ok(body.length <= 60000, `the issue (${body.length} characters) fits`);
	t.equal(count(body, /^- installation /gm), 0, 'listing no failure');
	t.ok(body.includes('\n\n⚠️ 1500 repositories or installations could not be checked, so this report is incomplete; [the full report](https://gist.github.com/new-gist) lists them all.\n\n'), 'but counting them, and linking the full report, which lists them');
	t.ok(body.includes('| `ljharb` | 1 | 3 | 0 | 0 | 0 |'), 'and still counting the account’s discrepancies');
	t.ok(summary.includes('1500 repositories or installations could not be checked'), 'the run summary is the same');

	const full = gistContent(t, requests);
	t.equal(count(full, /^- installation \d+: `its account is not in the allowed accounts; skipped`$/gm), 1500, 'the gist lists every failure');
	t.ok(full.includes('<code>ljharb/missing</code>'), 'and the row');
	neverOmits(full);

	t.end();
});

test('fleet/drift: writes the gist and the summary even when the issue write fails', (t) => {
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
	t.ok(summary.includes(gistLink('new-gist')), 'the summary was still written');
	t.ok(gistContent(t, requests).includes('<code>ljharb/missing</code>'), 'and the gist');

	t.end();
});
