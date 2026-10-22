import { fileURLToPath } from 'url';

import test from 'tape';

import { runAction } from './index/run.mjs';

/* eslint camelcase: 0 */

const script = fileURLToPath(new URL('../../../node/matrix/index.mjs', import.meta.url));
const nockSetup = new URL('index/nock-setup.mjs', import.meta.url).href;

const allFetched = 'NOCK_PENDING=[]';
const noneFetched = 'NOCK_PENDING=["GET https://raw.githubusercontent.com:443/ljharb/actions/nodejs/index.json","GET https://raw.githubusercontent.com:443/ljharb/actions/iojs/index.json"]';

const eventPayload = { action: 'opened', number: 42 };

/** @type {(inputs: Record<string, string>, mode?: string) => import('./index/run.mjs').RunResult} */
function run(inputs, mode = 'ok') {
	return runAction(script, {
		inputs,
		imports: [nockSetup],
		env: { NODE_MATRIX_NOCK: mode },
		eventPayload,
	});
}

/** @type {(t: import('tape').Test, result: import('./index/run.mjs').RunResult, message: string) => void} */
function assertFailure(t, result, message) {
	t.equal(result.status, 1, 'exits with failure');
	t.ok(result.stdout.includes(`::error::${message}`), `reports error: ${message}`);
	t.deepEqual(result.outputs, {}, 'sets no outputs');
	t.ok(result.stderr.includes(noneFetched), 'makes no network requests');
}

/** @type {(t: import('tape').Test, result: import('./index/run.mjs').RunResult) => { requireds: unknown, optionals: unknown }} */
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

test('node/matrix: input validation', (t) => {
	t.test('`envs` and `versionsAsRoot` together', (st) => {
		assertFailure(st, run({ envs: '{"A":"1"}', versionsAsRoot: 'true', preset: '>= 20' }), '`envs` and `versionsAsRoot` are mutually exclusive');
		st.end();
	});

	t.test('invalid `envs` JSON', (st) => {
		const result = run({ envs: '{nope', preset: '>= 20' });
		st.equal(result.status, 1, 'exits with failure');
		st.match(result.stdout, /::error::.*JSON/, 'reports the JSON parse error');
		st.deepEqual(result.outputs, {}, 'sets no outputs');
		st.end();
	});

	t.test('`preset` with `requireds`', (st) => {
		assertFailure(st, run({ preset: '>= 20', requireds: '>= 20' }), 'if `preset` is provided, `requireds` and `optionals` must not be');
		st.end();
	});

	t.test('`preset` with `optionals`', (st) => {
		assertFailure(st, run({ preset: '>= 20', optionals: '>= 20' }), 'if `preset` is provided, `requireds` and `optionals` must not be');
		st.end();
	});

	t.test('`notable` without `preset`', (st) => {
		assertFailure(st, run({ requireds: '>= 20', optionals: '< 20', notable: '^22' }), '`notable` may only be provided if `preset` is provided');
		st.end();
	});

	t.test('invalid `type`', (st) => {
		assertFailure(st, run({ preset: '>= 20', type: 'patches' }), '`type` must be "majors" or "minors"');
		st.end();
	});

	t.test('invalid `preset`', (st) => {
		assertFailure(st, run({ preset: 'not a range' }), '`preset`, if provided, must be a valid semver range, or one of: `0.x, iojs` (got `not a range`');
		st.end();
	});

	t.test('invalid `requireds`', (st) => {
		assertFailure(st, run({ requireds: 'not a range', optionals: '< 20' }), '`requireds` and `optionals` must both be valid semver ranges');
		st.end();
	});

	t.test('invalid `optionals`', (st) => {
		assertFailure(st, run({ requireds: '>= 20', optionals: 'not a range' }), '`requireds` and `optionals` must both be valid semver ranges');
		st.end();
	});

	t.test('`0.x` preset with a `type`', (st) => {
		assertFailure(st, run({ preset: '0.x', type: 'majors' }), 'the `0.x` preset is incompatible with `type`');
		st.end();
	});

	t.end();
});

test('node/matrix: `empty`', (t) => {
	t.test('default key', (st) => {
		const result = run({ empty: 'true', preset: 'not validated when empty' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { 'node-version': [] },
			optionals: { 'node-version': [] },
		}, 'outputs empty lists under `node-version`');
		st.ok(result.stderr.includes(noneFetched), 'makes no network requests');
		st.end();
	});

	t.test('with `envs` and a custom key', (st) => {
		const result = run({ empty: 'true', envs: '{"FOO":"bar"}', version_key: 'node' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { envs: { FOO: 'bar' }, node: [] },
			optionals: { envs: { FOO: 'bar' }, node: [] },
		}, 'outputs `envs` alongside the empty lists under the custom key');
		st.end();
	});

	t.test('with `versionsAsRoot`', (st) => {
		const result = run({ empty: 'true', versionsAsRoot: 'true' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: [],
			optionals: [],
		}, 'outputs bare empty arrays');
		st.end();
	});

	t.test('`empty` other than `true` is ignored', (st) => {
		const result = run({ empty: 'yes', preset: '0.x' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { 'node-version': ['0.12', '0.10', '0.8'] },
			optionals: { 'node-version': ['0.11', '0.9'] },
		}, 'computes the preset');
		st.end();
	});

	t.end();
});

test('node/matrix: presets', (t) => {
	t.test('`0.x`', (st) => {
		const result = run({ preset: '0.x' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { 'node-version': ['0.12', '0.10', '0.8'] },
			optionals: { 'node-version': ['0.11', '0.9'] },
		}, 'outputs the hardcoded 0.x versions');
		st.ok(result.stderr.includes(allFetched), 'still fetches both version indexes, to compute `notable`');
		st.end();
	});

	t.test('`iojs`', (st) => {
		const result = run({ preset: 'iojs' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { 'node-version': ['3.3', '2.5', '1.8'] },
			optionals: { 'node-version': ['1.0'] },
		}, 'outputs io.js versions');
		st.ok(result.stderr.includes(allFetched), 'fetches both version indexes');
		st.end();
	});

	t.test('semver range, `majors`', (st) => {
		const result = run({ preset: '>= 0.8', type: 'majors' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { 'node-version': ['24', '22', '20', '3', '2', '1', '0.12', '0.10', '0.8'] },
			optionals: { 'node-version': ['0.11', '0.9'] },
		}, 'outputs majors');
		st.ok(result.stderr.includes(allFetched), 'fetches both version indexes');
		st.end();
	});

	t.test('semver range, `minors`, `notable`, `fullSemver`, versionsAsRoot', (st) => {
		const result = run({
			preset: '>= 20',
			type: 'minors',
			notable: '^22',
			fullSemver: 'true',
			versionsAsRoot: 'true',
		});
		/*
		 * This asserts current, apparently buggy, behavior: `addNotable` in versions.mjs always calls `getReqOpts` with `fullSemver` false,
		 * so the notable version stays major.minor (`22.4`) next to its full-semver form (`22.4.0`), producing a mixed-precision duplicate.
		 */
		st.deepEqual(parsedOutputs(st, result), {
			requireds: ['24.1.0', '22.4', '22.4.0', '20.1.0'],
			optionals: ['24.0.0', '20.0.0'],
		}, 'outputs full semver minors at the root, plus notable versions (currently not full semver, so `22.4` duplicates `22.4.0`)');
		st.end();
	});

	t.end();
});

test('node/matrix: `requireds` and `optionals`', (t) => {
	t.test('minors (default type)', (st) => {
		const result = run({ requireds: '>= 20', optionals: '< 20' });
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { 'node-version': ['24.1', '24.0', '22.4', '20.1', '20.0', '3.3', '2.5', '1.8', '1.0', '0.12', '0.11', '0.10', '0.9', '0.8'] },
			optionals: { 'node-version': [] },
		}, 'outputs every matching minor as required');
		st.ok(result.stderr.includes(allFetched), 'fetches both version indexes');
		st.end();
	});

	t.test('majors, with `envs`', (st) => {
		const result = run({
			requireds: '>= 22',
			optionals: '^20',
			type: 'majors',
			envs: '{"X":"y"}',
		});
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { envs: { X: 'y' }, 'node-version': ['24', '22'] },
			optionals: { envs: { X: 'y' }, 'node-version': ['20'] },
		}, 'outputs majors with `envs`');
		st.end();
	});

	t.test('no inputs at all', (st) => {
		const result = run({});
		st.deepEqual(parsedOutputs(st, result), {
			requireds: { 'node-version': [] },
			optionals: { 'node-version': [] },
		}, 'empty ranges are valid, and match nothing');
		st.ok(result.stderr.includes(allFetched), 'fetches both version indexes');
		st.end();
	});

	t.test('version index fetch failure', (st) => {
		const result = run({ requireds: '>= 20', optionals: '< 20' }, 'fail');
		st.equal(result.status, 1, 'exits with failure');
		st.ok(result.stderr.includes('Error fetching and parsing JSON from `https://raw.githubusercontent.com/ljharb/actions/nodejs/index.json`'), 'logs which URL failed');
		st.ok(result.stdout.includes('::error::'), 'reports a failure');
		st.deepEqual(result.outputs, {}, 'sets no outputs');
		st.end();
	});

	t.end();
});
