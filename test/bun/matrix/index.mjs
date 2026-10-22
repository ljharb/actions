import { fileURLToPath } from 'url';

import test from 'tape';

import { runAction } from '../../node/matrix/index/run.mjs';

/* eslint camelcase: 0 */

const script = fileURLToPath(new URL('../../../bun/matrix/index.mjs', import.meta.url));
const versionsSetup = new URL('fixtures/versions-setup.mjs', import.meta.url).href;

const eventPayload = { ref: 'refs/heads/main' };

/** @type {(inputs: Record<string, string>, versions?: string[]) => import('../../node/matrix/index/run.mjs').RunResult} */
function run(inputs, versions) {
	return runAction(script, {
		inputs,
		eventPayload,
		...versions && {
			imports: [versionsSetup],
			env: { BUN_MATRIX_VERSIONS: JSON.stringify(versions) },
		},
	});
}

/** @type {(t: import('tape').Test, result: import('../../node/matrix/index/run.mjs').RunResult, message: string) => void} */
function assertFailure(t, result, message) {
	t.equal(result.status, 1, 'exits with failure');
	t.ok(result.stdout.includes(`::error::${message}`), `reports error: ${message}`);
	t.deepEqual(result.outputs, {}, 'sets no outputs');
}

/** @type {(t: import('tape').Test, result: import('../../node/matrix/index/run.mjs').RunResult) => { requireds: unknown, optionals: unknown }} */
function parsedOutputs(t, result) {
	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(Object.keys(result.outputs).sort(), ['optionals', 'requireds'], 'sets exactly `requireds` and `optionals`');
	t.ok(result.stdout.includes(`requireds: ${result.outputs.requireds}`), 'logs `requireds`');
	t.ok(result.stdout.includes(`optionals: ${result.outputs.optionals}`), 'logs `optionals`');
	t.ok(result.stdout.includes(`The event payload: ${JSON.stringify(eventPayload, null, '\t')}`), 'logs the event payload');
	return {
		requireds: JSON.parse(result.outputs.requireds),
		optionals: JSON.parse(result.outputs.optionals),
	};
}

test('bun/matrix: input validation', (t) => {
	t.test('`envs` and `versionsAsRoot` together', (st) => {
		assertFailure(st, run({ range: 'latest', envs: '{"A":"1"}', versionsAsRoot: 'true' }), '`envs` and `versionsAsRoot` are mutually exclusive');
		st.end();
	});

	t.test('invalid `envs` JSON', (st) => {
		const result = run({ range: 'latest', envs: '{nope' });
		st.equal(result.status, 1, 'exits with failure');
		st.match(result.stdout, /::error::.*JSON/, 'reports the JSON parse error');
		st.deepEqual(result.outputs, {}, 'sets no outputs');
		st.end();
	});

	t.test('invalid `range`', (st) => {
		assertFailure(st, run({ range: 'not a range' }), '`range`, if provided, must be a valid semver range or "latest"');
		st.end();
	});

	t.test('invalid `type`', (st) => {
		assertFailure(st, run({ range: 'latest', type: 'patches' }), '`type` must be "majors" or "minors"');
		st.end();
	});

	t.end();
});

test('bun/matrix: `latest`', (t) => {
	t.test('with `version_key`', (st) => {
		st.deepEqual(parsedOutputs(st, run({ range: 'latest', version_key: 'bun-version' })), {
			requireds: { 'bun-version': ['latest'] },
			optionals: { 'bun-version': [] },
		}, 'requires only `latest`');
		st.end();
	});

	t.test('with `envs` and `type`', (st) => {
		st.deepEqual(parsedOutputs(st, run({
			range: 'latest',
			version_key: 'bun-version',
			envs: '{"FOO":"bar"}',
			type: 'majors',
		})), {
			requireds: { envs: { FOO: 'bar' }, 'bun-version': ['latest'] },
			optionals: { envs: { FOO: 'bar' }, 'bun-version': [] },
		}, 'includes `envs`');
		st.end();
	});

	t.test('with `versionsAsRoot`', (st) => {
		st.deepEqual(parsedOutputs(st, run({ range: 'latest', versionsAsRoot: 'true', type: 'minors' })), {
			requireds: ['latest'],
			optionals: [],
		}, 'outputs bare arrays');
		st.end();
	});

	t.end();
});

test('bun/matrix: semver ranges, with only the hardcoded `latest` version available', (t) => {
	t.test('minors', (st) => {
		st.deepEqual(parsedOutputs(st, run({ range: '>= 1', version_key: 'bun-version' })), {
			requireds: { 'bun-version': [] },
			optionals: { 'bun-version': [] },
		}, 'no concrete versions match');
		st.end();
	});

	t.test('majors', (st) => {
		st.deepEqual(parsedOutputs(st, run({ range: '*', type: 'majors', versionsAsRoot: 'true' })), {
			requireds: [],
			optionals: [],
		}, 'no concrete versions match');
		st.end();
	});

	t.test('empty range', (st) => {
		st.deepEqual(parsedOutputs(st, run({ versionsAsRoot: 'true' })), {
			requireds: [],
			optionals: [],
		}, 'an empty range is valid, and matches nothing');
		st.end();
	});

	t.end();
});

/*
 * `getVersions` is hardcoded to `['latest']`, so the version-bucketing logic can only be exercised by injecting a version list.
 * The preload replaces the result of `semver.sort` on exactly `['latest']`, simulating the commented-out version index fetch.
 */
const versions = [
	'1.1.2',
	'1.1.1',
	'1.1.0',
	'1.0.30',
	'1.0.0',
	'0.8.1',
	'0.8.0',
	'0.7.3',
	'0.6.0',
];

test('bun/matrix: semver ranges, with injected versions', (t) => {
	t.test('minors', (st) => {
		st.deepEqual(parsedOutputs(st, run({ range: '>= 0.7', versionsAsRoot: 'true' }, versions)), {
			requireds: ['1.1'],
			optionals: ['1.0', '0.8', '0.7'],
		}, 'the latest minor of each >= 1 major is required; older minors and pre-1.0 minors are optional');
		st.end();
	});

	t.test('minors, explicit', (st) => {
		st.deepEqual(parsedOutputs(st, run({ range: '^1', type: 'minors', versionsAsRoot: 'true' }, versions)), {
			requireds: ['1.1'],
			optionals: ['1.0'],
		}, 'only matching minors');
		st.end();
	});

	t.test('majors', (st) => {
		st.deepEqual(parsedOutputs(st, run({ range: '>= 0.7', type: 'majors', versionsAsRoot: 'true' }, versions)), {
			requireds: ['1'],
			optionals: ['0.8', '0.7'],
		}, '>= 1 majors are required; pre-1.0 minors are optional');
		st.end();
	});

	t.end();
});
