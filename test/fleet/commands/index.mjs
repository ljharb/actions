import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import test from 'tape';

import { legend } from '../../../fleet/commands/syntax.mjs';
import { marker } from '../../../fleet/drift/marker.mjs';
import { runChild } from '../drift/helpers/child.mjs';
import { nodeWorkflow, standardWorkflows, template } from '../drift/helpers/states.mjs';
import { versionFixture } from '../drift/helpers/versions.mjs';
import {
	bot,
	gitIsolation,
	mallory,
	tempDir,
} from '../lib/helpers/git.mjs';
import { installedRepo, privateKey } from '../lib/helpers/github.mjs';
import { makeRemotes } from './helpers/remotes.mjs';

/** @typedef {import('../lib/helpers/github.mjs').Scenario} GitHubScenario */
/** @typedef {import('../lib/helpers/github.mjs').RepoSpec} RepoSpec */
/** @typedef {import('../lib/helpers/github.mjs').Recorded} Recorded */
/** @typedef {import('./helpers/preload.mjs').Scenario} Scenario */
/** @typedef {import('./helpers/preload.mjs').CommandsScenario} CommandsScenario */
/** @typedef {import('../drift/helpers/child.mjs').ChildResult} ChildResult */
/** @typedef {{ name: string, text: string | null }[]} Workflows */

const script = path.join('fleet', 'commands', 'index.mjs');
const preload = pathToFileURL(path.join(import.meta.dirname, 'helpers', 'preload.mjs')).href;
const commentURL = 'https://github.com/ljharb/actions/issues/9#issuecomment-77';
const title = '[actions] update workflow files to match the shared templates';
const message = '[actions] update workflow files to match ljharb/actions’ templates';
const notReport = /^not a comment on the workflow drift report; nothing to do$/m;

const report = {
	number: 9,
	body: `${marker}\nthe report`,
	user: { login: 'github-actions[bot]' },
};

/** @type {(body: string, login?: string) => Record<string, unknown>} */
function comment(body, login = 'maintainer') {
	return {
		id: 77, body, user: { login }, html_url: commentURL, // eslint-disable-line camelcase
	};
}

/**
 * @type {(options?: {
 *   workflows?: Workflows | null,
 *   config?: string,
 *   isPrivate?: boolean,
 *   defaultBranch?: string | null,
 *   packageJson?: string,
 * }) => RepoSpec}
 */
function repo({
	workflows = standardWorkflows(), config, isPrivate = false, defaultBranch = 'main', packageJson,
} = {}) {
	return {
		data: {
			isArchived: false,
			isPrivate,
			defaultBranchRef: defaultBranch ? { name: defaultBranch } : null,
			config: typeof config === 'string' ? { text: config } : null,
			packageJson: typeof packageJson === 'string' ? { text: packageJson } : null,
			workflows: workflows && {
				entries: workflows.map(({ name, text }) => ({ name, type: 'blob', object: typeof text === 'string' ? { text } : {} })),
			},
		},
	};
}

/** @type {(name: string, text: string, workflows?: Workflows) => Workflows} */
function replacing(name, text, workflows = standardWorkflows()) {
	return [...workflows.filter((f) => f.name !== name), { name, text }];
}

/** @type {(workflows: Workflows) => Record<string, string>} */
function files(workflows) {
	return Object.fromEntries(workflows.map(({ name, text }) => [`.github/workflows/${name}`, String(text)]));
}

/**
 * @type {(t: import('tape').Test, options: {
 *   event: unknown,
 *   github?: GitHubScenario,
 *   commands?: CommandsScenario,
 *   env?: Record<string, string>,
 *   throwStringOnSplit?: string,
 *   versions?: boolean,
 * }) => ChildResult}
 */
function run(t, {
	event, github = {}, commands = { permissions: { maintainer: 'write' } }, env = {}, throwStringOnSplit, versions = false,
}) {
	const eventPath = path.join(tempDir(t, 'fleet-commands-event'), 'event.json');
	writeFileSync(eventPath, JSON.stringify(event));
	/** @type {Scenario} */
	const scenario = {
		github,
		commands,
		...throwStringOnSplit ? { throwStringOnSplit } : {},
		...versions ? { versions: versionFixture() } : {},
	};
	return runChild([script], {
		scenario,
		preload,
		env: {
			...gitIsolation,
			'INPUT_APP-ID': '1234',
			'INPUT_PRIVATE-KEY': privateKey(),
			INPUT_ACCOUNTS: 'ljharb',
			INPUT_TOKEN: 'ghp_commands',
			'INPUT_ISSUE-AUTHOR': 'github-actions[bot]',
			GITHUB_EVENT_PATH: eventPath,
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

/** @type {(requests: Recorded[]) => string[]} */
function replies(requests) {
	return matching(requests, 'POST', /^\/repos\/ljharb\/actions\/issues\/9\/comments$/).map((r) => r.body.body);
}

/** @type {(requests: Recorded[]) => string[]} */
function changes(requests) {
	return requests.filter((r) => r.method !== 'GET' && (/\/(?:pulls|issues)\b/).test(r.path) && !(/\/ljharb\/actions\//).test(r.path)).map((r) => `${r.method} ${r.path}`);
}

/** @type {(dryRun: boolean) => string} */
function privateNote(dryRun) {
	return `Private repositories matching these filters, if any, ${dryRun ? 'would also be' : 'were also'} processed; nothing about them is shown here.`;
}

/** @type {(line: string, rows: string[], extra?: string[], dryRun?: boolean) => string} */
function expectedReply(line, rows, extra = [], dryRun = false) {
	return [
		`\`${line}\` (${dryRun ? 'a dry run, so nothing was changed' : 'from each repository’s `fleet/workflows` branch'}; see [the run](https://github.com/ljharb/actions/actions/runs/42)):`,
		'',
		...rows.length > 0 ? ['| Repository | Outcome |', '| --- | --- |', ...rows] : [],
		...extra,
		'',
		privateNote(dryRun),
	].join('\n');
}

// GitHub never shows a mask in the log, and each token's is the same, whichever repository it's for
/** @type {(text: string) => string} */
function shown(text) {
	return text.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
}

test('fleet/commands: ignores anything but a command on the report issue', (t) => {
	const events = [
		['no issue', {}],
		['a PR', { issue: { ...report, pull_request: {} }, comment: comment('/fix ljharb') }], // eslint-disable-line camelcase
		['an issue without a body', { issue: { ...report, body: null }, comment: comment('/fix ljharb') }],
		['an issue without the marker', { issue: { ...report, body: 'some other issue' }, comment: comment('/fix ljharb') }],
		['an issue without a creator', { issue: { number: 9, body: marker }, comment: comment('/fix ljharb') }],
		['an issue someone else created', { issue: { ...report, user: { login: 'mallory' } }, comment: comment('/fix ljharb') }],
	];
	for (const [label, event] of events) {
		const { status, stdout, requests } = run(t, { event });
		t.equal(status, 0, `${label}: exits successfully`);
		t.match(stdout, notReport, `${label}: says why it does nothing`);
		t.deepEqual(requests, [], `${label}: makes no request`);
	}

	const other = run(t, { event: { issue: report, comment: comment('thanks!\n/fix ljharb') } });
	t.equal(other.status, 0, 'a comment that is not a command: exits successfully');
	t.match(other.stdout, /^not a command; nothing to do$/m, 'says why it does nothing');
	t.deepEqual(other.requests, [], 'makes no request');

	const author = run(t, {
		event: { issue: { ...report, user: { login: 'report-bot' } }, comment: comment('/frob') },
		env: { 'INPUT_ISSUE-AUTHOR': 'report-bot' },
	});
	t.equal(author.status, 0, 'exits successfully');
	t.doesNotMatch(author.stdout, notReport, 'the report is the issue that `issue-author` created');
	t.equal(replies(author.requests).length, 1, 'so a command on it gets a reply');

	t.end();
});

test('fleet/commands: only people with write access can run commands', (t) => {
	/** @type {[string, Record<string, string>][]} */
	const cases = [['no access', {}], ['read access', { maintainer: 'read' }]];
	for (const [label, permissions] of cases) {
		const { status, stdout, requests } = run(t, { event: { issue: report, comment: comment('/fix ljharb') }, commands: { permissions } });
		t.equal(status, 0, `${label}: exits successfully`);
		t.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
			'GET /repos/ljharb/actions/collaborators/maintainer/permission',
			'POST /repos/ljharb/actions/issues/9/comments',
		], `${label}: asks for the commenter’s permission, then only replies: no reaction, and no discovery`);
		t.equal(requests[0].authorization, 'token ghp_commands', `${label}: with the token`);
		t.deepEqual(replies(requests), ['Only people with write access to this repository can run fleet commands, so nothing was done.'], `${label}: says they’re not allowed`);
		t.match(stdout, new RegExp(`^the commenter’s permission is \`${permissions.maintainer ?? 'none'}\`; nothing done$`, 'm'), `${label}: logs why`);
	}

	t.end();
});

test('fleet/commands: replies with the legend to anything it can’t run', (t) => {
	const cases = [
		['/frobnicate <b>everything</b>', 'Unknown command: `/frobnicate <b>everything</b>`.'],
		['/fix', '`/fix` needs at least one filter: every repository at once is too broad.'],
		['/dry-run fix', '`/dry-run fix` needs at least one filter: every repository at once is too broad.'],
		['/fix ljharb @everyone ![x](https://evil.example)', 'Unknown filters: `@everyone`, `![x](https://evil.example)`.'],
	];
	for (const [body, expected] of cases) {
		const { status, stdout, requests } = run(t, { event: { issue: report, comment: comment(body, 'admin-person') }, commands: { permissions: { 'admin-person': 'admin' } } });
		t.equal(status, 0, `${body}: exits successfully`);
		t.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
			'GET /repos/ljharb/actions/collaborators/admin-person/permission',
			'POST /repos/ljharb/actions/issues/comments/77/reactions',
			'POST /repos/ljharb/actions/issues/9/comments',
		], `${body}: reacts, then replies, and does nothing else`);
		t.deepEqual(requests[1].body, { content: 'eyes' }, `${body}: reacts with 👀`);
		t.equal(requests[1].authorization, 'token ghp_commands', `${body}: with the token`);
		t.deepEqual(replies(requests), [`${expected} Nothing was done.\n\n${legend()}`], `${body}: explains, then shows the legend`);
		t.match(stdout, /^not a valid command; replied with how to use them$/m, `${body}: logs it`);
	}

	t.end();
});

test('fleet/commands: quotes a long command whole', (t) => {
	const line = `/dry-run fix ${Array(30).fill('ljharb/nope').join(' ')}`;
	const { status, requests } = run(t, { event: { issue: report, comment: comment(`${line}\nmore`) } });
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(replies(requests), [expectedReply(line, [], ['No repository matches those filters.'], true)], 'in the reply');

	t.end();
});

test('fleet/commands: a reply too long for one comment goes on in more, with nothing left out', (t) => {
	const line = `/frob${'<b>x</b> @someone '.repeat(5000)}end`;
	const { status, requests } = run(t, { event: { issue: report, comment: comment(line) } });
	t.equal(status, 0, 'exits successfully');
	const bodies = replies(requests);
	t.ok(bodies.length > 1, `in several comments (${bodies.length})`);
	bodies.forEach((body, i) => t.ok(body.length <= 60000, `comment ${i + 1} (${body.length} characters) fits`));
	t.ok(bodies.slice(0, -1).every((body) => body.includes('_✂️ This item is too long to fit in one part, so it’s shown as its source')), 'the error, too long for any one comment, is shown as its source, in pieces');
	const sources = bodies.slice(0, -1).map((body) => body.match(/\n\n(?<ticks>`{3,})\n(?<source>[^]*)\n\k<ticks>(?:\n|$)/)?.groups?.source ?? '');
	t.equal(sources.join(''), `Unknown command: \`${line}\`. Nothing was done.`, 'which, together, are the whole error, quoting the whole command, inertly');
	t.ok(bodies.at(-1)?.endsWith(`\n\n${legend()}`), 'and the last comment ends with the legend');
	t.ok(bodies.slice(1).every((body, i) => body.startsWith(`_continued (${i + 2}/${bodies.length})_\n\n`)), 'each later comment says it continues the reply');

	t.end();
});

test('fleet/commands: dry run', (t) => {
	const drifted = replacing('rebase.yml', 'nope\n');
	const { status, stdout, requests, summary } = run(t, {
		event: { issue: report, comment: comment('/dry-run fix ljharb') },
		github: {
			installations: [
				{ id: 1, account: { login: 'ljharb' } },
				{ id: 2, account: { login: 'stranger' } },
				{ id: 3, account: { login: 'ljharb' } },
			],
			installationRepos: {
				3: { status: 403, body: { message: 'Forbidden' } },
				1: [
					installedRepo('ljharb', 'clean'),
					installedRepo('ljharb', 'drifted'),
					installedRepo('ljharb', 'missing'),
					installedRepo('ljharb', 'fresh'),
					installedRepo('ljharb', 'secret', { private: true }),
					installedRepo('ljharb', 'untemplated'),
				],
			},
			repos: {
				'ljharb/clean': repo(),
				'ljharb/drifted': repo({ workflows: drifted }),
				'ljharb/missing': repo({ workflows: null }),
				'ljharb/fresh': repo({ workflows: replacing('node-pretest.yml', 'nope\n') }),
				'ljharb/secret': repo({ workflows: null, isPrivate: true }),
				'ljharb/untemplated': repo({ config: '{ "workflows": { "custom.yml": true } }' }),
			},
		},
		commands: {
			permissions: { maintainer: 'write' },
			pulls: {
				'ljharb/drifted': [{
					number: 4, state: 'open', merged_at: null, head: { sha: 'abc' }, // eslint-disable-line camelcase
				}],
				'ljharb/missing': [{
					number: 5, state: 'closed', merged_at: null, head: { sha: 'def' }, // eslint-disable-line camelcase
				}],
			},
		},
		env: { INPUT_ACCOUNTS: '', GITHUB_REPOSITORY_OWNER: 'ljharb' },
	});

	t.equal(status, 0, 'exits successfully');
	t.match(stdout, /^::warning::installation 2: its account is not in the allowed accounts; skipped$/m, 'warns about discovery failures, with only the repository’s owner allowed by default');
	t.notOk(stdout.includes('stranger'), 'never naming an account that isn’t allowed');
	t.match(stdout, /^::warning::installation 3: /m, 'including an installation that can’t be read');
	const missing = ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => `\`.github/workflows/${name}\`: added, since it’s missing`);
	const body = expectedReply('/dry-run fix ljharb', [
		'| `ljharb/drifted` | would update https://github.com/ljharb/drifted/pull/4<br>`.github/workflows/rebase.yml`: rewritten from its template, since it has drifted |',
		'| `ljharb/fresh` | would create a PR<br>`.github/workflows/node-pretest.yml`: rewritten from its template, since it has drifted |',
		`| \`ljharb/missing\` | would reopen and update https://github.com/ljharb/missing/pull/5<br>${missing.join('<br>')} |`,
		'| `ljharb/untemplated` | nothing to fix<br>left as it is: `.github/workflows/custom.yml`: `there is no template for it` |',
	], [
		'',
		'⚠️ Some repositories could not be read, so they were not considered; see [the run](https://github.com/ljharb/actions/actions/runs/42).',
	], true);
	t.deepEqual(replies(requests), [body], 'replies with what it would do, in each public repository with discrepancies, by name; a clean one isn’t listed, and a private one isn’t mentioned');
	t.equal(summary, body, 'the run summary has the same');
	t.notOk(summary.includes('secret'), 'never naming a private repository');

	const tokens = matching(requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).filter((r) => r.body?.repositories);
	t.deepEqual(tokens.map((r) => r.body), ['drifted', 'fresh', 'missing', 'secret'].map((name) => ({ repositories: [name], permissions: { pull_requests: 'read' } })), 'reads each repository’s PRs with a token for only that repository, that can only read PRs, a private one’s last'); // eslint-disable-line camelcase
	const pulls = matching(requests, 'GET', /^\/repos\/ljharb\/drifted\/pulls\?/);
	t.equal(new URLSearchParams(pulls[0].path.split('?')[1]).get('head'), 'ljharb:fleet/workflows', 'from the `fleet/workflows` branch');
	t.deepEqual(changes(requests), [], 'changes nothing');
	t.deepEqual(matching(requests, 'GET', /^\/app$/), [], 'and never even looks up its bot user');

	t.end();
});

test('fleet/commands: filters', (t) => {
	const github = {
		installations: [
			{ id: 1, account: { login: 'ljharb' } },
			{ id: 2, account: { login: 'es-shims' } },
			{ id: 3, account: { login: 'inspect-js' } },
			// skipped on purpose, so the reply doesn't warn about it
			{ id: 4, account: { login: 'stranger' } },
		],
		installationRepos: {
			1: [installedRepo('ljharb', 'a'), installedRepo('ljharb', 'b'), installedRepo('ljharb', 'clean'), installedRepo('ljharb', 'gone'), installedRepo('ljharb', 'secret', { private: true })],
			2: [installedRepo('es-shims', 'c')],
			3: [installedRepo('inspect-js', 'd')],
		},
		repos: {
			'ljharb/a': repo({ workflows: null }),
			'ljharb/b': repo({ workflows: replacing('rebase.yml', 'nope\n') }),
			// `ljharb/gone` is not found by GraphQL
			'ljharb/clean': repo(),
			'ljharb/secret': repo({ workflows: null, isPrivate: true }),
			'es-shims/c': repo({ workflows: replacing('rebase.yml', 'nope\n').filter((f) => f.name !== 'node-pretest.yml') }),
			// `engines.node` needs only `node.yml`
			'inspect-js/d': repo({
				packageJson: '{ "engines": { "node": "^20" } }',
				workflows: [...standardWorkflows(), { name: 'node.yml', text: nodeWorkflow() }, { name: 'node-tens.yml', text: nodeWorkflow() }],
			}),
		},
	};
	/** @type {(name: string) => string} */
	const add = (name) => `\`.github/workflows/${name}\`: added, since it’s missing`;
	/** @type {(name: string) => string} */
	const rewrite = (name) => `\`.github/workflows/${name}\`: rewritten from its template, since it has drifted`;
	/** @type {(...parts: string[]) => string} */
	const create = (...parts) => ['would create a PR', ...parts].join('<br>');
	/** @type {[string, string[], string[]?][]} */
	const cases = [
		['/dry-run fix es-shims inspect-js', [
			`| \`es-shims/c\` | ${create(add('node-pretest.yml'), rewrite('rebase.yml'))} |`,
			`| \`inspect-js/d\` | ${create('`.github/workflows/node-tens.yml`: deleted, since it’s unexpected')} |`,
		]],
		// a private repository matches like any other, but is never mentioned
		['/dry-run fix REBASE.yml ljharb', [
			`| \`ljharb/a\` | ${create(add('rebase.yml'))} |`,
			`| \`ljharb/b\` | ${create(rewrite('rebase.yml'))} |`,
		]],
		['/dry-run fix rebase.yml drifted', [
			`| \`es-shims/c\` | ${create(rewrite('rebase.yml'))} |`,
			`| \`ljharb/b\` | ${create(rewrite('rebase.yml'))} |`,
		]],
		['/dry-run fix ljharb/A es-shims/c missing', [
			`| \`es-shims/c\` | ${create(add('node-pretest.yml'))} |`,
			`| \`ljharb/a\` | ${create(add('node-pretest.yml'), add('rebase.yml'), add('require-allow-edits.yml'))} |`,
		]],
		['/dry-run fix ljharb/clean ljharb/b inspect-js/d ljharb', [
			`| \`ljharb/b\` | ${create(rewrite('rebase.yml'))} |`,
			'| `ljharb/clean` | nothing to fix |',
		]],
		['/dry-run fix ljharb/clean missing', ['| `ljharb/clean` | nothing to fix |']],
		['/dry-run fix ljharb/gone rebase.yml', ['| `ljharb/gone` | failed: `could not read the repository’s state` |']],
		['/dry-run fix ljharb/nope', [], ['No repository matches those filters.']],
		['/dry-run fix ljharb/secret ljharb/secret', [], ['No repository matches those filters.']],
		['/dry-run fix ljharb missing', [
			`| \`ljharb/a\` | ${create(add('node-pretest.yml'), add('rebase.yml'), add('require-allow-edits.yml'))} |`,
		]],
		['/dry-run fix ljharb', [
			`| \`ljharb/a\` | ${create(add('node-pretest.yml'), add('rebase.yml'), add('require-allow-edits.yml'))} |`,
			`| \`ljharb/b\` | ${create(rewrite('rebase.yml'))} |`,
			'| `ljharb/gone` | failed: `could not read the repository’s state` |',
		]],
		// naming every allowed account narrows nothing
		['/dry-run fix inspect-js ljharb es-shims', [
			`| \`es-shims/c\` | ${create(add('node-pretest.yml'), rewrite('rebase.yml'))} |`,
			`| \`inspect-js/d\` | ${create('`.github/workflows/node-tens.yml`: deleted, since it’s unexpected')} |`,
			`| \`ljharb/a\` | ${create(add('node-pretest.yml'), add('rebase.yml'), add('require-allow-edits.yml'))} |`,
			`| \`ljharb/b\` | ${create(rewrite('rebase.yml'))} |`,
			'| `ljharb/gone` | failed: `could not read the repository’s state` |',
		]],
		['/dry-run fix ljharb missing es-shims/c', [], ['No repository matches those filters.']],
	];
	// which of them match `ljharb/secret`, which has every standard file missing
	const privateMatches = new Set([
		'/dry-run fix REBASE.yml ljharb',
		'/dry-run fix ljharb/secret ljharb/secret',
		'/dry-run fix ljharb missing',
		'/dry-run fix ljharb',
		'/dry-run fix inspect-js ljharb es-shims',
	]);
	for (const [line, rows, extra = []] of cases) {
		const { status, stdout, requests } = run(t, {
			event: { issue: report, comment: comment(line) }, github, env: { INPUT_ACCOUNTS: 'ljharb es-shims inspect-js' }, versions: true,
		});
		const failing = rows.some((row) => row.includes('| failed: '));
		t.equal(status, Number(failing), `${line}: ${failing ? 'fails, since a repository failed' : 'exits successfully'}`);
		t.deepEqual(replies(requests), [expectedReply(line, rows, extra, true)], `${line}: only the matching public repositories, and only their matching files`);
		const planned = matching(requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).some((r) => r.body?.repositories?.[0] === 'secret');
		t.equal(planned, privateMatches.has(line), `${line}: the private repository is ${privateMatches.has(line) ? '' : 'not '}planned, as the filters say`);
		t.notOk(stdout.includes('secret') || stdout.includes('private repositor'), `${line}: and never mentioned in the log`);
	}

	t.end();
});

test('fleet/commands: a reply for filters that match only private repositories is the same as for ones that match nothing', (t) => {
	for (const [line, dryRun] of /** @type {const} */ ([['/dry-run fix ljharb/secret', true], ['/fix ljharb/secret', false], ['/fix ljharb/secret-broken', false]])) { // eslint-disable-line no-extra-parens
		const remotes = makeRemotes(t, { 'ljharb/secret': {} });
		const commands = { permissions: { maintainer: 'write' }, serverURL: remotes.serverURL };
		const env = { GITHUB_SERVER_URL: remotes.serverURL };
		const event = { issue: report, comment: comment(line) };
		const withPrivate = run(t, {
			event,
			github: {
				installations: [{ id: 1, account: { login: 'ljharb' } }],
				installationRepos: { 1: [installedRepo('ljharb', 'clean'), installedRepo('ljharb', 'secret', { private: true }), installedRepo('ljharb', 'secret-broken', { private: true })] },
				repos: {
					'ljharb/clean': repo(),
					'ljharb/secret': repo({ workflows: null, isPrivate: true }),
					// not on the git server at all, so fixing it fails
					'ljharb/secret-broken': repo({ workflows: null, isPrivate: true, defaultBranch: 'release-secret' }),
				},
			},
			commands,
			env,
		});
		const without = run(t, {
			event,
			github: {
				installations: [{ id: 1, account: { login: 'ljharb' } }],
				installationRepos: { 1: [installedRepo('ljharb', 'clean')] },
				repos: { 'ljharb/clean': repo() },
			},
			commands,
			env,
		});

		t.equal(withPrivate.status, 0, `${line}: exits successfully${line.endsWith('broken') ? ', though the private repository failed' : ''}`);
		t.equal(without.status, 0, `${line}: as it does when nothing matches`);
		t.deepEqual(replies(withPrivate.requests), [expectedReply(line, [], ['No repository matches those filters.'], dryRun).replace('https://github.com', remotes.serverURL)], `${line}: the reply says no repository matched`);
		t.deepEqual(replies(withPrivate.requests), replies(without.requests), `${line}: byte for byte what it says when nothing matches`);
		t.equal(withPrivate.summary, without.summary, `${line}: and so is the summary`);
		t.equal(shown(withPrivate.stdout), shown(without.stdout), `${line}: and the log`);
		t.equal(withPrivate.stderr, without.stderr, `${line}: and stderr`);

		const tokens = matching(withPrivate.requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).filter((r) => r.body?.repositories);
		t.deepEqual(tokens.map((r) => r.body.repositories), [[line.split('/').pop()]], `${line}: but the named private repository is processed`);
		if (line === '/fix ljharb/secret') {
			t.deepEqual(changes(withPrivate.requests), ['POST /repos/ljharb/secret/pulls'], `${line}: and fixed, in a PR`);
			t.equal(remotes.show('ljharb/secret', 'fleet/workflows', '.github/workflows/rebase.yml'), template('rebase.yml'), `${line}: from its template`);
		} else {
			t.deepEqual(changes(withPrivate.requests), [], `${line}: changing nothing`);
		}
	}

	t.end();
});

test('fleet/commands: fixes each repository in a PR from its `fleet/workflows` branch, carrying on past failures', (t) => {
	const drifted = replacing('node-pretest.yml', 'nope\n', replacing('rebase.yml', 'nope\n'));
	const remotes = makeRemotes(t, {
		'ljharb/new': {},
		'ljharb/existing': files(drifted),
		'ljharb/current': files(standardWorkflows()),
		'ljharb/clean': files(standardWorkflows()),
		'ljharb/foreign': files(replacing('rebase.yml', 'nope\n')),
		'ljharb/secret': {},
	});
	// an earlier `/fix` fixed only `rebase.yml`
	const earlier = remotes.commit('ljharb/existing', 'fleet/workflows', { '.github/workflows/rebase.yml': template('rebase.yml') }, { who: bot, from: 'main' });
	const foreign = remotes.commit('ljharb/foreign', 'fleet/workflows', { 'README.md': 'not the bot’s\n' }, { who: mallory, from: 'main' });
	const names = ['new', 'existing', 'current', 'clean', 'empty', 'foreign', 'secret', 'secret-broken'];

	const { status, stdout, requests, summary } = run(t, {
		event: { issue: report, comment: comment(`/fix ${names.map((n) => `ljharb/${n}`).join(' ')}\nplease`) },
		github: {
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			installationRepos: {
				1: names.map((n) => installedRepo('ljharb', n, { private: n.startsWith('secret') })),
			},
			repos: {
				'ljharb/new': repo({ workflows: null, config: '{ "workflows": { "node-twenties.yml": true } }' }),
				'ljharb/existing': repo({ workflows: drifted }),
				// the default branch has been fixed since it was read
				'ljharb/current': repo({ workflows: replacing('rebase.yml', 'nope\n') }),
				'ljharb/clean': repo(),
				'ljharb/empty': repo({ workflows: null, defaultBranch: null }),
				'ljharb/foreign': repo({ workflows: replacing('rebase.yml', 'nope\n') }),
				'ljharb/secret': repo({ workflows: null, isPrivate: true }),
				// not on the git server at all
				'ljharb/secret-broken': repo({ workflows: null, isPrivate: true }),
			},
		},
		commands: {
			permissions: { maintainer: 'write' },
			serverURL: remotes.serverURL,
			pulls: {
				'ljharb/existing': [{
					number: 3, state: 'open', merged_at: null, head: { sha: earlier }, // eslint-disable-line camelcase
				}],
			},
		},
		env: { GITHUB_SERVER_URL: remotes.serverURL },
	});

	t.equal(status, 1, 'fails, since some repositories could not be fixed');
	t.match(stdout, /^::error::2 repositories could not be fixed$/m, 'saying how many');
	t.match(stdout, /^::warning::ljharb\/empty: the repository has no default branch$/m, 'warns about each failure');
	t.notOk(stdout.includes('secret') || stdout.includes('private repositor'), 'a private repository a filter names is fixed too, but nothing is logged about it, nor about its failure');

	const all = ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'];
	t.deepEqual(changes(requests), [
		'PATCH /repos/ljharb/existing/pulls/3',
		'POST /repos/ljharb/new/pulls',
		'POST /repos/ljharb/secret/pulls',
	], 'updates the existing PR, and creates the others, a private one’s last; nothing else');
	t.equal(remotes.show('ljharb/secret', 'fleet/workflows', '.github/workflows/rebase.yml'), template('rebase.yml'), 'the private one is fixed from its template too');

	const created = matching(requests, 'POST', /^\/repos\/ljharb\/new\/pulls$/)[0];
	t.equal(created.authorization, 'token ghs_installation_1', 'with the installation’s token');
	t.deepEqual({ ...created.body, body: undefined }, {
		base: 'main', head: 'fleet/workflows', title, body: undefined,
	}, 'from `fleet/workflows`, into the default branch, titled');
	t.equal(created.body.body, [
		`This makes these workflow files match the templates in [\`ljharb/actions\`’s \`fleet/drift/templates\`](${remotes.serverURL}/ljharb/actions/tree/HEAD/fleet/drift/templates), as asked in [this comment](${commentURL}):`,
		'',
		...all.map((name) => `- \`.github/workflows/${name}\`: added, since it’s missing`),
		'',
		'These are left as they are:',
		'',
		'- `.github/workflows/node-twenties.yml`: ``there is no valid `engines.node` in `package.json` to derive its node version range from``',
	].join('\n'), 'with a body listing each change and why, and what it left alone, linking the comment');
	t.deepEqual(remotes.log('ljharb/new', 'main..fleet/workflows'), [`${bot.name} <${bot.email}>|${bot.name} <${bot.email}>|${message}`], 'one commit, by the bot');
	for (const name of all) {
		t.equal(remotes.show('ljharb/new', 'fleet/workflows', `.github/workflows/${name}`), template(name), `\`${name}\` is written from its template`);
	}

	const updated = matching(requests, 'PATCH', /^\/repos\/ljharb\/existing\/pulls\/3$/)[0];
	t.equal(updated.body.title, title, 'the existing PR is retitled');
	t.ok(updated.body.body.includes('- `.github/workflows/node-pretest.yml`: rewritten from its template, since it has drifted\n- `.github/workflows/rebase.yml`: rewritten'), 'and its body lists every file');
	t.deepEqual(remotes.log('ljharb/existing', 'main..fleet/workflows'), [
		`${bot.name} <${bot.email}>|${bot.name} <${bot.email}>|${message}`,
		`${bot.name} <${bot.email}>|${bot.name} <${bot.email}>|change`,
	], 'the branch gets a commit on top of what it had');
	t.equal(remotes.show('ljharb/existing', 'fleet/workflows', '.github/workflows/node-pretest.yml'), template('node-pretest.yml'), 'fixing the rest');

	t.equal(remotes.tip('ljharb/current', 'refs/heads/fleet/workflows'), '', 'nothing is pushed when the default branch already matches');
	t.equal(remotes.tip('ljharb/foreign', 'refs/heads/fleet/workflows'), foreign, 'a branch with someone else’s changes is left as it is');
	t.equal(remotes.show('ljharb/foreign', 'fleet/workflows', '.github/workflows/rebase.yml'), 'nope\n', 'unfixed');

	const tokens = matching(requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).filter((r) => r.body?.repositories);
	t.deepEqual(tokens.map((r) => r.body), ['current', 'existing', 'foreign', 'new', 'secret', 'secret-broken'].map((name) => ({
		repositories: [name],
		permissions: {
			contents: 'write',
			pull_requests: 'write', // eslint-disable-line camelcase
			workflows: 'write',
		},
	})), 'each with its own token, for only that repository, that can push workflow files and open PRs');
	t.equal(matching(requests, 'GET', /^\/app$/).length, 1, 'the bot user is looked up once per installation');

	const [reply] = replies(requests);
	const rows = reply.split('\n').filter((line) => line.startsWith('| `'));
	t.deepEqual(rows.map((r) => r.split(' | ')[0]), ['| `ljharb/clean`', '| `ljharb/current`', '| `ljharb/empty`', '| `ljharb/existing`', '| `ljharb/foreign`', '| `ljharb/new`'], 'a row for each public repository, by name');
	t.deepEqual(rows.slice(0, 4), [
		'| `ljharb/clean` | nothing to fix |',
		'| `ljharb/current` | nothing to fix: `main` already matches |',
		'| `ljharb/empty` | failed: `the repository has no default branch` |',
		`| \`ljharb/existing\` | updated ${remotes.serverURL}/ljharb/existing/pull/3 |`,
	], 'saying what happened to each');
	t.match(rows[4], /^\| `ljharb\/foreign` \| failed: `.*refusing to push.*` \|$/, 'including why one failed');
	t.equal(rows[5], `| \`ljharb/new\` | created ${remotes.serverURL}/ljharb/new/pull/1<br>left as it is: \`.github/workflows/node-twenties.yml\`: \`\`there is no valid \`engines.node\` in \`package.json\` to derive its node version range from\`\` |`, 'and what it left alone');
	t.notOk(rows.some((r) => r.includes('secret')), 'and not one for a private repository');
	t.ok(reply.endsWith(`\n\n${privateNote(false)}`), 'which only ends by saying that any private repositories matching were processed too');
	t.ok(reply.startsWith(`\`/fix ${names.map((n) => `ljharb/${n}`).join(' ')}\` (from each repository’s \`fleet/workflows\` branch;`), 'quoting only the command’s line');
	t.equal(summary, reply, 'the run summary has the same');

	t.end();
});

test('fleet/commands: a private repository’s outcome is never output, and is after every public one', (t) => {
	const remotes = makeRemotes(t, {
		'ljharb/alpha': {},
		'ljharb/zulu': {},
		'ljharb/gamma-secret': {},
		'ljharb/mid-secret': {},
	});
	// someone else's commit on its `fleet/workflows` branch, whose files a refusal would list
	remotes.commit('ljharb/mid-secret', 'fleet/workflows', { 'docs/acquisition-plan.md': 'shh\n' }, { who: mallory, from: 'main' });
	const names = ['alpha', 'beta-secret', 'empty', 'gamma-secret', 'mid-secret', 'zulu'];

	const {
		status, stdout, stderr, requests, summary,
	} = run(t, {
		event: { issue: report, comment: comment('/fix ljharb') },
		github: {
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			installationRepos: { 1: names.map((n) => installedRepo('ljharb', n, { private: n.endsWith('-secret') })) },
			repos: {
				'ljharb/alpha': repo({ workflows: null }),
				// not on the git server at all, so cloning it fails
				'ljharb/beta-secret': repo({ workflows: null, isPrivate: true, defaultBranch: 'release-secret' }),
				'ljharb/empty': repo({ workflows: null, defaultBranch: null }),
				'ljharb/gamma-secret': repo({ workflows: null, isPrivate: true }),
				'ljharb/mid-secret': repo({ workflows: null, isPrivate: true }),
				'ljharb/zulu': repo({ workflows: null }),
			},
		},
		commands: { permissions: { maintainer: 'write' }, serverURL: remotes.serverURL },
		env: { GITHUB_SERVER_URL: remotes.serverURL },
	});

	t.equal(status, 1, 'fails, since a public repository could not be fixed');
	t.match(stdout, /^::error::1 repository could not be fixed$/m, 'not counting the private ones that failed');
	t.deepEqual(stdout.split('\n').filter((l) => (/^::(?:warning|error|notice)/).test(l)), [
		'::warning::ljharb/empty: the repository has no default branch',
		'::error::1 repository could not be fixed',
	], 'warns about each public failure, and nothing about the private ones');

	const tokens = matching(requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).filter((r) => r.body?.repositories);
	t.deepEqual(tokens.map((r) => r.body.repositories[0]), ['alpha', 'zulu', 'beta-secret', 'gamma-secret', 'mid-secret'], 'every public repository is fixed before any private one');
	t.deepEqual(changes(requests), ['POST /repos/ljharb/alpha/pulls', 'POST /repos/ljharb/zulu/pulls', 'POST /repos/ljharb/gamma-secret/pulls'], 'a private repository is still fixed');

	const [reply] = replies(requests);
	const secrets = ['secret', 'acquisition', 'release-', 'git clone', 'does not exist', 'someone else', 'private repositor', '2 of'];
	for (const [where, text] of [['the log', stdout], ['stderr', stderr], ['the summary', summary], ['the reply', reply]]) {
		t.deepEqual(secrets.filter((secret) => text.includes(secret)), [], `${where} reveals nothing about a private repository`);
	}
	t.deepEqual(reply.split('\n').filter((l) => l.startsWith('| `')), [
		`| \`ljharb/alpha\` | created ${remotes.serverURL}/ljharb/alpha/pull/1 |`,
		'| `ljharb/empty` | failed: `the repository has no default branch` |',
		`| \`ljharb/zulu\` | created ${remotes.serverURL}/ljharb/zulu/pull/1 |`,
	], 'the reply lists only the public repositories');
	t.ok(reply.endsWith(`\n\n${privateNote(false)}`), 'and ends by saying only that any private repositories matching were processed too');
	t.end();
});

test('fleet/commands: never writes through a symbolic link', (t) => {
	const outside = tempDir(t, 'fleet-commands-outside');
	const victim = path.join(outside, 'rebase.yml');
	writeFileSync(victim, 'untouched\n');
	const remotes = makeRemotes(t, { 'ljharb/file': files(standardWorkflows()), 'ljharb/dir': {} });
	remotes.commit('ljharb/file', 'main', {}, { links: { '.github/workflows/rebase.yml': victim } });
	remotes.commit('ljharb/dir', 'main', {}, { links: { '.github': outside } });

	const { status, stdout, requests } = run(t, {
		event: { issue: report, comment: comment('/fix ljharb/file ljharb/dir') },
		github: {
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			installationRepos: { 1: [installedRepo('ljharb', 'dir'), installedRepo('ljharb', 'file')] },
			repos: {
				// GitHub reads a link as a file whose text is where it points
				'ljharb/file': repo({ workflows: replacing('rebase.yml', victim) }),
				'ljharb/dir': repo({ workflows: null }),
			},
		},
		commands: { permissions: { maintainer: 'write' }, serverURL: remotes.serverURL },
		env: { GITHUB_SERVER_URL: remotes.serverURL },
	});

	t.equal(status, 1, 'fails, since one repository could not be fixed');
	t.match(stdout, /^::warning::ljharb\/dir: `\.github` is a symbolic link, so nothing is written through it$/m, 'refusing to write through a linked directory');
	t.equal(readFileSync(victim, 'utf8'), 'untouched\n', 'nothing outside the clone is written to');
	t.deepEqual(readdirSync(outside), ['rebase.yml'], 'or added');
	const [body] = replies(requests);
	t.ok(body.includes(`| \`ljharb/file\` | created ${remotes.serverURL}/ljharb/file/pull/1 |`), 'a linked file is fixed');
	t.equal(remotes.show('ljharb/file', 'fleet/workflows', '.github/workflows/rebase.yml'), template('rebase.yml'), 'by replacing the link with a regular file');
	t.ok(body.includes('| `ljharb/dir` | failed: '), 'and a linked directory fails its repository');

	t.end();
});

test('fleet/commands: a reply too long for a comment goes on in more, splitting only between rows', (t) => {
	const names = Array.from({ length: 400 }, (_, i) => `${'a-rather-long-repository-name-'.repeat(5)}${String(i).padStart(3, '0')}`);
	const { status, stdout, requests, summary } = run(t, {
		event: { issue: report, comment: comment('/dry-run fix ljharb') },
		github: {
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			// none of them can be read, so each fails
			installationRepos: { 1: names.map((n) => installedRepo('ljharb', n)) },
		},
	});

	t.equal(status, 1, 'fails, since no repository could be checked');
	t.match(stdout, /^::error::400 repositories could not be fixed$/m, 'saying how many');
	const bodies = replies(requests);
	t.ok(bodies.length > 1, `the reply is in several comments (${bodies.length})`);
	bodies.forEach((body, i) => {
		t.ok(body.length <= 60000, `comment ${i + 1} (${body.length} characters) fits`);
		t.equal(body.startsWith(`_continued (${i + 1}/${bodies.length})_\n\n| Repository | Outcome |\n| --- | --- |\n| \`ljharb/`), i > 0, `comment ${i + 1} continues the table, with its header, only if it isn’t the first`);
		t.equal(body.endsWith(`\n\n_continued below (${i + 2}/${bodies.length})_`), i < bodies.length - 1, `comment ${i + 1} says the reply continues, unless it’s the last`);
	});
	const rows = bodies.flatMap((body) => body.split('\n').filter((l) => l.startsWith('| `ljharb/')));
	t.deepEqual(rows, names.map((n) => `| \`ljharb/${n}\` | failed: \`could not read the repository’s state\` |`), 'every row is in one of them, whole, in order, saying why it failed');
	t.ok(bodies[0].startsWith('`/dry-run fix ljharb` (a dry run, so nothing was changed; see [the run](https://github.com/ljharb/actions/actions/runs/42)):\n\n| Repository | Outcome |'), 'the first starts the reply');
	t.ok(bodies.at(-1)?.endsWith(`\n\n${privateNote(true)}`), 'and the last ends it, saying that any private repositories matching were processed too');
	t.equal(summary, bodies.join('\n\n---\n\n'), 'the run summary has every comment');
	for (const body of [...bodies, summary]) {
		t.notOk((/omitted|more repositories|…/).test(body), 'nothing is left out');
	}

	t.end();
});

test('fleet/commands: a reply too long for a run summary has as much of it as fits, and says where the rest is', (t) => {
	const line = `/dry-run fix ${'ljharb '.repeat(160000)}`.trim();
	const { status, stdout, requests, summary } = run(t, { event: { issue: report, comment: comment(line) } });
	t.equal(status, 0, 'exits successfully');
	const bodies = replies(requests);
	t.ok(bodies.length > 20, `the reply is in many comments (${bodies.length})`);
	bodies.forEach((body, i) => t.ok(body.length <= 60000, `comment ${i + 1} fits`));
	const sources = bodies.flatMap((body) => body.match(/\n\n(?<ticks>`{3,})\n(?<source>[^]*)\n\k<ticks>(?:\n|$)/)?.groups?.source ?? []);
	t.equal(sources.join(''), `\`${line}\` (a dry run, so nothing was changed; see [the run](https://github.com/ljharb/actions/actions/runs/42)):`, 'quoting the whole command, in pieces');
	t.ok(bodies.at(-1)?.endsWith(`No repository matches those filters.\n\n${privateNote(true)}`), 'and the last comment ends the reply');

	t.ok(Buffer.byteLength(summary) <= 1000000, `the run summary (${Buffer.byteLength(summary)} bytes) fits in 1 MiB`);
	const inSummary = summary.split('\n\n---\n\n');
	const rest = inSummary.pop();
	t.ok(inSummary.length > 1 && inSummary.length < bodies.length, `it has the first ${inSummary.length} comments`);
	t.deepEqual(inSummary, bodies.slice(0, inSummary.length), 'each as it is in the reply');
	const links = bodies.slice(inSummary.length).map((_, i) => `[${inSummary.length + i + 1}](https://github.com/ljharb/actions/issues/9#issuecomment-${inSummary.length + i + 1})`);
	t.equal(rest, `The rest of the reply (from part ${inSummary.length + 1} of ${bodies.length}) doesn’t fit in this run summary (GitHub’s limit for one is 1 MiB); it’s in its comments on the issue: ${links.join(', ')}.`, 'then where the rest is');
	t.notOk(stdout.includes('ljharb ljharb'), 'the log never repeats the command, which could name a private repository');

	t.end();
});

test('fleet/commands: a reply that fails partway is still in the run summary, as far as it has room', (t) => {
	const line = `/dry-run fix ${'ljharb '.repeat(160000)}`.trim();
	const { status, stdout, requests, summary } = run(t, {
		event: { issue: report, comment: comment(line) },
		github: { commentErrorAfter: 2 },
	});
	t.equal(status, 1, 'fails');
	t.match(stdout, /^::error::.*comment failed/m, 'with the error');
	const attempted = requests.filter((r) => r.method === 'POST' && (/\/issues\/9\/comments$/).test(r.path)).map((r) => String(r.body.body));
	t.equal(attempted.length, 3, 'having posted two comments, and failed on the third');
	const inSummary = summary.split('\n\n---\n\n');
	const rest = inSummary.pop();
	t.deepEqual(inSummary.slice(0, 3), attempted, 'the run summary has the comments, posted or not, as far as it has room');
	t.match(String(rest), /^The rest of the reply \(from part \d+ of \d+\) doesn’t fit in this run summary \(GitHub’s limit for one is 1 MiB\), and \d+ of its parts could not be posted \(this job’s log has the error\): run the command again to see them\.$/, 'and says the rest could not be posted');

	// failing on the last comment, after the ones the run summary has no room for were posted
	const total = replies(run(t, { event: { issue: report, comment: comment(line) } }).requests).length;
	const late = run(t, {
		event: { issue: report, comment: comment(line) },
		github: { commentErrorAfter: total - 1 },
	});
	t.equal(late.status, 1, 'failing on the last comment fails too');
	const lateRest = late.summary.split('\n\n---\n\n').pop();
	t.match(String(lateRest), new RegExp(`^The rest of the reply \\(from part (\\d+) of ${total}\\) doesn’t fit in this run summary \\(GitHub’s limit for one is 1 MiB\\); it’s in its comments on the issue: (?:\\[\\d+\\]\\(https://github\\.com/ljharb/actions/issues/9#issuecomment-\\d+\\)(?:, )?)+, but 1 of its parts could not be posted \\(this job’s log has the error\\): run the command again to see them\\.$`), 'linking the ones that were posted, and saying the last could not be');

	t.end();
});

test('fleet/commands: an error that isn’t an `Error`, and the system temp directory', (t) => {
	const unexpected = [...standardWorkflows(), { name: 'node.yml', text: nodeWorkflow() }, { name: 'node-tens.yml', text: nodeWorkflow() }];
	const remotes = makeRemotes(t, { 'ljharb/conflict': {}, 'ljharb/plain': {}, 'ljharb/unexpected': files(unexpected) });
	// the branch and the default branch have each added `rebase.yml` since the default branch was read
	remotes.commit('ljharb/conflict', 'fleet/workflows', { '.github/workflows/rebase.yml': 'bot\n' }, { who: bot, from: 'main' });
	remotes.commit('ljharb/conflict', 'main', { '.github/workflows/rebase.yml': 'other\n' });

	const { status, stdout, requests } = run(t, {
		event: { issue: report, comment: comment('/fix ljharb') },
		github: {
			installations: [{ id: 1, account: { login: 'ljharb' } }],
			installationRepos: { 1: [installedRepo('ljharb', 'conflict'), installedRepo('ljharb', 'plain'), installedRepo('ljharb', 'unexpected')] },
			repos: {
				'ljharb/conflict': repo({ workflows: null }),
				'ljharb/plain': repo({ workflows: null }),
				// `engines.node` needs only `node.yml`
				'ljharb/unexpected': repo({ packageJson: '{ "engines": { "node": "^20" } }', workflows: unexpected }),
			},
		},
		commands: { permissions: { maintainer: 'write' }, serverURL: remotes.serverURL },
		env: { GITHUB_SERVER_URL: remotes.serverURL, RUNNER_TEMP: '' },
		// listing the conflicted files throws a string
		throwStringOnSplit: '.github/workflows/rebase.yml\0',
		versions: true,
	});

	t.equal(status, 1, 'fails');
	t.match(stdout, /^::error::1 repository could not be fixed$/m, 'saying how many, in the singular');
	t.match(stdout, /^::warning::ljharb\/conflict: \.github\/workflows\/rebase\.yml/m, 'logs the thrown value');
	const [body] = replies(requests);
	t.ok(body.includes('| `ljharb/conflict` | failed: `.github/workflows/rebase.yml'), 'and replies with it');
	t.ok(body.includes(`| \`ljharb/plain\` | created ${remotes.serverURL}/ljharb/plain/pull/1 |`), 'carrying on with the next repository, cloned into the system’s temp directory without `RUNNER_TEMP`');
	t.equal(remotes.show('ljharb/plain', 'fleet/workflows', '.github/workflows/rebase.yml'), template('rebase.yml'), 'and pushed');
	t.ok(body.includes(`| \`ljharb/unexpected\` | created ${remotes.serverURL}/ljharb/unexpected/pull/1 |`), 'and the next');
	t.equal(remotes.show('ljharb/unexpected', 'fleet/workflows', '.github/workflows/node-tens.yml'), null, 'deleting an unexpected file');
	t.equal(remotes.show('ljharb/unexpected', 'fleet/workflows', '.github/workflows/node.yml'), nodeWorkflow(), 'and leaving the rest');

	t.end();
});

test('fleet/commands: failures', (t) => {
	const noEvent = run(t, { event: {}, env: { GITHUB_EVENT_PATH: '' } });
	t.equal(noEvent.status, 1, 'no event fails');
	t.match(noEvent.stdout, /^::error::Error: ENOENT/m, 'with the error');

	const thrown = run(t, {
		event: { issue: report, comment: comment('/fix ljharb') },
		env: { GITHUB_REPOSITORY: 'fleet-test-throw' },
		throwStringOnSplit: 'fleet-test-throw',
	});
	t.equal(thrown.status, 1, 'a thrown non-Error fails');
	t.match(thrown.stdout, /^::error::fleet-test-throw$/m, 'with the stringified value');

	const noToken = run(t, { event: { issue: report, comment: comment('/fix ljharb') }, env: { INPUT_TOKEN: '' } });
	t.equal(noToken.status, 1, 'a missing token fails');
	t.match(noToken.stdout, /^::error::Error: Input required and not supplied: token$/m, 'with the error');
	t.deepEqual(noToken.requests, [], 'before any request');

	t.end();
});
