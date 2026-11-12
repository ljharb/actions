import { mock } from 'node:test';
import { setImmediate as immediately } from 'timers/promises';

import { defaults } from '@actions/github/lib/utils';
import nock from 'nock';
import test from 'tape';

import { appAuth, installationToken, octokitFor } from '../../../fleet/lib/app.mjs';
import { upsertGist } from '../../../fleet/lib/gist.mjs';
import { upsertReportIssue } from '../../../fleet/lib/issues.mjs';
import { writeQueue } from '../../../fleet/lib/merge.mjs';
import { closePR, commentOnce } from '../../../fleet/lib/pr.mjs';
import { privateKey } from './helpers/github.mjs';

/** @import { Test } from 'tape' */
/** @import { Octokit } from '../../../fleet/lib/app.mjs' */

const requestDefaults = /** @type {NonNullable<typeof defaults.request>} */ (defaults.request);

/**
 * Mocks `api.github.com` for one test, with the retrying every other test turns off (see `helpers/github.mjs`) turned back on, and its waits between attempts made instant; returns what was logged meanwhile.
 * @type {(t: Test) => { scope: nock.Scope, logged: unknown[][] }}
 */
function setup(t) {
	nock.disableNetConnect();
	const { retries } = requestDefaults;
	delete requestDefaults.retries;
	/** @type {unknown[][]} */
	const logged = [];
	const methods = /** @type {const} */ ([
		'debug',
		'info',
		'log',
		'warn',
		'error',
	]);
	const originals = methods.map((method) => console[method]);
	methods.forEach((method) => {
		console[method] = (...args) => {
			logged.push(args);
		};
	});
	t.teardown(() => {
		methods.forEach((method, i) => {
			console[method] = originals[i];
		});
		Object.assign(requestDefaults, { retries });
		nock.cleanAll();
		nock.enableNetConnect();
	});
	return { scope: nock('https://api.github.com'), logged };
}

/**
 * Settles `promise`, skipping over every wait the retrying makes (it waits a second, then four, then nine, between attempts) rather than waiting.
 * @type {<T>(promise: Promise<T>) => Promise<PromiseSettledResult<T>>}
 */
async function instantly(promise) {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let settled = false;
		const result = Promise.allSettled([promise]).then(([outcome]) => {
			settled = true;
			return outcome;
		});
		/** @type {() => Promise<void>} */
		const advance = async () => {
			if (!settled) {
				await immediately();
				mock.timers.tick(10e3);
				await advance();
			}
		};
		await advance();
		return await result;
	} finally {
		mock.timers.reset();
	}
}

/** @type {(outcome: PromiseSettledResult<unknown>) => unknown} */
function statusOf(outcome) {
	return outcome.status === 'rejected' && outcome.reason && typeof outcome.reason === 'object' && 'status' in outcome.reason ? outcome.reason.status : null;
}

test('octokitFor: GitHub’s transient errors are retried', async (t) => {
	[false, true].forEach((isPrivate) => {
		const which = isPrivate ? 'private' : 'public';

		t.test(`${which}: a server error, then success`, async (st) => {
			const { scope, logged } = setup(st);
			scope.get('/repos/o/secret').reply(500, { message: 'o/secret is broken' });
			scope.get('/repos/o/secret').reply(502, { message: 'Bad Gateway' });
			scope.get('/repos/o/secret').reply(200, { full_name: 'o/secret' }); // eslint-disable-line camelcase

			const outcome = await instantly(octokitFor('ghs_test', isPrivate).rest.repos.get({ owner: 'o', repo: 'secret' }));

			st.equal(outcome.status === 'fulfilled' && outcome.value.data.full_name, 'o/secret', 'succeeds once GitHub does');
			st.ok(scope.isDone(), 'having asked three times');
			st.deepEqual(logged, [], 'logging nothing about it');
		});

		t.test(`${which}: a server error every time`, async (st) => {
			const { scope, logged } = setup(st);
			scope.get('/repos/o/secret').times(4).reply(503, { message: 'o/secret is unavailable' });

			const outcome = await instantly(octokitFor('ghs_test', isPrivate).rest.repos.get({ owner: 'o', repo: 'secret' }));

			st.equal(statusOf(outcome), 503, 'fails with the last error');
			st.ok(scope.isDone(), 'after asking four times: once, and three retries');
			st.deepEqual(logged, [], 'logging nothing about it');
		});

		t.test(`${which}: not reaching GitHub at all, then success`, async (st) => {
			const { scope } = setup(st);
			scope.get('/repos/o/secret').replyWithError('socket hang up');
			scope.get('/repos/o/secret').reply(200, { full_name: 'o/secret' }); // eslint-disable-line camelcase

			const outcome = await instantly(octokitFor('ghs_test', isPrivate).rest.repos.get({ owner: 'o', repo: 'secret' }));

			st.equal(outcome.status === 'fulfilled' && outcome.value.data.full_name, 'o/secret', 'succeeds once GitHub is reached');
			st.ok(scope.isDone(), 'having asked twice');
		});

		t.test(`${which}: GraphQL, a server error, then success`, async (st) => {
			const { scope } = setup(st);
			scope.post('/graphql').reply(502, { message: 'Bad Gateway' });
			scope.post('/graphql').reply(200, { data: { viewer: { login: 'x' } } });

			const outcome = await instantly(octokitFor('ghs_test', isPrivate).graphql('query { viewer { login } }'));

			st.deepEqual(outcome.status === 'fulfilled' && outcome.value, { viewer: { login: 'x' } }, 'succeeds once GitHub does');
			st.ok(scope.isDone(), 'having asked twice');
		});

		t.test(`${which}: GraphQL, GitHub’s own error, then success`, async (st) => {
			const { scope, logged } = setup(st);
			scope.post('/graphql').times(3).reply(200, { data: { r0: { name: 'secret' }, r1: null }, errors: [{ path: ['r1'], message: 'Something went wrong while executing your query. o/secret' }] });
			scope.post('/graphql').reply(200, { data: { r0: { name: 'secret' }, r1: { name: 'other' } } });

			const outcome = await instantly(octokitFor('ghs_test', isPrivate).graphql('query { r0: viewer { login } r1: viewer { login } }'));

			st.deepEqual(outcome.status === 'fulfilled' && outcome.value, { r0: { name: 'secret' }, r1: { name: 'other' } }, 'succeeds once GitHub does');
			st.ok(scope.isDone(), 'having asked four times');
			st.deepEqual(logged, [], 'logging nothing about it');
		});

		t.test(`${which}: GraphQL, GitHub’s own error every time`, async (st) => {
			const { scope } = setup(st);
			const partial = { r0: { name: 'secret' }, r1: null };
			scope.post('/graphql').times(4).reply(200, { data: partial, errors: [{ path: ['r1'], message: 'Something went wrong while executing your query.' }] });

			const outcome = await instantly(octokitFor('ghs_test', isPrivate).graphql('query { r0: viewer { login } r1: viewer { login } }'));

			st.equal(statusOf(outcome), 500, 'fails as a server error');
			st.deepEqual(outcome.status === 'rejected' && outcome.reason.response.data.data, partial, 'with the last attempt’s partial data on its response');
			st.ok(scope.isDone(), 'after asking four times');
		});

		[
			400,
			403,
			404,
			409,
			422,
			429,
		].forEach((status) => {
			t.test(`${which}: a client error (HTTP ${status}) is GitHub’s answer, not retried`, async (st) => {
				const { scope } = setup(st);
				scope.get('/repos/o/secret').reply(status, { message: 'no' });
				scope.get('/repos/o/secret').reply(200, { full_name: 'o/secret' }); // eslint-disable-line camelcase

				const outcome = await instantly(octokitFor('ghs_test', isPrivate).rest.repos.get({ owner: 'o', repo: 'secret' }));

				st.equal(statusOf(outcome), status, 'fails with it');
				st.equal(scope.pendingMocks().length, 1, 'having asked only once');
			});
		});
	});

	t.end();
});

test('a request that creates something is never retried, so never made twice', async (t) => {
	const issue = {
		number: 2,
		state: 'open',
		body: '<!-- report -->',
		user: { login: 'bot' },
		created_at: '2026-01-01T00:00:00Z', // eslint-disable-line camelcase
		html_url: 'https://github.com/o/r/issues/2', // eslint-disable-line camelcase
	};
	const report = {
		owner: 'o',
		repo: 'r',
		bot: 'bot',
		marker: '<!-- report -->',
		closing: 'fixed',
		unchanged: 'unchanged',
	};
	/** @type {[string, string, unknown[], (octokit: Octokit) => Promise<unknown>][]} */
	const creates = [
		[
			'a comment',
			'/repos/o/r/issues/1/comments',
			[],
			(octokit) => commentOnce({
				octokit,
				owner: 'o',
				name: 'r',
				number: 1,
				author: 'bot',
				marker: '<!-- m -->',
				body: 'hi',
			}),
		],
		[
			'a closed PR’s comment',
			'/repos/o/r/issues/1/comments',
			[],
			(octokit) => closePR({
				octokit,
				owner: 'o',
				name: 'r',
				number: 1,
				comment: 'bye',
			}),
		],
		[
			'a report’s issue',
			'/repos/o/r/issues',
			[],
			(octokit) => upsertReportIssue({ octokit, ...report, found: { title: 't', body: '<!-- report -->' } }),
		],
		[
			'a closed report issue’s comment',
			'/repos/o/r/issues/2/comments',
			[issue],
			(octokit) => upsertReportIssue({ octokit, ...report, found: null }),
		],
		[
			'a report’s gist',
			'/gists',
			[],
			(octokit) => upsertGist(octokit, { description: 'd', base: 'b' }, ['x']),
		],
		[
			'the merge queue’s variable',
			'/repos/o/r/actions/variables',
			[],
			(octokit) => writeQueue(octokit, { owner: 'o', repo: 'r', exists: false }, []),
		],
	];
	creates.forEach(([what, path, listed, create]) => {
		t.test(what, async (st) => {
			const { scope } = setup(st);
			scope.get(/./).times(2).reply(200, listed);
			let posted = 0;
			scope.post(path).times(2).reply(() => {
				posted += 1;
				return posted === 1 ? [502, { message: 'Bad Gateway' }] : [201, {}];
			});

			const outcome = await instantly(create(octokitFor('ghs_test', false)));

			st.equal(statusOf(outcome), 502, 'fails with GitHub’s server error');
			st.equal(posted, 1, 'having asked only once');
		});
	});

	t.end();
});

test('appAuth: asking for an installation token retries GitHub’s transient errors', async (t) => {
	t.test('a server error, then success', async (st) => {
		const { scope } = setup(st);
		scope.post('/app/installations/7/access_tokens').reply(500, { message: 'boom' });
		scope.post('/app/installations/7/access_tokens', { repositories: ['r'] }).reply(201, { token: 'ghs_retried', expires_at: '2099-01-01T00:00:00Z' }); // eslint-disable-line camelcase

		const outcome = await instantly(installationToken(appAuth('1', privateKey()), 7, { repositoryNames: ['r'] }));

		st.equal(outcome.status === 'fulfilled' && outcome.value, 'ghs_retried', 'gets the token once GitHub gives it');
		st.ok(scope.isDone(), 'having asked twice, the same way');
	});

	t.test('a client error is not retried', async (st) => {
		const { scope } = setup(st);
		scope.post('/app/installations/8/access_tokens').reply(422, { message: 'no' });
		scope.post('/app/installations/8/access_tokens').reply(201, { token: 'ghs_never', expires_at: '2099-01-01T00:00:00Z' }); // eslint-disable-line camelcase

		const outcome = await instantly(installationToken(appAuth('1', privateKey()), 8));

		st.equal(statusOf(outcome), 422, 'fails with it');
		st.equal(scope.pendingMocks().length, 1, 'having asked only once');
	});

	t.end();
});
