import path from 'path';

import test from 'tape';

import { marker } from '../../../fleet/readme/marker.mjs';
import {
	definitions,
	headingFor,
	npmBadge,
	standardBadges,
} from '../../../fleet/readme/readme.mjs';
import { installedRepo, privateKey } from '../lib/helpers/github.mjs';
import { runChild } from '../drift/helpers/child.mjs';
import { standardWorkflows } from '../drift/helpers/states.mjs';

/** @import { Scenario, RepoSpec, Recorded } from '../lib/helpers/github.mjs' */
/** @import { ChildResult } from '../drift/helpers/child.mjs' */
/** @import { ChildScenario } from '../drift/helpers/preload.mjs' */
/** @import { Test } from 'tape' */

const script = path.join('fleet', 'readme', 'index.mjs');
const bot = { login: 'fleet-bot[bot]' };
const lookupError = '<code>whether its package is on npm could not be told</code>';

/**
 * A README that already matches the fleet's, for the package `name` in `ljharb/name`; or, `drifted`, one whose heading has no version badge.
 * @type {(name: string, drifted?: boolean) => string}
 */
function readme(name, drifted = false) {
	const identity = { name, repository: `ljharb/${name}`, branch: 'main' };
	return [
		drifted ? `# ${name}` : headingFor(name),
		'',
	].concat(
		standardBadges,
		'',
		npmBadge,
		'',
		'Some prose about the package.',
		'',
		definitions(identity).map(([label, url]) => `[${label}]: ${url}`),
		'',
	).join('\n');
}

/**
 * The repository's state, as GitHub's GraphQL API gives it: a package named as the repository is, with `README.md` as `readme` makes it.
 * @type {(name: string, options?: { drifted?: boolean, isPrivate?: boolean }) => RepoSpec}
 */
function repo(name, { drifted = false, isPrivate = false } = {}) {
	const data = {
		isArchived: false,
		isPrivate,
		defaultBranchRef: { name: 'main' },
		config: null,
		packageJson: { text: JSON.stringify({ name, version: '1.0.0' }) },
		root: {
			entries: [
				{ name: 'package.json', mode: 0o100644 },
				{ name: 'README.md', mode: 0o100644 },
			],
		},
		workflows: { entries: standardWorkflows().map(({ name: file, text }) => ({ name: file, type: 'blob', object: { text } })) },
	};
	// as the query reads it, which the helper's `RepositoryData` doesn't list
	return { data: Object.assign(data, { readme: { text: readme(name, drifted), isTruncated: false } }) };
}

/** @type {(github: Scenario, options?: { env?: Record<string, string>, extra?: ChildScenario }) => ChildResult} */
function run(github, { env = {}, extra = {} } = {}) {
	return runChild([script], {
		scenario: { github, ...extra },
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

// the full report, as written to its gist
/** @type {(t: Test, requests: Recorded[]) => string} */
function gistContent(t, requests) {
	const writes = gistWrites(requests);
	t.equal(writes.length, 1, 'writes the gist once');
	return String(writes[0]?.body.files['readme-drift.md'].content);
}

/** @type {(requests: Recorded[]) => Recorded[]} */
function issueWrites(requests) {
	return requests.filter((r) => r.method !== 'GET' && (/^\/repos\//).test(r.path));
}

const names = [
	'clean',
	'drifted',
	'empty',
	'failing',
	'secret',
	'unpublished',
];

/** @type {Scenario} */
const github = {
	installations: [
		{ id: 1, account: { login: 'ljharb' } },
		{ id: 2, account: { login: 'stranger' } },
	],
	installationRepos: { 1: names.map((n) => installedRepo('ljharb', n, { private: n === 'secret' })) },
	repos: Object.fromEntries(names.map((n) => [
		`ljharb/${n}`,
		repo(n, {
			drifted: n !== 'clean',
			isPrivate: n === 'secret',
		}),
	])),
	issues: [],
};

// `ljharb/secret`'s lookup fails too, so that it's only counted
const npm = {
	empty: { versions: {} },
	failing: 403,
	secret: 403,
	unpublished: 404,
};

test('fleet/readme: leaves out a repository whose package isn’t on npm, and reports one whose package couldn’t be looked up, without the registry’s error', (t) => {
	const {
		status,
		stdout,
		stderr,
		requests,
		summary,
	} = run(github, { env: { GITHUB_REPOSITORY_OWNER: 'ljharb' }, extra: { npm } });

	t.equal(status, 0, 'exits successfully');
	t.equal(stderr, '', 'nothing on stderr');
	t.match(stdout, /^::warning::installation 2: its account is not in the allowed accounts; skipped$/m, 'warns about each failure');
	t.match(stdout, /^3 of 4 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; created https:\/\/github\.com\/created\/1$/m, 'counting neither an unpublished package’s repository, nor one with no versions');

	const [created] = issueWrites(requests);
	t.equal(created?.body.title, 'README drift: 3 of 4 repositories', 'the issue’s title counts the same');
	const body = String(created?.body.body);
	t.ok(body.includes('checked the README file name, heading, badges, and their link definitions of 4 repositories that publish a package'), 'as does its summary');
	t.ok(body.includes('3 have discrepancies (1 of them private, so not listed)'), 'with the private one only counted');

	const full = gistContent(t, requests);
	t.ok(full.includes('<code>ljharb/drifted</code>'), 'the full report lists a drifted repository whose package is on npm');
	t.ok(full.includes(`<code>ljharb/failing</code></a></td><td>\n\n</td><td>\n\n</td><td>\n${lookupError}\n</td></tr>`), 'and one whose package couldn’t be looked up, with that as its only error');
	t.notOk(full.includes('ljharb/clean'), 'not one that matches');
	t.notOk(full.includes('ljharb/unpublished') || full.includes('ljharb/empty'), 'nor one whose package isn’t on npm');
	[['the log', stdout], ['the summary', summary], ['the issue', body], ['the gist', full]].forEach(([where, text]) => {
		t.notOk(text.includes('ljharb/secret') || text.includes('registry error') || text.includes('403'), `${where} has neither a private repository, nor the registry’s error`);
	});

	t.end();
});

test('fleet/readme: an existing report is updated, and swept; with no discrepancies, it’s closed', (t) => {
	const issue = {
		number: 10,
		user: bot,
		state: 'open',
		body: marker,
		created_at: '2026-10-01T00:00:00Z', // eslint-disable-line camelcase
		html_url: 'https://github.com/ljharb/actions/issues/10', // eslint-disable-line camelcase
	};
	const updated = run({ ...github, issues: [issue] }, { extra: { npm, report: { comments: [] } } });
	t.equal(updated.status, 0, 'exits successfully');
	t.match(updated.stdout, /^3 of 4 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; updated https:\/\/github\.com\/ljharb\/actions\/issues\/10$/m, 'updating the report');
	t.ok(updated.requests.some((r) => r.method === 'GET' && (/^\/repos\/ljharb\/actions\/issues\/10\/comments\?/).test(r.path)), 'and sweeping it');

	const none = run({ installations: [], issues: [issue] }, { extra: { report: { comments: [] } } });
	t.equal(none.status, 0, 'exits successfully');
	t.match(none.stdout, /^0 of 0 repositories have discrepancies; the full report is https:\/\/gist\.github\.com\/new-gist; closed https:\/\/github\.com\/ljharb\/actions\/issues\/10$/m, 'closing the report when nothing was checked, and nothing failed');
	t.equal(none.summary, 'No discrepancies.', 'the run summary says so');

	t.end();
});

test('fleet/readme: failures', (t) => {
	const noGist = run({}, { env: { 'INPUT_GIST-TOKEN': '' } });
	t.equal(noGist.status, 1, 'a missing gist token fails');
	t.match(noGist.stdout, /^::error::`gist-token` is required/m, 'saying so');
	t.deepEqual(noGist.requests, [], 'before any request, so nothing is wasted');

	const missing = run({}, { env: { 'INPUT_APP-ID': '' } });
	t.equal(missing.status, 1, 'a missing required input fails');
	t.match(missing.stdout, /^::error::Error: Input required and not supplied: app-id$/m, 'with the error');

	const thrown = run({}, { env: { INPUT_ACCOUNTS: 'fleet-test-throw' }, extra: { throwStringOnSplit: 'fleet-test-throw' } });
	t.equal(thrown.status, 1, 'a thrown non-Error fails');
	t.match(thrown.stdout, /^::error::fleet-test-throw$/m, 'with the stringified value');

	const gist = run({ ...github, gistError: { status: 403, body: { message: 'Resource not accessible by personal access token' } } }, { extra: { npm } });
	t.equal(gist.status, 1, 'failing to write the gist fails');
	t.match(gist.stdout, /^::error::the full report could not be written to its gist: HttpError: Resource not accessible by personal access token/m, 'with the error');
	t.match(gist.stdout, /^3 of 4 repositories have discrepancies; the full report could not be written to its gist; created /m, 'logging the outcome');

	t.end();
});
