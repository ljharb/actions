import nock from 'nock';
import test from 'tape';

import { appAuth, installationToken, octokitFor } from '../../../fleet/lib/app.mjs';
import { privateKey } from './helpers/github.mjs';

/** @import { Test } from 'tape' */

/** @type {(t: Test) => nock.Scope} */
function setup(t) {
	nock.disableNetConnect();
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});
	return nock('https://api.github.com');
}

const version = '2026-03-10';

test('octokitFor: asks for GitHub’s current REST API version', async (t) => {
	await [false, true].reduce(
		async (previous, isPrivate) => {
			await previous;
			const scope = setup(t);
			scope.get('/repos/o/r').matchHeader('x-github-api-version', version).reply(200, { full_name: 'o/r' }); // eslint-disable-line camelcase
			const graphql = nock('https://api.github.com', { badheaders: ['x-github-api-version'] }).post('/graphql').reply(200, { data: { viewer: { login: 'x' } } });
			const octokit = octokitFor('ghs_test', isPrivate);

			const { data } = await octokit.rest.repos.get({ owner: 'o', repo: 'r' });
			t.equal(data.full_name, 'o/r', `${isPrivate ? 'private' : 'public'}: a REST request asks for it`);
			t.deepEqual(await octokit.graphql('{ viewer { login } }'), { viewer: { login: 'x' } }, `${isPrivate ? 'private' : 'public'}: a GraphQL request doesn’t, since GraphQL isn’t versioned that way`);
			t.ok(scope.isDone() && graphql.isDone(), 'making both requests');
		},
		Promise.resolve(),
	);
});

test('appAuth: asking for an installation token asks for GitHub’s current REST API version', async (t) => {
	const scope = setup(t);
	scope.post('/app/installations/7/access_tokens').matchHeader('x-github-api-version', version).reply(201, { token: 'ghs_versioned', expires_at: '2099-01-01T00:00:00Z' }); // eslint-disable-line camelcase

	t.equal(await installationToken(appAuth('1', privateKey()), 7), 'ghs_versioned', 'gets the token');
	t.ok(scope.isDone(), 'asking for it');
});
