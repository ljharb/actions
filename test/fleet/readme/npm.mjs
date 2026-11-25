import nock from 'nock';
import test from 'tape';

import { coveredStates, isOnNpm, lookupError } from '../../../fleet/readme/npm.mjs';
import { repoState } from '../drift/helpers/states.mjs';

/** @import { Test } from 'tape' */
/** @import { RepoState } from '../../../fleet/lib/app.mjs' */

// a failure is never retried here, so that one fails at once
const options = { fetchRetries: 0 };

const accept = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

/** @type {(t: Test) => nock.Scope} */
function registry(t) {
	nock.disableNetConnect();
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});
	return nock('https://registry.npmjs.org', { reqheaders: { accept } });
}

/** @type {(name: string, overrides?: Partial<RepoState>) => RepoState} */
function state(name, overrides = {}) {
	return repoState({
		name,
		repository: `ljharb/${name}`,
		packageJson: JSON.stringify({ name, version: '1.0.0' }),
		...overrides,
	});
}

test('isOnNpm', async (t) => {
	t.test('a package with a published version', async (st) => {
		const scope = registry(st).get('/pkg').reply(200, { name: 'pkg', versions: { '1.0.0': {} } });
		st.equal(await isOnNpm('pkg', options), true, 'is on npm');
		st.ok(scope.isDone(), 'asking the registry for its abbreviated packument');
	});

	t.test('a package the registry doesn’t know', async (st) => {
		registry(st).get('/pkg').reply(404, { error: 'Not found' });
		st.equal(await isOnNpm('pkg', options), false, 'isn’t on npm');
	});

	t.test('a package with no versions', async (st) => {
		registry(st).get('/pkg').reply(200, { name: 'pkg', versions: {} });
		st.equal(await isOnNpm('pkg', options), false, 'isn’t on npm, since it was never published, or every version was unpublished');
	});

	t.test('a scoped package', async (st) => {
		const scope = registry(st).get('/@scope%2fpkg').reply(200, { name: '@scope/pkg', versions: { '1.0.0': {} } });
		st.equal(await isOnNpm('@scope/pkg', options), true, 'is on npm');
		st.ok(scope.isDone(), 'asked for by its escaped name');
	});

	t.test('a name npm can’t take', async (st) => {
		registry(st);
		st.equal(await isOnNpm('.pkg', options), false, 'isn’t on npm, without asking the registry');
	});

	t.test('a registry that fails', async (st) => {
		registry(st).get('/pkg').reply(500, { error: 'oops' });
		await isOnNpm('pkg', options).then(
			() => st.fail('should reject'),
			(error) => st.equal(error.statusCode, 500, 'rejects, with the registry’s error'),
		);
	});
});

test('coveredStates', async (t) => {
	const scope = registry(t);
	// more than are looked up at once, so that they're looked up in turns
	const published = Array.from({ length: 12 }, (_, i) => `pkg-${i}`);
	published.forEach((name) => {
		scope.get(`/${name}`).reply(200, { versions: { '1.0.0': {} } });
	});
	scope.get('/unpublished').reply(404, { error: 'Not found' });
	scope.get('/failing').reply(500, { error: 'oops' });

	const states = published.map((name) => state(name)).concat(
		// a fork's source, with the same package, which is only looked up once
		state('pkg-0', { repository: 'source/pkg-0' }),
		state('unpublished'),
		state('failing'),
		state('archived', { archived: true }),
		state('unreadable', { stateError: 'could not read the repository’s state', packageJson: null }),
		state('invalid', { packageJson: '{ nope' }),
	);
	const covered = await coveredStates(states, options);

	t.ok(scope.isDone(), 'looks up each package the report would cover once');
	t.deepEqual(
		covered.map((s) => s.repository),
		published.map((name) => `ljharb/${name}`).concat(
			'source/pkg-0',
			'ljharb/failing',
			'ljharb/unreadable',
			'ljharb/invalid',
		),
		'leaves out what the report doesn’t cover, and each repository whose package isn’t on npm',
	);
	/** @type {(string | null)[]} */
	const fine = published.map(() => null);
	t.deepEqual(
		covered.map((s) => s.stateError),
		fine.concat(
			null,
			lookupError,
			'could not read the repository’s state',
			null,
		),
		'one whose package couldn’t be looked up has that as its error, without the registry’s',
	);
	t.equal(covered[0], states[0], 'one that’s on npm is as it was');
	t.equal(states[14].stateError, null, 'without changing the state it was given');
});
