// covers what keeps private repositories out of `fleet/lib/app.mjs`'s public output: failure messages, a private fork's source, and a private `.github` repository's defaults
import nock from 'nock';
import test from 'tape';

import {
	appAuth,
	discover,
	failureMessage,
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
		nock.enableNetConnect();
	});
	return requests;
}

/** @type {(states: RepoState[], repository: string) => RepoState} */
function find(states, repository) {
	const state = states.find((s) => s.repository === repository);
	if (!state) {
		throw new Error(`no state for ${repository}`);
	}
	return state;
}

// configs' `workflows` have null prototypes
/** @type {(state: RepoState) => unknown} */
function configOf(state) {
	return JSON.parse(JSON.stringify(state.config));
}

test('failureMessage', (t) => {
	t.equal(failureMessage(Object.assign(new Error('Not Found: acme/secret'), { status: 404 })), 'could not be read (HTTP 404)', 'an HTTP error: only its status');
	t.equal(
		failureMessage(Object.assign(new Error('Resource protected by acme’s SAML enforcement'), {
			errors: [
				{ type: 'FORBIDDEN' },
				{ type: 'FORBIDDEN' },
				{ type: 'lowercase is not a type' },
				{ type: 7 },
				null,
			],
		})),
		'could not be read (FORBIDDEN)',
		'a GraphQL error: only its distinct types',
	);
	t.equal(failureMessage(Object.assign(new Error('x'), { status: '500', errors: 'nope' })), 'could not be read', 'a status or errors of the wrong type: nothing');
	t.equal(failureMessage('acme/secret is gone'), 'could not be read', 'a non-Error: nothing');
	t.equal(failureMessage(null), 'could not be read', 'null: nothing');
	t.end();
});

test('discover: a private fork’s source is never checked', async (t) => {
	setup(t, {
		installations: [{ id: 300, account: { login: 'ljharb' } }],
		installationRepos: { 300: [installedRepo('ljharb', 'secret-fork', { private: true }), installedRepo('ljharb', 'public-fork')] },
		repos: {
			'ljharb/secret-fork': { data: { isFork: true, isPrivate: true, parent: { nameWithOwner: 'allowed/only-private-forks' } } },
			'ljharb/public-fork': { data: { isFork: true, parent: { nameWithOwner: 'allowed/public-forks' } } },
			'allowed/public-forks': { data: {} },
		},
		commits: { 'allowed/only-private-forks': 1, 'allowed/public-forks': 1 },
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb']), {
		sourceAccounts: parseAccounts('allowed', ''),
		committer: 'ljharb',
	});
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(states.map((s) => s.repository), ['allowed/public-forks'], 'a public fork’s source is checked, but not one only a private fork has: that it’s checked would show the private fork exists');
});

test('discover: a private `.github` repository’s defaults apply only to private repositories', async (t) => {
	setup(t, {
		installations: [
			{ id: 310, account: { login: 'ljharb' } },
			{ id: 311, account: { login: 'es-shims' } },
			{ id: 312, account: { login: 'inspect-js' } },
		],
		installationRepos: {
			310: [
				installedRepo('ljharb', 'own'),
				installedRepo('ljharb', 'plain'),
				installedRepo('ljharb', 'secret', { private: true }),
			],
			311: [installedRepo('es-shims', 'invalid'), installedRepo('es-shims', 'invalid-secret', { private: true })],
			312: [installedRepo('inspect-js', 'public-defaults')],
		},
		accounts: {
			ljharb: { private: true, text: JSON.stringify({ workflows: { 'secret-deploy.yml': true, 'own.yml': true, 'forbidden.yml': false } }) },
			'es-shims': { private: true, text: JSON.stringify({ workflows: { 'secret-deploy.yml': 'yes' } }) },
			'inspect-js': { text: JSON.stringify({ workflows: { 'public-required.yml': true } }) },
		},
		repos: {
			'ljharb/own': { data: { config: { text: JSON.stringify({ workflows: { 'own.yml': true } }) } } },
			'ljharb/plain': { data: {} },
			'ljharb/secret': { data: { isPrivate: true } },
			'es-shims/invalid': { data: {} },
			'es-shims/invalid-secret': { data: { isPrivate: true } },
			'inspect-js/public-defaults': { data: {} },
		},
	});

	const { states, failures } = await discover(appAuth('1', privateKey()), new Set(['ljharb', 'es-shims', 'inspect-js']));
	t.deepEqual(failures, [], 'no failures');
	t.deepEqual(configOf(find(states, 'ljharb/plain')), { workflows: {} }, 'a public repository gets none of a private `.github` repository’s defaults: not its required files, nor its forbidden ones');
	t.deepEqual(configOf(find(states, 'ljharb/own')), { workflows: { 'own.yml': true } }, 'a public repository’s own config still applies');
	t.deepEqual(configOf(find(states, 'ljharb/secret')), { workflows: { 'secret-deploy.yml': true, 'own.yml': true, 'forbidden.yml': false } }, 'a private repository gets them all');
	t.equal(find(states, 'es-shims/invalid').configError, null, 'a private `.github` repository’s invalid defaults aren’t a public repository’s error');
	t.equal(find(states, 'es-shims/invalid-secret').configError, 'the account’s defaults are invalid', 'but are a private repository’s, without saying what’s wrong');
	t.deepEqual(configOf(find(states, 'inspect-js/public-defaults')), { workflows: { 'public-required.yml': true } }, 'a public `.github` repository’s defaults apply to its public repositories');
	t.notOk('withheld' in find(states, 'ljharb/plain'), 'nothing is withheld, since nothing private is applied');
});
