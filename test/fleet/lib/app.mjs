import nock from 'nock';
import test from 'tape';

import {
	appAuth,
	appOctokit,
	discover,
	installationToken,
	parseAccounts,
} from '../../../fleet/lib/app.mjs';
import { installedRepo, mockGitHub, privateKey } from './helpers/github.mjs';

/** @typedef {import('./helpers/github.mjs').Recorded} Recorded */
/** @typedef {import('./helpers/github.mjs').Scenario} Scenario */
/** @typedef {import('../../../fleet/lib/app.mjs').RepoState} RepoState */

/** @type {(t: import('tape').Test, scenario: Scenario) => Recorded[]} */
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

/** @type {(requests: Recorded[]) => Recorded[]} */
function graphqlRequests(requests) {
	return requests.filter((r) => r.path === '/graphql');
}

// queries for repositories' states, as opposed to an account's defaults
/** @type {(requests: Recorded[]) => Recorded[]} */
function repoQueries(requests) {
	return graphqlRequests(requests).filter((r) => 'o0' in r.body.variables);
}

/** @type {(requests: Recorded[]) => Recorded[]} */
function accountQueries(requests) {
	return graphqlRequests(requests).filter((r) => 'owner' in r.body.variables);
}

/** @type {(r: Recorded) => string[]} */
function queriedRepos(r) {
	/** @type {Record<string, string>} */
	const variables = r.body.variables; // eslint-disable-line prefer-destructuring
	/** @type {string[]} */
	const names = [];
	for (let j = 0; `o${j}` in variables; j += 1) {
		names.push(`${variables[`o${j}`]}/${variables[`n${j}`]}`);
	}
	return names;
}

/** @type {(states: RepoState[], repository: string) => RepoState} */
function find(states, repository) {
	const state = states.find((s) => s.repository === repository);
	if (!state) {
		throw new Error(`no state for ${repository}`);
	}
	return state;
}

test('parseAccounts', (t) => {
	t.deepEqual([...parseAccounts('ljharb  es-shims,Inspect-JS\n,, ', 'fallback')], ['ljharb', 'es-shims', 'inspect-js'], 'splits on whitespace and commas, lowercasing');
	t.deepEqual([...parseAccounts('', 'LJHarb')], ['ljharb'], 'falls back to the (lowercased) fallback when empty');
	t.deepEqual([...parseAccounts(' , ', 'x')], ['x'], 'falls back when only separators');
	t.deepEqual([...parseAccounts('a a A', 'x')], ['a'], 'deduplicates');
	t.deepEqual([...parseAccounts('', '')], [], 'empty when both the list and the fallback are empty');
	t.deepEqual([...parseAccounts(' , ', '')], [], 'empty when the list is only separators and the fallback is empty');

	t.end();
});

test('installationToken', async (t) => {
	/** @type {unknown[]} */
	const calls = [];
	const auth = /** @type {ReturnType<typeof appAuth>} */ (/** @type {unknown} */ (async (/** @type {unknown} */ options) => { // eslint-disable-line no-extra-parens
		calls.push(options);
		return { token: `token-${calls.length}` };
	}));

	t.equal(await installationToken(auth, 7), 'token-1', 'returns the token');
	t.equal(await installationToken(auth, 8, { repositoryNames: ['a'], permissions: { contents: 'write' } }), 'token-2', 'returns the token, with options');
	t.deepEqual(calls, [
		{ type: 'installation', installationId: 7 },
		{
			type: 'installation', installationId: 8, repositoryNames: ['a'], permissions: { contents: 'write' },
		},
	], 'passes the installation and options through to auth');
});

test('appAuth + appOctokit: signs a JWT as the app', async (t) => {
	const requests = setup(t, { installations: [] });
	const auth = appAuth('12345', privateKey());

	const app = await appOctokit(auth);
	const { data } = await app.request('GET /app/installations');
	t.deepEqual(data, [], 'the octokit talks to the API');

	t.equal(requests.length, 1, 'one request');
	const [, jwt] = String(requests[0].authorization).split(' ');
	t.match(String(requests[0].authorization), /^bearer /i, 'authenticates with a bearer token');
	const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
	t.equal(payload.iss, '12345', 'the JWT is issued by the app id');
});

test('discover: no installations', async (t) => {
	const requests = setup(t, { installations: [] });
	const result = await discover(appAuth('1', privateKey()), new Set(['ljharb']));
	t.deepEqual(result, { states: [], failures: [] }, 'nothing found, nothing failed');
	t.deepEqual(requests.map((r) => r.path), ['/app/installations?per_page=100'], 'only lists installations');
});

test('discover: listing installations fails', async (t) => {
	setup(t, { installations: { status: 500, body: { message: 'boom' } } });
	try {
		await discover(appAuth('1', privateKey()), new Set(['ljharb']));
		t.fail('should have rejected');
	} catch (e) {
		t.ok(e instanceof Error, 'rejects with an Error');
		t.match(String(e && typeof e === 'object' && 'message' in e ? e.message : e), /boom/, 'with the API’s message');
	}
});

test('discover: filters installations by account', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 1, account: { login: 'LJHarb' } },
			{ id: 2, account: { login: 'stranger' } },
			{ id: 3, account: { slug: 'some-enterprise' } },
			{ id: 4, account: null },
			{ id: 5, account: { login: 'es-shims' }, suspended_at: '2026-01-01T00:00:00Z' }, // eslint-disable-line camelcase
		],
		installationRepos: { 1: [] },
	});
	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']));
	t.deepEqual(states, [], 'no repos');
	t.deepEqual(failures, [
		{ scope: 'installation 2', message: 'its account is not in the allowed accounts; skipped' },
		{ scope: 'installation 3', message: 'its account is not in the allowed accounts; skipped' },
		{ scope: 'installation 4', message: 'its account is not in the allowed accounts; skipped' },
	], 'disallowed accounts are reported; a suspended allowed installation is silently skipped');

	const tokenRequests = requests.filter((r) => r.path.endsWith('/access_tokens'));
	t.deepEqual(tokenRequests.map((r) => r.path), ['/app/installations/1/access_tokens'], 'only the allowed, unsuspended installation gets a token');
	t.deepEqual(tokenRequests[0].body, { permissions: { contents: 'read', metadata: 'read' } }, 'with read-only permissions');
	t.deepEqual(
		requests.filter((r) => r.path.startsWith('/installation/')).map((r) => r.authorization),
		['token ghs_installation_1'],
		'repositories are listed with the installation token',
	);
	t.equal(graphqlRequests(requests).length, 0, 'no GraphQL query for an installation with no repositories');
});

test('discover: repository states', async (t) => {
	const requests = setup(t, {
		installations: [{ id: 10, account: { login: 'ljharb' } }],
		installationRepos: {
			10: [
				installedRepo('ljharb', 'zed'),
				installedRepo('ljharb', 'full', { private: true }),
				installedRepo('ljharb', 'empty'),
				installedRepo('ljharb', 'gone'),
			],
		},
		repos: {
			'ljharb/full': {
				data: {
					isArchived: true,
					isPrivate: false,
					defaultBranchRef: { name: 'trunk' },
					config: { text: '{ "workflows": { "rebase.yml": false } }' },
					packageJson: { text: '{ "engines": { "node": ">= 4" } }' },
					workflows: {
						entries: [
							{ name: 'node.yml', type: 'blob', object: { text: 'name: node\n' } },
							{ name: 'subdir', type: 'tree', object: {} },
							{ name: 'big.yml', type: 'blob', object: null },
							{ name: 'binary.yml', type: 'blob', object: {} },
						],
					},
				},
			},
			'ljharb/zed': {
				data: {
					isArchived: false,
					isPrivate: true,
					defaultBranchRef: { name: 'main' },
					config: { text: 'not json' },
					packageJson: null,
					workflows: null,
				},
			},
			'ljharb/empty': {
				data: {
					isArchived: false,
					isPrivate: false,
					defaultBranchRef: null,
					config: null,
					packageJson: {},
					workflows: {},
				},
			},
			// `ljharb/gone` is unspecified, so the API reports it as not found: GraphQL partial data
		},
	});
	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']));

	t.deepEqual(failures, [], 'no failures: a missing repository is reported per-repo');
	t.deepEqual(states.map((s) => s.repository), ['ljharb/empty', 'ljharb/full', 'ljharb/gone', 'ljharb/zed'], 'sorted by repository');
	t.equal(repoQueries(requests).length, 1, 'one batched query, despite the partial error');
	t.equal(accountQueries(requests).length, 1, 'and one for the account’s defaults');
	t.equal(graphqlRequests(requests).length, 2, 'and no other queries');
	t.deepEqual(queriedRepos(repoQueries(requests)[0]), ['ljharb/zed', 'ljharb/full', 'ljharb/empty', 'ljharb/gone'], 'queries every repo in one batch');
	t.match(String(repoQueries(requests)[0].body.query), /HEAD:\.github\/ljharb-actions\.json/, 'queries the config file');

	const full = find(states, 'ljharb/full');
	t.equal(full.owner, 'ljharb', 'owner');
	t.equal(full.name, 'full', 'name');
	t.equal(full.installationId, 10, 'installationId');
	t.equal(full.private, true, 'private from the installation listing');
	t.equal(full.archived, true, 'archived');
	t.equal(full.defaultBranch, 'trunk', 'default branch');
	t.deepEqual({ ...full.config.workflows }, { 'rebase.yml': false }, 'parsed config');
	t.equal(full.configError, null, 'no config error');
	t.equal(full.stateError, null, 'no state error');
	t.equal(full.packageJson, '{ "engines": { "node": ">= 4" } }', 'package.json text');
	t.deepEqual(full.workflows, [
		{ name: 'node.yml', text: 'name: node\n' },
		{ name: 'big.yml', text: null },
		{ name: 'binary.yml', text: null },
	], 'only blobs; unreadable blobs have null text');

	const zed = find(states, 'ljharb/zed');
	t.equal(zed.private, true, 'private from GraphQL');
	t.equal(zed.archived, false, 'not archived');
	t.match(String(zed.configError), /is not valid JSON/, 'config error');
	t.deepEqual({ ...zed.config.workflows }, {}, 'default config on error');
	t.equal(zed.packageJson, null, 'no package.json');
	t.equal(zed.workflows, null, 'no workflows directory');

	const empty = find(states, 'ljharb/empty');
	t.equal(empty.private, false, 'public');
	t.equal(empty.defaultBranch, null, 'no default branch (an empty repo)');
	t.equal(empty.configError, null, 'no config, no error');
	t.equal(empty.packageJson, null, 'a non-blob package.json has no text');
	t.equal(empty.workflows, null, 'a non-tree workflows path has no entries');

	const gone = find(states, 'ljharb/gone');
	t.equal(gone.stateError, 'could not read the repository’s state', 'state error');
	t.equal(gone.private, false, 'private only per the installation listing');
	t.equal(gone.archived, false, 'not archived');
	t.equal(gone.defaultBranch, null, 'no default branch');
	t.equal(gone.workflows, null, 'no workflows');
	t.equal(gone.installationId, 10, 'installationId');
});

test('discover: batches of 20, one batch at a time, retrying a failed batch one repo at a time', async (t) => {
	const repos = Array.from({ length: 45 }, (_, i) => installedRepo('es-shims', `r${String(i).padStart(2, '0')}`));
	/** @type {Record<string, import('./helpers/github.mjs').RepoSpec>} */
	const specs = Object.fromEntries(repos.map((r) => [r.full_name, { data: { isArchived: false } }]));
	specs['es-shims/r25'] = { failInBatch: true, data: { isArchived: true } };
	specs['es-shims/r30'] = { failAlways: true };
	const requests = setup(t, {
		installations: [{ id: 20, account: { login: 'es-shims' } }],
		installationRepos: { 20: repos },
		repos: specs,
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['es-shims']));
	t.deepEqual(failures, [], 'no failures');
	t.equal(states.length, 45, 'every repository has a state');

	t.equal(accountQueries(requests).length, 1, 'the account’s defaults are queried once');
	const queries = repoQueries(requests).map(queriedRepos);
	t.deepEqual(queries[0], repos.slice(0, 20).map((r) => r.full_name), 'first batch: 20 repos');
	t.deepEqual(queries[1], repos.slice(20, 40).map((r) => r.full_name), 'second batch: 20 repos, which fails');
	t.deepEqual(
		queries.slice(2, 22).map((q) => q.length),
		Array(20).fill(1),
		'then each repo of the failed batch is queried alone',
	);
	t.deepEqual(queries.slice(2, 22).flat().sort(), repos.slice(20, 40).map((r) => r.full_name), 'covering exactly the failed batch');
	t.deepEqual(queries[22], repos.slice(40).map((r) => r.full_name), 'last batch: the remaining 5');
	t.equal(queries.length, 23, 'no other queries');

	t.equal(find(states, 'es-shims/r25').archived, true, 'a repo that only fails in a batch is recovered');
	t.equal(find(states, 'es-shims/r25').stateError, null, 'with no state error');
	t.equal(find(states, 'es-shims/r30').stateError, 'could not read the repository’s state', 'a repo that fails alone is lost');
	t.equal(states.filter((s) => s.stateError).length, 1, 'and only that one');
});

test('discover: GraphQL errors without usable partial data', async (t) => {
	const requests = setup(t, {
		installations: [{ id: 30, account: { login: 'ljharb' } }],
		installationRepos: {
			30: [
				installedRepo('ljharb', 'a'),
				installedRepo('ljharb', 'b'),
				installedRepo('ljharb', 'c'),
			],
		},
		repos: {
			'ljharb/a': { data: { defaultBranchRef: { name: 'main' } } },
			'ljharb/b': { data: { defaultBranchRef: { name: 'main' } } },
			'ljharb/c': { data: { defaultBranchRef: { name: 'main' } } },
		},
		graphqlNullData: ['ljharb/b'],
		graphqlStringData: ['ljharb/c'],
	});

	const { states } = await discover(appAuth('1', privateKey()), new Set(['ljharb']));
	t.equal(repoQueries(requests).length, 4, 'the batch fails, then each repo is retried alone');
	t.equal(find(states, 'ljharb/a').defaultBranch, 'main', 'a succeeds alone');
	t.equal(find(states, 'ljharb/b').stateError, 'could not read the repository’s state', 'null data is an error');
	t.equal(find(states, 'ljharb/c').stateError, 'could not read the repository’s state', 'non-object data is an error');
});

test('discover: a failing installation does not fail the others', async (t) => {
	setup(t, {
		installations: [
			{ id: 40, account: { login: 'ljharb' } },
			{ id: 41, account: { login: 'ljharb' } },
			{ id: 42, account: { login: 'ljharb' } },
		],
		tokens: { 41: { status: 403, body: { message: 'token denied' } } },
		installationRepos: {
			40: [installedRepo('ljharb', 'ok')],
			42: { status: 500, body: { message: 'listing failed' } },
		},
		repos: { 'ljharb/ok': { data: {} } },
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']));
	t.deepEqual(states.map((s) => s.repository), ['ljharb/ok'], 'the working installation’s repos are found');
	t.equal(failures.length, 2, 'two failures');
	t.deepEqual(failures.map((f) => f.scope).sort(), ['installation 41', 'installation 42'], 'one per failing installation');
	t.equal(failures.find((f) => f.scope === 'installation 41')?.message, 'could not be read (HTTP 403)', 'token failure message: only its status');
	t.equal(failures.find((f) => f.scope === 'installation 42')?.message, 'could not be read (HTTP 500)', 'listing failure message: only its status');
});

test('discover: a non-Error failure', async (t) => {
	setup(t, {
		installations: [{ id: 50, account: { login: 'ljharb' } }],
	});
	const real = appAuth('1', privateKey());
	const auth = /** @type {typeof real} */ (/** @type {unknown} */ (async (/** @type {{ type: string }} */ options) => { // eslint-disable-line no-extra-parens
		if (options.type === 'app') {
			return real({ type: 'app' });
		}
		throw 'no token for you'; // eslint-disable-line no-throw-literal
	}));

	const { states, failures } = await discover(auth, new Set(['ljharb']));
	t.deepEqual(states, [], 'no states');
	t.deepEqual(failures, [{ scope: 'installation 50', message: 'could not be read' }], 'the thrown value is never quoted');
});

/** @type {(workflows: RepoState['config']['workflows']) => false | Record<string, boolean>} */
function plain(workflows) {
	return workflows && { ...workflows };
}

test('discover: account defaults are fetched once per installation, and merged into every repository', async (t) => {
	const ljharbRepos = Array.from({ length: 22 }, (_, i) => installedRepo('ljharb', `r${String(i).padStart(2, '0')}`));
	const requests = setup(t, {
		installations: [
			{ id: 60, account: { login: 'ljharb' } },
			{ id: 61, account: { login: 'es-shims' } },
		],
		installationRepos: {
			60: ljharbRepos,
			61: [installedRepo('es-shims', 'shim'), installedRepo('es-shims', 'shim-own')],
		},
		accounts: {
			ljharb: { text: '{ "workflows": { "rebase.yml": false, "node.yml": true } }' },
			'es-shims': { text: '{ "workflows": false }' },
		},
		repos: {
			...Object.fromEntries(ljharbRepos.map((r) => [r.full_name, { data: {} }])),
			'ljharb/r01': { data: { config: { text: '{ "workflows": { "rebase.yml": true, "extra.yml": false } }' } } },
			'ljharb/r02': { data: { config: { text: '{ "workflows": false }' } } },
			'ljharb/r21': { data: { config: { text: '{ "workflows": true }' } } },
			'es-shims/shim': { data: {} },
			'es-shims/shim-own': { data: { config: { text: '{ "workflows": { "node.yml": true } }' } } },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']));
	t.deepEqual(failures, [], 'no failures');
	t.equal(states.length, 24, 'every repository has a state');

	const accounts = accountQueries(requests);
	t.deepEqual(accounts.map((r) => r.body.variables).sort((a, b) => a.owner.localeCompare(b.owner)), [{ owner: 'es-shims' }, { owner: 'ljharb' }], 'one defaults query per installation, for its account');
	t.match(String(accounts[0].body.query), /repository\(owner: \$owner, name: "\.github"\)/, 'reads the account’s `.github` repository');
	t.match(String(accounts[0].body.query), /HEAD:ljharb-actions\.json/, 'at its root `ljharb-actions.json`');
	t.equal(repoQueries(requests).length, 3, 'two batches for one installation, one for the other');

	const ljharbTokenized = requests.filter((r) => r.authorization === 'token ghs_installation_60');
	const firstRepoQuery = ljharbTokenized.findIndex((r) => r.path === '/graphql' && 'o0' in r.body.variables);
	const accountQuery = ljharbTokenized.findIndex((r) => r.path === '/graphql' && 'owner' in r.body.variables);
	const listing = ljharbTokenized.findIndex((r) => r.path.startsWith('/installation/repositories'));
	t.ok(listing < accountQuery && accountQuery < firstRepoQuery, 'with the installation’s token, after listing its repositories and before querying them');

	t.deepEqual(plain(find(states, 'ljharb/r00').config.workflows), { 'rebase.yml': false, 'node.yml': true }, 'a repository without its own file gets the account’s defaults');
	t.deepEqual(plain(find(states, 'ljharb/r20').config.workflows), { 'rebase.yml': false, 'node.yml': true }, 'including in a later batch');
	t.deepEqual(
		plain(find(states, 'ljharb/r01').config.workflows),
		{ 'rebase.yml': true, 'node.yml': true, 'extra.yml': false },
		'a repository’s own entries are merged over the account’s, winning',
	);
	t.equal(find(states, 'ljharb/r02').config.workflows, false, 'a repository’s own `false` wins');
	t.deepEqual(plain(find(states, 'ljharb/r21').config.workflows), { 'rebase.yml': false, 'node.yml': true }, 'a repository’s own `true` keeps the account’s entries');
	t.notEqual(find(states, 'ljharb/r00').config.workflows, find(states, 'ljharb/r03').config.workflows, 'each repository gets its own config object');
	t.ok(states.every((s) => s.configError === null), 'no config errors');

	t.equal(find(states, 'es-shims/shim').config.workflows, false, 'an account’s `false` opts out a repository without its own setting');
	t.deepEqual(plain(find(states, 'es-shims/shim-own').config.workflows), { 'node.yml': true }, 'a repository’s own object opts back in');
});

test('discover: an account without a readable `.github` repository has no defaults', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 70, account: { login: 'ljharb' } },
			{ id: 71, account: { login: 'es-shims' } },
		],
		installationRepos: {
			70: [installedRepo('ljharb', 'a')],
			71: [installedRepo('es-shims', 'b')],
		},
		// `ljharb/.github` is unspecified, so it is not found: GraphQL partial data
		accounts: { 'es-shims': { noFile: true } },
		repos: {
			'ljharb/a': { data: { config: { text: '{ "workflows": { "rebase.yml": false } }' } } },
			'es-shims/b': { data: {} },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']));
	t.deepEqual(failures, [], 'not a failure');
	t.equal(accountQueries(requests).length, 2, 'the defaults are queried for each account');
	t.deepEqual(plain(find(states, 'ljharb/a').config.workflows), { 'rebase.yml': false }, 'a missing `.github` repository: only the repository’s own config');
	t.equal(find(states, 'ljharb/a').configError, null, 'and no config error');
	t.deepEqual(plain(find(states, 'es-shims/b').config.workflows), {}, 'a `.github` repository without the file: the built-in defaults');
	t.equal(find(states, 'es-shims/b').configError, null, 'and no config error');
});

test('discover: an invalid account defaults file is a config error on every repository', async (t) => {
	setup(t, {
		installations: [
			{ id: 80, account: { login: 'ljharb' } },
			{ id: 81, account: { login: 'es-shims' } },
		],
		installationRepos: {
			80: [installedRepo('ljharb', 'plain'), installedRepo('ljharb', 'own-error'), installedRepo('ljharb', 'own-config')],
			81: [installedRepo('es-shims', 'shim')],
		},
		accounts: {
			ljharb: { text: '{ "token": "ghp_AccountSecret0123456789abcdef" nope' },
			'es-shims': { text: '{ "workflows": "all" }' },
		},
		repos: {
			'ljharb/plain': { data: {} },
			'ljharb/own-error': { data: { config: { text: '[]' } } },
			'ljharb/own-config': { data: { config: { text: '{ "workflows": { "rebase.yml": false } }' } } },
			'es-shims/shim': { data: { config: { text: '{ "workflows": 1 }' } } },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']));
	t.deepEqual(failures, [], 'not an installation failure');

	const plainState = find(states, 'ljharb/plain');
	t.equal(plainState.configError, '`ljharb/.github`’s `ljharb-actions.json` is not valid JSON', 'the account file’s error, labeled with the account’s file');
	t.deepEqual(plain(plainState.config.workflows), {}, 'the built-in defaults');

	const ownError = find(states, 'ljharb/own-error');
	t.equal(
		ownError.configError,
		'`ljharb/.github`’s `ljharb-actions.json` is not valid JSON; `.github/ljharb-actions.json` must contain a JSON object',
		'the account file’s error, then the repository’s own, joined',
	);

	const ownConfig = find(states, 'ljharb/own-config');
	t.equal(ownConfig.configError, '`ljharb/.github`’s `ljharb-actions.json` is not valid JSON', 'a valid own file still reports the account file’s error');
	t.notOk(
		states.some((s) => (/AccountSecret|token|nope/).test(String(s.configError))),
		'no part of the account file’s contents leaks into any config error',
	);
	t.deepEqual(plain(ownConfig.config.workflows), { 'rebase.yml': false }, 'and the own config applies');

	const invalidWorkflows = '`workflows` must be a boolean, or an object mapping workflow file names (`*.yml` or `*.yaml`) to booleans';
	t.equal(
		find(states, 'es-shims/shim').configError,
		`\`es-shims/.github\`’s \`ljharb-actions.json\`: ${invalidWorkflows}; \`.github/ljharb-actions.json\`: ${invalidWorkflows}`,
		'an invalid key in each file: both errors, joined',
	);
	t.deepEqual(plain(find(states, 'es-shims/shim').config.workflows), {}, 'the built-in defaults');
});

test('discover: an account defaults query that fails without usable partial data fails the installation', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 90, account: { login: 'ljharb' } },
			{ id: 91, account: { login: 'es-shims' } },
			{ id: 92, account: { login: 'inspect-js' } },
		],
		installationRepos: {
			90: [installedRepo('ljharb', 'a')],
			91: [installedRepo('es-shims', 'b')],
			92: [installedRepo('inspect-js', 'c')],
		},
		accounts: {
			ljharb: { error: { status: 502, body: { message: 'Bad Gateway' } } },
			'es-shims': { nullData: true },
			'inspect-js': { text: '{}' },
		},
		repos: {
			'ljharb/a': { data: {} },
			'es-shims/b': { data: {} },
			'inspect-js/c': { data: {} },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims', 'inspect-js']));
	t.deepEqual(states.map((s) => s.repository), ['inspect-js/c'], 'only the healthy installation’s repositories are found');
	t.deepEqual(failures.map((f) => f.scope).sort(), ['installation 90', 'installation 91'], 'each failing installation is reported');
	t.equal(failures.find((f) => f.scope === 'installation 90')?.message, 'could not be read (HTTP 502)', 'an HTTP error: only its status');
	t.equal(failures.find((f) => f.scope === 'installation 91')?.message, 'could not be read', 'errors with null data: none of their messages');
	t.deepEqual(repoQueries(requests).map(queriedRepos), [['inspect-js/c']], 'a failed installation’s repositories are never queried');
});

test('discover: account defaults partial data with only NOT_FOUND errors means no defaults', async (t) => {
	const requests = setup(t, {
		installations: [{ id: 110, account: { login: 'ljharb' } }],
		installationRepos: { 110: [installedRepo('ljharb', 'a'), installedRepo('ljharb', 'b')] },
		accounts: {
			ljharb: {
				partialErrors: [
					{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository with the name \'ljharb/.github\'.' },
					{ type: 'NOT_FOUND', path: ['repository', 'defaults'], message: 'not found, again' },
				],
			},
		},
		repos: {
			'ljharb/a': { data: { config: { text: '{ "workflows": { "rebase.yml": false } }' } } },
			'ljharb/b': { data: {} },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']));
	t.deepEqual(failures, [], 'not a failure');
	t.equal(accountQueries(requests).length, 1, 'the defaults are queried');
	t.deepEqual(states.map((s) => s.repository).sort(), ['ljharb/a', 'ljharb/b'], 'every repository has a state');
	t.deepEqual(plain(find(states, 'ljharb/a').config.workflows), { 'rebase.yml': false }, 'only the repository’s own config');
	t.deepEqual(plain(find(states, 'ljharb/b').config.workflows), {}, 'the built-in defaults');
	t.ok(states.every((s) => s.configError === null), 'no config errors');
});

test('discover: account defaults partial data with any error other than NOT_FOUND fails the installation', async (t) => {
	const forbidden = { type: 'FORBIDDEN', path: ['repository'], message: 'Resource protected by organization SAML enforcement.' };
	const notFound = { type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository.' };
	const requests = setup(t, {
		installations: [
			{ id: 120, account: { login: 'ljharb' } },
			{ id: 121, account: { login: 'es-shims' } },
			{ id: 122, account: { login: 'inspect-js' } },
			{ id: 123, account: { login: 'browserify' } },
			{ id: 124, account: { login: 'healthy' } },
		],
		installationRepos: {
			120: [installedRepo('ljharb', 'a')],
			121: [installedRepo('es-shims', 'b')],
			122: [installedRepo('inspect-js', 'c')],
			123: [installedRepo('browserify', 'd')],
			124: [installedRepo('healthy', 'e')],
		},
		accounts: {
			ljharb: { partialErrors: [forbidden] },
			'es-shims': { partialErrors: [notFound, forbidden] },
			'inspect-js': { partialErrors: [] },
			browserify: { partialErrors: [notFound, { message: 'an error with no type' }, 'not an object'] },
			healthy: { text: '{}' },
		},
		repos: {
			'ljharb/a': { data: {} },
			'es-shims/b': { data: {} },
			'inspect-js/c': { data: {} },
			'browserify/d': { data: {} },
			'healthy/e': { data: {} },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims', 'inspect-js', 'browserify', 'healthy']));
	t.deepEqual(states.map((s) => s.repository), ['healthy/e'], 'no repository states from a failing installation');
	t.deepEqual(
		failures.map((f) => f.scope).sort(),
		['installation 120', 'installation 121', 'installation 122', 'installation 123'],
		'each failing installation is reported',
	);
	t.equal(failures.find((f) => f.scope === 'installation 120')?.message, 'could not be read (FORBIDDEN)', 'FORBIDDEN, with a null repository: only the GraphQL error’s type, since its message can describe the organization’s restrictions');
	t.equal(failures.find((f) => f.scope === 'installation 121')?.message, 'could not be read (NOT_FOUND, FORBIDDEN)', 'NOT_FOUND mixed with FORBIDDEN: only the GraphQL errors’ types');
	t.equal(failures.find((f) => f.scope === 'installation 122')?.message, 'could not be read', 'partial data with an empty errors array');
	t.equal(failures.find((f) => f.scope === 'installation 123')?.message, 'could not be read (NOT_FOUND)', 'NOT_FOUND mixed with untyped errors: no message, and nothing that isn’t a type');
	t.deepEqual(accountQueries(requests).length, 5, 'the defaults are queried for each account');
	t.deepEqual(repoQueries(requests).map(queriedRepos), [['healthy/e']], 'a failed installation’s repositories are never queried');
});

test('discover: an installation with no repositories makes no GraphQL queries', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 100, account: { login: 'ljharb' } },
			{ id: 101, account: { login: 'es-shims' } },
		],
		installationRepos: {
			100: [],
			101: [installedRepo('es-shims', 'b')],
		},
		accounts: { ljharb: { text: '{}' }, 'es-shims': { text: '{}' } },
		repos: { 'es-shims/b': { data: {} } },
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']));
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(states.map((s) => s.repository), ['es-shims/b'], 'the other installation’s repositories are found');
	t.deepEqual(
		requests.filter((r) => r.authorization === 'token ghs_installation_100').map((r) => r.path),
		['/installation/repositories?per_page=100'],
		'the empty installation only lists its repositories',
	);
	t.deepEqual(accountQueries(requests).map((r) => r.body.variables), [{ owner: 'es-shims' }], 'no defaults query for the empty installation');
});

test('discover: an account’s `.github` repository is skipped unless its own file sets `workflows`', async (t) => {
	/** @type {[string, string | null][]} */
	const cases = [
		['plain', null],
		['upper', null],
		['empty', '{}'],
		['invalid', '{ "workflows": 1 }'],
		['opt-in-true', '{ "workflows": true }'],
		['opt-in-object', '{ "workflows": { "node.yml": false } }'],
		['opt-out', '{ "workflows": false }'],
	];
	const installations = cases.map(([owner], i) => ({ id: 110 + i, account: { login: owner } }));
	const names = Object.fromEntries(cases.map(([owner]) => [owner, owner === 'upper' ? '.GitHub' : '.github']));
	const requests = setup(t, {
		installations: [...installations, { id: 199, account: { login: 'others' } }],
		installationRepos: {
			...Object.fromEntries(cases.map(([owner], i) => [110 + i, [installedRepo(owner, names[owner])]])),
			199: [installedRepo('others', 'github'), installedRepo('others', 'x.github')],
		},
		accounts: {
			...Object.fromEntries(cases.map(([owner]) => [owner, { text: '{ "workflows": { "rebase.yml": false } }' }])),
			others: { text: '{ "workflows": { "rebase.yml": false } }' },
		},
		repos: {
			...Object.fromEntries(cases.map(([owner, text]) => [`${owner}/${names[owner]}`, { data: { config: text === null ? null : { text } } }])),
			'others/github': { data: {} },
			'others/x.github': { data: {} },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set([...cases.map(([owner]) => owner), 'others']));
	t.deepEqual(failures, [], 'no failures');
	t.equal(accountQueries(requests).length, cases.length + 1, 'every account’s defaults are still read');

	t.equal(find(states, 'plain/.github').config.workflows, false, 'skipped despite the account’s defaults');
	t.equal(find(states, 'upper/.GitHub').config.workflows, false, 'the name is matched case-insensitively');
	t.equal(find(states, 'empty/.github').config.workflows, false, 'skipped when its own file does not set `workflows`');
	t.equal(find(states, 'invalid/.github').config.workflows, false, 'skipped when its own `workflows` is invalid');
	t.match(String(find(states, 'invalid/.github').configError), /^`\.github\/ljharb-actions\.json`: `workflows` must be /, 'which is still a config error');
	t.deepEqual(plain(find(states, 'opt-in-true/.github').config.workflows), { 'rebase.yml': false }, 'opts in with `true`, with the account’s defaults');
	t.deepEqual(plain(find(states, 'opt-in-object/.github').config.workflows), { 'rebase.yml': false, 'node.yml': false }, 'opts in with an object, merged over the account’s defaults');
	t.equal(find(states, 'opt-out/.github').config.workflows, false, 'stays off with its own `false`');

	t.deepEqual(plain(find(states, 'others/github').config.workflows), { 'rebase.yml': false }, 'a repository named `github` is not skipped');
	t.deepEqual(plain(find(states, 'others/x.github').config.workflows), { 'rebase.yml': false }, 'nor is one merely ending in `.github`');
});

test('discover: browserify repositories on the ignore list are never queried', async (t) => {
	const requests = setup(t, {
		installations: [{ id: 100, account: { login: 'browserify' } }],
		installationRepos: {
			100: [
				installedRepo('browserify', 'resolve'),
				installedRepo('browserify', 'Module-Deps'),
				installedRepo('browserify', 'watchify'),
			],
		},
		accounts: { browserify: { text: '{}' } },
		repos: { 'browserify/resolve': { data: {} } },
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['browserify']));
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(states.map((s) => s.repository), ['browserify/resolve'], 'only the repository not on the list is found');
	t.deepEqual(repoQueries(requests).flatMap(queriedRepos), ['browserify/resolve'], 'ignored repositories are matched case-insensitively, and never queried');
});

test('discover: an installation whose repositories are all ignored makes no GraphQL queries', async (t) => {
	const requests = setup(t, {
		installations: [{ id: 100, account: { login: 'browserify' } }],
		installationRepos: { 100: [installedRepo('browserify', 'module-deps')] },
		accounts: {},
		repos: {},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['browserify']));
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(states, [], 'no states');
	t.deepEqual(graphqlRequests(requests), [], 'no GraphQL queries');
});

/** @typedef {import('./helpers/github.mjs').ParentData} ParentData */

// a fork's data, with each parent in turn the parent of the one before it
/** @type {(...parents: Omit<ParentData, 'parent'>[]) => { data: { isFork: true, parent: ParentData | null } }} */
function forkOf(...parents) {
	return {
		data: {
			isFork: true,
			parent: parents.reduceRight((/** @type {ParentData | null} */ parent, p) => ({ ...p, parent }), null),
		},
	};
}

/** @type {(requests: Recorded[]) => Recorded[]} */
function commitRequests(requests) {
	return requests.filter((r) => (/^\/repos\/[^/]+\/[^/]+\/commits\?/).test(r.path));
}

test('discover: forks are dropped, and a fork’s source is the deepest parent read', async (t) => {
	const requests = setup(t, {
		installations: [{ id: 200, account: { login: 'ljharb' } }],
		installationRepos: {
			200: [
				installedRepo('ljharb', 'plain'),
				installedRepo('ljharb', 'odd'),
				installedRepo('ljharb', 'orphan'),
				installedRepo('ljharb', 'one'),
				installedRepo('ljharb', 'two'),
				installedRepo('ljharb', 'three'),
			],
		},
		accounts: { ljharb: { text: '{ "workflows": { "rebase.yml": false } }' } },
		repos: {
			'ljharb/plain': { data: { isFork: false, defaultBranchRef: { name: 'main' } } },
			// not a fork, so its parent is never followed
			'ljharb/odd': { data: { isFork: false, parent: { nameWithOwner: 'up/odd' } } },
			// a fork whose parent is gone (or unreadable)
			'ljharb/orphan': { data: { isFork: true, parent: null } },
			'ljharb/one': forkOf({ nameWithOwner: 'up/one' }),
			'ljharb/two': forkOf({ nameWithOwner: 'mid/two' }, { nameWithOwner: 'root/two' }),
			'ljharb/three': forkOf({ nameWithOwner: 'a/three' }, { nameWithOwner: 'b/three' }, { nameWithOwner: 'c/three' }),
			'up/one': { data: { defaultBranchRef: { name: 'trunk' } } },
			'root/two': { data: {} },
			'c/three': { data: {} },
		},
		commits: {
			'up/one': 1, 'root/two': 1, 'c/three': 1, 'mid/two': 1, 'a/three': 1, 'b/three': 1, 'up/odd': 1,
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']), {
		sourceAccounts: new Set(['up', 'mid', 'root', 'a', 'b', 'c']),
		committer: 'ljharb',
	});
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(
		states.map((s) => s.repository),
		['c/three', 'ljharb/odd', 'ljharb/plain', 'root/two', 'up/one'],
		'forks are dropped, with or without a parent; each one’s source is found',
	);
	t.deepEqual(
		commitRequests(requests).map((r) => r.path).sort(),
		[
			'/repos/c/three/commits?committer=ljharb&per_page=1',
			'/repos/root/two/commits?committer=ljharb&per_page=1',
			'/repos/up/one/commits?committer=ljharb&per_page=1',
		],
		'only the deepest parent of each fork is checked, never an intermediate one, nor a non-fork’s parent',
	);
	const query = String(repoQueries(requests)[0].body.query);
	t.match(query, /\bisFork\b/, 'the query reads whether a repository is a fork');
	t.match(query, /parent \{ \.\.\.origin parent \{ \.\.\.origin parent \{ \.\.\.origin \} \} \}/, 'and up to three levels of parents');

	for (const repository of ['ljharb/plain', 'ljharb/odd']) {
		const state = find(states, repository);
		t.equal(state.fork, false, `${repository}: not a fork`);
		t.equal(state.source, null, `${repository}: no source`);
		t.equal(state.external, false, `${repository}: not external`);
		t.deepEqual(plain(state.config.workflows), { 'rebase.yml': false }, `${repository}: the account’s defaults`);
	}
	t.equal(find(states, 'ljharb/plain').defaultBranch, 'main', 'an installed repository’s state');

	const one = find(states, 'up/one');
	t.equal(one.external, true, 'a source is external');
	t.equal(one.fork, false, 'and not a fork');
	t.equal(one.installationId, 200, 'with the fork’s installation');
	t.equal(one.defaultBranch, 'trunk', 'with its own state');
	t.deepEqual(plain(one.config.workflows), {}, 'without the fork’s account’s defaults');
});

test('discover: which fork sources are checked', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 210, account: { login: 'ljharb' } },
			{ id: 211, account: { login: 'es-shims' } },
		],
		installationRepos: {
			210: [
				installedRepo('ljharb', 'fa'),
				installedRepo('ljharb', 'fb'),
				installedRepo('ljharb', 'fc'),
				installedRepo('ljharb', 'fd'),
				installedRepo('ljharb', 'fe'),
				installedRepo('ljharb', 'ff'),
				installedRepo('ljharb', 'installed'),
				installedRepo('ljharb', 'fh'),
			],
			211: [installedRepo('es-shims', 'fg'), installedRepo('es-shims', 'fi')],
		},
		accounts: { ljharb: { text: '{ "workflows": false }' } },
		repos: {
			'ljharb/fa': forkOf({ nameWithOwner: 'allowed/public' }),
			'ljharb/fb': forkOf({ nameWithOwner: 'allowed/archived', isArchived: true }),
			'ljharb/fc': forkOf({ nameWithOwner: 'allowed/private', isPrivate: true }),
			'ljharb/fd': forkOf({ nameWithOwner: 'stranger/repo' }),
			'ljharb/fe': forkOf({ nameWithOwner: 'LJHarb/Installed' }),
			'ljharb/ff': forkOf({ nameWithOwner: 'Allowed/Public' }),
			'ljharb/installed': { data: {} },
			// only the deepest parent's visibility matters
			'ljharb/fh': forkOf({ nameWithOwner: 'allowed/mid', isPrivate: true }, { nameWithOwner: 'allowed/other' }),
			'es-shims/fg': forkOf({ nameWithOwner: 'allowed/public' }),
			'es-shims/fi': forkOf({ nameWithOwner: 'Allowed/Second' }),
			'allowed/public': {
				data: {
					isArchived: false, isPrivate: false, config: { text: '{ "workflows": { "node.yml": false } }' },
				},
			},
			'allowed/other': { data: {} },
			'Allowed/Second': { data: { isArchived: true } },
		},
		commits: {
			'allowed/public': 2,
			'allowed/archived': 1,
			'allowed/private': 1,
			'stranger/repo': 1,
			'LJHarb/Installed': 1,
			'Allowed/Public': 1,
			'allowed/other': 1,
			'Allowed/Second': 1,
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']), {
		sourceAccounts: parseAccounts('Allowed ljharb', ''),
		committer: 'ljharb',
	});
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(
		states.map((s) => s.repository),
		['allowed/other', 'allowed/public', 'Allowed/Second', 'ljharb/installed'],
		'only public, unarchived, uninstalled sources in an allowed account, each once',
	);
	t.deepEqual(
		commitRequests(requests).map((r) => r.path.split('?')[0]).sort(),
		['/repos/Allowed/Second/commits', '/repos/allowed/other/commits', '/repos/allowed/public/commits'],
		'a source is checked once, however many forks of it are installed, in any installation, and in any case',
	);
	t.deepEqual(
		Object.fromEntries(commitRequests(requests).map((r) => [r.path.split('/')[3], r.authorization])),
		{ Second: 'token ghs_installation_211', other: 'token ghs_installation_210', public: 'token ghs_installation_210' },
		'each with a token for the installation of the (first) fork of it',
	);

	const sourceQueries = repoQueries(requests).filter((r) => queriedRepos(r).every((n) => !n.startsWith('ljharb/') && !n.startsWith('es-shims/')));
	t.equal(sourceQueries.length, 1, 'the sources are queried in one batch');
	t.deepEqual(queriedRepos(sourceQueries[0]).sort(), ['Allowed/Second', 'allowed/other', 'allowed/public'], 'of exactly the kept sources');
	t.deepEqual(accountQueries(requests).map((r) => r.body.variables.owner).sort(), ['es-shims', 'ljharb'], 'a source’s account’s defaults are never read');

	const pub = find(states, 'allowed/public');
	t.equal(pub.external, true, 'external');
	t.equal(pub.installationId, 210, 'with the installation of its first fork');
	t.equal(pub.owner, 'allowed', 'owner');
	t.equal(pub.name, 'public', 'name');
	t.equal(pub.private, false, 'public');
	t.deepEqual(plain(pub.config.workflows), { 'node.yml': false }, 'only its own config, not the fork’s account’s defaults');
	t.equal(pub.configError, null, 'no config error');
	t.equal(find(states, 'Allowed/Second').archived, true, 'a source’s own state is read, even if it differs from its fork’s view of it');
	t.equal(find(states, 'ljharb/installed').config.workflows, false, 'an installed repository still gets its account’s defaults');
	t.equal(find(states, 'ljharb/installed').external, false, 'and is not external');
});

test('discover: a fork’s source is only checked when the committer has committed to it', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 220, account: { login: 'ljharb' } },
			{ id: 221, account: { login: 'es-shims' } },
		],
		installationRepos: {
			220: [
				installedRepo('ljharb', 'own'),
				installedRepo('ljharb', 'f-yes'),
				installedRepo('ljharb', 'f-none'),
				installedRepo('ljharb', 'f-empty'),
				installedRepo('ljharb', 'f-broken'),
			],
			221: [installedRepo('es-shims', 'f-also')],
		},
		repos: {
			'ljharb/own': { data: {} },
			'ljharb/f-yes': forkOf({ nameWithOwner: 'allowed/yes' }),
			'ljharb/f-none': forkOf({ nameWithOwner: 'allowed/none' }),
			'ljharb/f-empty': forkOf({ nameWithOwner: 'allowed/empty' }),
			'ljharb/f-broken': forkOf({ nameWithOwner: 'allowed/broken' }),
			'es-shims/f-also': forkOf({ nameWithOwner: 'allowed/also' }),
			'allowed/yes': { data: {} },
			'allowed/also': { data: {} },
			'allowed/none': { data: {} },
			'allowed/empty': { data: {} },
			'allowed/broken': { data: {} },
		},
		commits: {
			'allowed/yes': 3,
			'allowed/also': 1,
			'allowed/none': 0,
			'allowed/empty': { status: 409, body: { message: 'Git Repository is empty.' } },
			'allowed/broken': { status: 500, body: { message: 'kaboom' } },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']), {
		sourceAccounts: new Set(['allowed']),
		committer: 'some-committer',
	});
	t.deepEqual(states.map((s) => s.repository), ['allowed/also', 'allowed/yes', 'ljharb/own'], 'only sources with commits are kept, alongside the installed repositories');
	t.equal(failures.length, 1, 'one failure');
	t.equal(failures[0].scope, 'source allowed/broken', 'scoped to the source');
	t.match(failures[0].message, /kaboom/, 'with the API’s message');
	t.deepEqual(
		commitRequests(requests).map((r) => new URLSearchParams(r.path.split('?')[1]).get('committer')),
		Array(5).fill('some-committer'),
		'every candidate is checked for the committer’s commits',
	);
	t.ok(commitRequests(requests).every((r) => new URLSearchParams(r.path.split('?')[1]).get('per_page') === '1'), 'one commit is enough');
	t.deepEqual(
		repoQueries(requests).flatMap(queriedRepos).filter((n) => n.startsWith('allowed/')).sort(),
		['allowed/also', 'allowed/yes'],
		'a dropped source is never queried',
	);
	t.equal(find(states, 'allowed/yes').installationId, 220, 'a source has its fork’s installation');
});

test('discover: a non-Error failure checking a source', async (t) => {
	setup(t, {
		installations: [{ id: 230, account: { login: 'ljharb' } }],
		installationRepos: { 230: [installedRepo('ljharb', 'own'), installedRepo('ljharb', 'fork')] },
		repos: {
			'ljharb/own': { data: {} },
			'ljharb/fork': forkOf({ nameWithOwner: 'allowed/source' }),
		},
		commits: { 'allowed/source': 1 },
	});
	const real = appAuth('1', privateKey());
	let installationCalls = 0;
	const auth = /** @type {typeof real} */ (/** @type {unknown} */ (async (/** @type {{ type: 'app' | 'installation', installationId: number }} */ options) => { // eslint-disable-line no-extra-parens
		if (options.type === 'installation') {
			installationCalls += 1;
			if (installationCalls > 1) {
				throw 'no source token for you'; // eslint-disable-line no-throw-literal
			}
		}
		return real(/** @type {any} */ (options)); // eslint-disable-line no-extra-parens
	}));

	const { states, failures } = await discover(auth, new Set(['ljharb']), { sourceAccounts: new Set(['allowed']), committer: 'ljharb' });
	t.deepEqual(states.map((s) => s.repository), ['ljharb/own'], 'the installation’s repositories are unaffected');
	t.deepEqual(failures, [{ scope: 'source allowed/source', message: 'no source token for you' }], 'the thrown value is stringified');
});

test('discover: no source is checked without a committer, or without a candidate', async (t) => {
	/** @type {Scenario} */
	const scenario = {
		installations: [{ id: 240, account: { login: 'ljharb' } }],
		installationRepos: { 240: [installedRepo('ljharb', 'own'), installedRepo('ljharb', 'fork')] },
		repos: {
			'ljharb/own': { data: {} },
			'ljharb/fork': forkOf({ nameWithOwner: 'allowed/source' }),
			'allowed/source': { data: {} },
		},
		commits: { 'allowed/source': 1 },
	};
	/** @type {[string, import('../../../fleet/lib/app.mjs').Options | undefined][]} */
	const cases = [
		['no options', undefined],
		['an empty committer', { sourceAccounts: new Set(['allowed']), committer: '' }],
		['no committer', { sourceAccounts: new Set(['allowed']) }],
		['no source accounts', { committer: 'ljharb' }],
		['an empty set of source accounts', { sourceAccounts: new Set(), committer: 'ljharb' }],
	];
	for (const [description, options] of cases) {
		/** @type {Recorded[]} */
		const requests = [];
		const teardown = mockGitHub(scenario, (r) => requests.push(r));
		nock.disableNetConnect();
		try {
			const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']), options); // eslint-disable-line no-await-in-loop
			t.deepEqual(failures, [], `${description}: no failures`);
			t.deepEqual(states.map((s) => s.repository), ['ljharb/own'], `${description}: only the installed non-fork`);
			t.deepEqual(commitRequests(requests), [], `${description}: no commits are listed`);
			t.deepEqual(repoQueries(requests).map(queriedRepos), [['ljharb/own', 'ljharb/fork']], `${description}: only the installation’s repositories are queried`);
			t.equal(requests.filter((r) => r.path.endsWith('/access_tokens')).length, 1, `${description}: only the installation’s own token`);
		} finally {
			teardown();
			nock.enableNetConnect();
		}
	}
});

test('discover: sources are queried in batches of 20, one batch at a time, retrying a failed batch one source at a time', async (t) => {
	const forks = Array.from({ length: 45 }, (_, i) => installedRepo('ljharb', `f${String(i).padStart(2, '0')}`));
	const sources = forks.map((_, i) => `allowed/s${String(i).padStart(2, '0')}`);
	/** @type {Record<string, import('./helpers/github.mjs').RepoSpec>} */
	const specs = {
		...Object.fromEntries(forks.map((r, i) => [r.full_name, forkOf({ nameWithOwner: sources[i] })])),
		...Object.fromEntries(sources.map((s) => [s, { data: { defaultBranchRef: { name: 'main' } } }])),
	};
	specs['allowed/s25'] = { failInBatch: true, data: { isArchived: true } };
	specs['allowed/s30'] = { failAlways: true };
	const requests = setup(t, {
		installations: [{ id: 250, account: { login: 'ljharb' } }],
		installationRepos: { 250: forks },
		accounts: { ljharb: { text: '{ "workflows": false }' } },
		repos: specs,
		commits: Object.fromEntries(sources.map((s) => [s, 1])),
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']), { sourceAccounts: new Set(['allowed']), committer: 'ljharb' });
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(states.map((s) => s.repository), sources, 'every source has a state, and no fork does');
	t.equal(commitRequests(requests).length, 45, 'each source is checked');

	const queries = repoQueries(requests).map(queriedRepos).filter((q) => q[0].startsWith('allowed/'));
	t.deepEqual(queries[0], sources.slice(0, 20), 'first batch: 20 sources');
	t.deepEqual(queries[1], sources.slice(20, 40), 'second batch: 20 sources, which fails');
	t.deepEqual(queries.slice(2, 22).map((q) => q.length), Array(20).fill(1), 'then each source of the failed batch is queried alone');
	t.deepEqual(queries.slice(2, 22).flat().sort(), sources.slice(20, 40), 'covering exactly the failed batch');
	t.deepEqual(queries[22], sources.slice(40), 'last batch: the remaining 5');
	t.equal(queries.length, 23, 'no other source queries');
	t.equal(accountQueries(requests).length, 1, 'only the installation’s account’s defaults are read');

	t.ok(states.every((s) => s.external && !s.fork && s.installationId === 250), 'every source is external, with the fork’s installation');
	t.ok(states.every((s) => s.config.workflows !== false), 'and none gets the fork’s account’s defaults');
	t.equal(find(states, 'allowed/s25').archived, true, 'a source that only fails in a batch is recovered');
	t.equal(find(states, 'allowed/s30').stateError, 'could not read the repository’s state', 'a source that fails alone is lost');
	t.equal(states.filter((s) => s.stateError).length, 1, 'and only that one');
	t.equal(find(states, 'allowed/s00').defaultBranch, 'main', 'with each source’s own state');
});

test('discover: a fork’s source is never checked when it’s ignored, or its owner has any installation at all', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 300, account: { login: 'ljharb' } },
			{ id: 301, account: { login: 'Stranger' } },
			{ id: 302, account: { login: 'sleepy' }, suspended_at: '2026-01-01T00:00:00Z' }, // eslint-disable-line camelcase
			{ id: 303, account: { login: 'broken' } },
		],
		installationRepos: {
			300: [
				installedRepo('ljharb', 'f-stranger'),
				installedRepo('ljharb', 'f-sleepy'),
				installedRepo('ljharb', 'f-broken'),
				installedRepo('ljharb', 'f-ignored'),
				installedRepo('ljharb', 'f-kept'),
			],
			303: { status: 500, body: { message: 'installation kaboom' } },
		},
		repos: {
			'ljharb/f-stranger': forkOf({ nameWithOwner: 'stranger/source' }),
			'ljharb/f-sleepy': forkOf({ nameWithOwner: 'Sleepy/source' }),
			'ljharb/f-broken': forkOf({ nameWithOwner: 'broken/source' }),
			'ljharb/f-ignored': forkOf({ nameWithOwner: 'Browserify/BRFS' }),
			'ljharb/f-kept': forkOf({ nameWithOwner: 'allowed/kept' }),
			'stranger/source': { data: {} },
			'Sleepy/source': { data: {} },
			'broken/source': { data: {} },
			'Browserify/BRFS': { data: {} },
			'allowed/kept': { data: {} },
		},
		commits: {
			'stranger/source': 1,
			'Sleepy/source': 1,
			'broken/source': 1,
			'Browserify/BRFS': 1,
			'allowed/kept': 1,
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'sleepy', 'broken']), {
		sourceAccounts: new Set(['stranger', 'sleepy', 'broken', 'browserify', 'allowed']),
		committer: 'ljharb',
	});
	t.deepEqual(
		failures.map((f) => f.scope),
		['installation 301', 'installation 303'],
		'the disallowed and failed installations are reported, and nothing else',
	);
	t.deepEqual(
		commitRequests(requests).map((r) => r.path.split('?')[0]),
		['/repos/allowed/kept/commits'],
		'a source whose owner’s installation is disallowed, suspended, or failed, or that is ignored, is never checked; only an uninstalled account’s is',
	);
	t.deepEqual(states.map((s) => s.repository), ['allowed/kept'], 'so only that source is found');
});

test('discover: sources are checked for commits one at a time, and their failures are sorted', async (t) => {
	/** @type {Recorded[]} */
	const requests = [];
	/** @type {number[]} */
	const commitTimes = [];
	nock.disableNetConnect();
	const teardown = mockGitHub({
		installations: [{ id: 310, account: { login: 'ljharb' } }],
		installationRepos: {
			310: [
				installedRepo('ljharb', 'f1'),
				installedRepo('ljharb', 'f2'),
				installedRepo('ljharb', 'f3'),
				installedRepo('ljharb', 'f4'),
			],
		},
		repos: {
			'ljharb/f1': forkOf({ nameWithOwner: 'allowed/zeta' }),
			'ljharb/f2': forkOf({ nameWithOwner: 'allowed/mu' }),
			'ljharb/f3': forkOf({ nameWithOwner: 'allowed/alpha' }),
			'ljharb/f4': forkOf({ nameWithOwner: 'allowed/kept' }),
			'allowed/kept': { data: {} },
		},
		commits: {
			'allowed/zeta': { status: 500, body: { message: 'zeta kaboom' } },
			'allowed/mu': { status: 500, body: { message: 'mu kaboom' } },
			'allowed/alpha': { status: 500, body: { message: 'alpha kaboom' } },
			'allowed/kept': 1,
		},
		commitsDelay: 50,
	}, (r) => {
		requests.push(r);
		if ((/\/commits\?/).test(r.path)) {
			commitTimes.push(Date.now());
		}
	});
	t.teardown(() => {
		teardown();
		nock.enableNetConnect();
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']), { sourceAccounts: new Set(['allowed']), committer: 'ljharb' });
	t.deepEqual(
		commitRequests(requests).map((r) => r.path.split('/')[3]),
		['zeta', 'mu', 'alpha', 'kept'],
		'each source is checked, in the order its fork was found',
	);
	t.ok(
		commitTimes.slice(1).every((time, i) => time - commitTimes[i] >= 40),
		'each check starts only after the one before it has had its (delayed) reply',
	);
	t.deepEqual(
		failures.map((f) => f.scope),
		['source allowed/alpha', 'source allowed/mu', 'source allowed/zeta'],
		'failures are sorted by scope',
	);
	t.match(failures[0].message, /alpha kaboom/, 'each with its own message');
	t.deepEqual(states.map((s) => s.repository), ['allowed/kept'], 'a source that passes is still found');
});

test('discover: each source in a batch keeps its own fork’s installation', async (t) => {
	const requests = setup(t, {
		installations: [
			{ id: 320, account: { login: 'ljharb' } },
			{ id: 321, account: { login: 'es-shims' } },
		],
		installationRepos: {
			320: [installedRepo('ljharb', 'fa')],
			321: [installedRepo('es-shims', 'fb')],
		},
		repos: {
			'ljharb/fa': forkOf({ nameWithOwner: 'allowed/a' }),
			'es-shims/fb': forkOf({ nameWithOwner: 'allowed/b' }),
			'allowed/a': { data: {} },
			'allowed/b': { data: {} },
		},
		commits: { 'allowed/a': 1, 'allowed/b': 1 },
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims']), { sourceAccounts: new Set(['allowed']), committer: 'ljharb' });
	t.deepEqual(failures, [], 'no failures');
	const sourceQueries = repoQueries(requests).filter((r) => queriedRepos(r).every((n) => n.startsWith('allowed/')));
	t.deepEqual(sourceQueries.map(queriedRepos), [['allowed/a', 'allowed/b']], 'both sources are queried in one batch');
	t.equal(find(states, 'allowed/a').installationId, 320, 'the first source has its own fork’s installation');
	t.equal(find(states, 'allowed/b').installationId, 321, 'and so does the second, from a different installation');
});

test('discover: a fork whose state can’t be read is still dropped, per the repository listing', async (t) => {
	setup(t, {
		installations: [{ id: 330, account: { login: 'ljharb' } }],
		installationRepos: {
			330: [
				installedRepo('ljharb', 'own'),
				installedRepo('ljharb', 'lost'),
				installedRepo('ljharb', 'lost-fork', { fork: true }),
			],
		},
		repos: {
			'ljharb/own': { data: {} },
			'ljharb/lost': { failAlways: true },
			'ljharb/lost-fork': { failAlways: true },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']));
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(states.map((s) => s.repository), ['ljharb/lost', 'ljharb/own'], 'the unreadable fork is dropped, while an unreadable non-fork is kept');
	t.equal(find(states, 'ljharb/lost').stateError, 'could not read the repository’s state', 'with its state error');
});

test('discover: a source that is itself a fork, past the parents read, is dropped', async (t) => {
	const requests = setup(t, {
		installations: [{ id: 340, account: { login: 'ljharb' } }],
		installationRepos: { 340: [installedRepo('ljharb', 'deep'), installedRepo('ljharb', 'shallow')] },
		repos: {
			'ljharb/deep': forkOf({ nameWithOwner: 'allowed/one' }, { nameWithOwner: 'allowed/two' }, { nameWithOwner: 'allowed/three' }),
			'ljharb/shallow': forkOf({ nameWithOwner: 'allowed/root' }),
			// a fourth level, beyond what a fork's query reads
			'allowed/three': { data: { isFork: true, parent: { nameWithOwner: 'allowed/four' } } },
			'allowed/root': { data: {} },
		},
		commits: { 'allowed/three': 1, 'allowed/root': 1 },
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']), { sourceAccounts: new Set(['allowed']), committer: 'ljharb' });
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(
		repoQueries(requests).flatMap(queriedRepos).filter((n) => n.startsWith('allowed/')).sort(),
		['allowed/root', 'allowed/three'],
		'the deepest parent read is queried',
	);
	t.deepEqual(states.map((s) => s.repository), ['allowed/root'], 'but dropped, since it is itself a fork');
	t.deepEqual(commitRequests(requests).filter((r) => r.path.includes('/four/')), [], 'and its own parent is never checked');
});
