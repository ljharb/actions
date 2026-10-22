// Shared test suite for the `npm/install` and `vlt/install` `index.mjs` entry points. No top-level side effects.

import { mkdirSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';

import {
	makeSandbox,
	readBashArgs,
	readLog,
	readNockReport,
	readOutputs,
	repoRoot,
	runAction,
} from './helpers.mjs';

/**
 * @typedef {{
 *   nodeVersion: string,
 *   beforeInstall: string,
 *   cacheHit: string,
 *   afterInstall: string,
 *   skipLsCheck: string,
 *   npmInputs: Record<string, string>,
 * }} ArgSpec
 */

/**
 * @param {import('tape').Test} t
 * @param {{
 *   dir: string,
 *   baseEnv: Record<string, string>,
 *   expectedArgs: (spec: ArgSpec) => string[],
 * }} options
 */
export function runIndexSuite(t, { dir, baseEnv, expectedArgs }) {
	const script = `${dir}/index.mjs`;
	const commandSh = path.join(repoRoot, dir, 'command.sh');

	/** @param {Partial<ArgSpec>} spec */
	function args(spec) {
		return [commandSh].concat(expectedArgs({
			nodeVersion: 'lts/*',
			beforeInstall: '',
			cacheHit: '',
			afterInstall: '',
			skipLsCheck: 'false',
			npmInputs: {},
			...spec,
		}));
	}

	t.test('no cache key: runs command.sh with the inputs, and outputs PATH', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, baseEnv);

		st.equal(result.status, 0, 'exits successfully');
		st.deepEqual(readBashArgs(sandbox), args({}), 'bash is invoked with command.sh and the stringified inputs');
		st.equal(readLog(sandbox, 'bash.nvm-dir'), '/fake/nvm', 'NVM_DIR is set from the `nvm-dir` input');
		st.equal(
			realpathSync(String(readLog(sandbox, 'bash.cwd')).trim()),
			realpathSync(sandbox.cwd),
			'bash runs in the current working directory',
		);
		st.equal(readLog(sandbox, 'git.log'), null, 'git is not invoked without a cache key');
		st.ok(result.stdout.includes('got status code 0'), 'logs the status code');
		st.deepEqual(readOutputs(sandbox), { PATH: result.PATH }, 'sets the PATH output');

		const report = readNockReport(sandbox);
		st.deepEqual(report.requests, [], 'makes no HTTP requests');
		st.deepEqual(report.pending, [], 'no pending mocks');

		st.end();
	});

	t.test('passes through all the string and boolean inputs', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, {
			...baseEnv,
			'INPUT_NODE-VERSION': '0.8',
			INPUT_BEFORE_INSTALL: 'echo before',
			INPUT_AFTER_INSTALL: 'echo after',
			'INPUT_SKIP-LS-CHECK': 'true',
			'INPUT_SKIP-INSTALL': 'true',
			'INPUT_USE-NPM-CI': 'true',
			'INPUT_SKIP-LATEST-NPM': 'true',
		});

		st.equal(result.status, 0, 'exits successfully');
		st.deepEqual(
			readBashArgs(sandbox),
			args({
				nodeVersion: '0.8',
				beforeInstall: 'echo before',
				afterInstall: 'echo after',
				skipLsCheck: 'true',
				npmInputs: {
					skipInstall: 'true',
					useNpmCi: 'true',
					skipLatestNpm: 'true',
				},
			}),
			'bash receives every input',
		);

		st.end();
	});

	t.test('non-`true` boolean-ish inputs are passed as `false`', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, {
			...baseEnv,
			'INPUT_SKIP-LS-CHECK': 'yes',
			'INPUT_SKIP-INSTALL': 'TRUE',
			'INPUT_USE-NPM-CI': 'false',
			'INPUT_SKIP-LATEST-NPM': '1',
		});

		st.equal(result.status, 0, 'exits successfully');
		st.deepEqual(readBashArgs(sandbox), args({}), 'only the exact string `true` is truthy');

		st.end();
	});

	t.test('cache miss: restores nothing, still resets bundled deps via git, and does not save', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, {
			...baseEnv,
			'INPUT_CACHE-NODE-MODULES-KEY': 'my-cache-key',
			ACTIONS_CACHE_URL: 'https://cache.example.com/',
			ACTIONS_RUNTIME_TOKEN: 'runtime-token',
			TEST_NOCK_SCENARIO: 'miss',
		});

		st.equal(result.status, 0, 'exits successfully');
		st.equal(readLog(sandbox, 'git.log'), 'checkout -- node_modules\n', 'runs `git checkout -- node_modules`');
		st.equal(readLog(sandbox, 'order'), 'git\nbash\n', 'git runs before command.sh');
		st.deepEqual(readBashArgs(sandbox), args({}), 'cache-hit argument is empty');
		st.deepEqual(readOutputs(sandbox), { PATH: result.PATH }, 'sets the PATH output');

		const report = readNockReport(sandbox);
		st.equal(report.requests.length, 1, 'makes exactly one request');
		const [lookup] = report.requests;
		const url = new URL(lookup.path, 'https://cache.example.com');
		st.equal(url.pathname, '/_apis/artifactcache/cache', 'looks up the cache entry');
		st.equal(url.searchParams.get('keys'), 'my-cache-key', 'with the provided key');
		st.equal(lookup.authorization, 'Bearer runtime-token', 'using the runtime token');
		st.deepEqual(report.pending, [], 'no pending mocks');

		st.end();
	});

	t.test('cache miss: a failing `git checkout` is ignored', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, {
			...baseEnv,
			'INPUT_CACHE-NODE-MODULES-KEY': 'my-cache-key',
			ACTIONS_CACHE_URL: 'https://cache.example.com/',
			ACTIONS_RUNTIME_TOKEN: 'runtime-token',
			TEST_NOCK_SCENARIO: 'miss',
			FAKE_GIT_STATUS: '128',
		});

		st.equal(result.status, 0, 'exits successfully');
		st.equal(readLog(sandbox, 'git.log'), 'checkout -- node_modules\n', 'git was attempted');
		st.deepEqual(readBashArgs(sandbox), args({}), 'command.sh still runs');
		st.deepEqual(readOutputs(sandbox), { PATH: result.PATH }, 'sets the PATH output');

		st.end();
	});

	t.test('cache restore that rejects (invalid key) is treated as a miss', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, {
			...baseEnv,
			'INPUT_CACHE-NODE-MODULES-KEY': 'has,a,comma',
			ACTIONS_CACHE_URL: 'https://cache.example.com/',
			ACTIONS_RUNTIME_TOKEN: 'runtime-token',
		});

		st.equal(result.status, 0, 'exits successfully');
		st.equal(readLog(sandbox, 'git.log'), 'checkout -- node_modules\n', 'still runs `git checkout -- node_modules`');
		st.deepEqual(readBashArgs(sandbox), args({}), 'cache-hit argument is empty');
		st.notOk(result.stderr.includes('Validation'), 'the rejection is swallowed');
		st.deepEqual(readOutputs(sandbox), { PATH: result.PATH }, 'sets the PATH output');
		st.deepEqual(readNockReport(sandbox).requests, [], 'makes no HTTP requests');

		st.end();
	});

	t.test('cache hit: restores, passes the key to command.sh, then saves under that key', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);
		mkdirSync(path.join(sandbox.cwd, 'node_modules'));
		writeFileSync(path.join(sandbox.cwd, 'node_modules', 'marker.txt'), 'x');

		const result = runAction(script, sandbox, {
			...baseEnv,
			'INPUT_CACHE-NODE-MODULES-KEY': 'my-cache-key',
			ACTIONS_CACHE_URL: 'https://cache.example.com/',
			ACTIONS_RUNTIME_TOKEN: 'runtime-token',
			TEST_NOCK_SCENARIO: 'hit',
			TEST_NOCK_HIT_KEY: 'restored-key',
			TEST_NOCK_ARCHIVE_BODY: 'old archive contents',
			TEST_NOCK_EXPECT_SAVE: 'true',
		});

		st.equal(result.status, 0, 'exits successfully');
		st.equal(readLog(sandbox, 'extracted'), 'old archive contents', 'the downloaded archive is extracted');
		st.equal(
			readLog(sandbox, 'order'),
			'tar:-xf\ngit\nbash\ntar:--posix\n',
			'extracts, resets bundled deps, runs command.sh, then archives',
		);
		st.deepEqual(readBashArgs(sandbox), args({ cacheHit: 'restored-key' }), 'cache-hit argument is the restored key, not the input key');
		st.deepEqual(readOutputs(sandbox), { PATH: result.PATH }, 'sets the PATH output');

		const report = readNockReport(sandbox);
		st.deepEqual(report.pending, [], 'every expected request was made');
		st.deepEqual(
			report.requests.map(({ method, path: p }) => `${method} ${p.split('?')[0]}`),
			[
				'GET /_apis/artifactcache/cache',
				'GET /archive/cache.tgz',
				'POST /_apis/artifactcache/caches',
				'PATCH /_apis/artifactcache/caches/42',
				'POST /_apis/artifactcache/caches/42',
			],
			'looks up, downloads, reserves, uploads, and commits',
		);
		const lookup = new URL(report.requests[0].path, 'https://cache.example.com');
		st.equal(lookup.searchParams.get('keys'), 'my-cache-key', 'looks up the input key');
		const reserve = JSON.parse(report.requests[2].body);
		st.equal(reserve.key, 'restored-key', 'reserves the cache under the restored key, not the input key');
		st.equal(reserve.cacheSize, Buffer.byteLength('new archive contents'), 'with the new archive size');
		st.equal(report.requests[3].body, 'new archive contents', 'uploads the newly created archive');
		st.deepEqual(JSON.parse(report.requests[4].body), { size: Buffer.byteLength('new archive contents') }, 'commits the archive size');
		st.ok(report.requests.every(({ authorization }, i) => i === 1 || authorization === 'Bearer runtime-token'), 'cache service requests use the runtime token');

		st.end();
	});

	t.test('command.sh failure: exits with its status, logs it, and neither saves nor outputs', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);
		mkdirSync(path.join(sandbox.cwd, 'node_modules'));

		const result = runAction(script, sandbox, {
			...baseEnv,
			'INPUT_CACHE-NODE-MODULES-KEY': 'my-cache-key',
			ACTIONS_CACHE_URL: 'https://cache.example.com/',
			ACTIONS_RUNTIME_TOKEN: 'runtime-token',
			TEST_NOCK_SCENARIO: 'hit',
			TEST_NOCK_HIT_KEY: 'my-cache-key',
			TEST_NOCK_ARCHIVE_BODY: 'old archive contents',
			FAKE_BASH_STATUS: '3',
		});

		st.equal(result.status, 3, 'exits with the command.sh status');
		st.ok(result.stdout.includes('got status code 3'), 'logs the status code');
		st.equal(result.stderr.trim().split('\n').pop(), '3', 'prints the thrown status');
		st.deepEqual(readOutputs(sandbox), {}, 'does not set the PATH output');
		st.equal(readLog(sandbox, 'order'), 'tar:-xf\ngit\nbash\n', 'never archives node_modules');

		const report = readNockReport(sandbox);
		st.deepEqual(
			report.requests.map(({ method }) => method),
			['GET', 'GET'],
			'only looks up and downloads; never saves',
		);
		st.deepEqual(report.pending, [], 'no pending mocks');

		st.end();
	});

	t.test('command.sh killed by a signal: exits 1 without printing an error', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, {
			...baseEnv,
			FAKE_BASH_SIGNAL: 'true',
		});

		st.equal(result.status, 1, 'exits 1 when there is no status');
		st.ok(result.stdout.includes('got status code null'), 'logs the null status');
		st.equal(result.stderr, '', 'nothing is printed to stderr');
		st.deepEqual(readOutputs(sandbox), {}, 'does not set the PATH output');

		st.end();
	});

	t.test('missing `nvm-dir` input: fails before running command.sh', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const env = { ...baseEnv };
		delete env['INPUT_NVM-DIR'];
		const result = runAction(script, sandbox, env);

		st.equal(result.status, 1, 'exits 1');
		st.ok(result.stderr.includes('Input required and not supplied: nvm-dir'), 'prints the missing input error');
		st.equal(readBashArgs(sandbox), null, 'command.sh is not run');
		st.deepEqual(readOutputs(sandbox), {}, 'does not set the PATH output');

		st.end();
	});

	t.test('missing `node-version` input: fails before running command.sh', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const env = { ...baseEnv };
		delete env['INPUT_NODE-VERSION'];
		const result = runAction(script, sandbox, env);

		st.equal(result.status, 1, 'exits 1');
		st.ok(result.stderr.includes('Input required and not supplied: node-version'), 'prints the missing input error');
		st.equal(readBashArgs(sandbox), null, 'command.sh is not run');

		st.end();
	});
}
