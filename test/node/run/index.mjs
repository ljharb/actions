/* eslint camelcase: ["error", { "allow": ["^(?:before|after)_(?:install|success)$"] }] */

import path from 'path';
import { fileURLToPath } from 'url';

import test from 'tape';

import { runAction, repoRoot, CACHE_URL } from '../build/helpers/harness.mjs';

const script = 'node/run/index.mjs';
const commandSH = path.join(repoRoot, 'node/run/command.sh');
const setupNodeNVM = fileURLToPath(import.meta.resolve('setup-node-nvm'));

/** @type {(result: import('../build/helpers/harness.mjs').RunResult) => string[]} */
const requestURLs = (result) => result.report.requests.map(({ method, url }) => `${method} ${url}`);

test('node/run: setup-node-nvm failure exits early with its status', (t) => {
	const result = runAction(script, {
		inputs: {
			'use-npm-ci': 'false',
			command: 'test',
		},
		env: { FAKE_NODE_STATUS: '5' },
		fakes: ['node', 'bash'],
	});

	t.equal(result.status, 5, 'exits with setup-node-nvm’s status');
	t.deepEqual(result.calls('node').map((x) => x.args), [[setupNodeNVM]], 'runs setup-node-nvm with node');
	t.deepEqual(result.calls('bash'), [], 'bash is not invoked');
	t.equal(result.stdout, '', 'nothing logged');

	t.end();
});

test('node/run: setup-node-nvm killed by a signal exits 1', (t) => {
	const result = runAction(script, {
		inputs: {
			'use-npm-ci': 'false',
			command: 'test',
		},
		env: { FAKE_NODE_SIGNAL: '1' },
		fakes: ['node', 'bash'],
	});

	t.equal(result.status, 1, 'exits 1');
	t.deepEqual(result.calls('bash'), [], 'bash is not invoked');

	t.end();
});

test('node/run: `command` runs via npm run', (t) => {
	const result = runAction(script, {
		inputs: {
			'node-version': 'lts/*',
			'use-npm-ci': 'false',
			command: 'tests-only',
			before_install: 'echo before',
			after_install: 'echo after',
			'skip-ls-check': 'false',
			'skip-install': 'false',
		},
		fakes: ['node', 'bash', 'git'],
	});

	t.equal(result.status, 0, 'exits 0');
	t.equal(result.stderr, '', 'no stderr');
	t.deepEqual(result.report.requests, [], 'no requests without a cache key');
	t.deepEqual(result.report.unmatched, [], 'no unexpected requests');
	t.deepEqual(result.calls('git'), [], 'git is not invoked without a cache key');

	const bashCalls = result.calls('bash');
	t.equal(bashCalls.length, 1, 'bash is invoked once');
	t.deepEqual(bashCalls[0].args, [
		commandSH,
		'lts/*',
		'npm run "tests-only"',
		'echo before',
		'',
		'echo after',
		'false',
		'false',
		'install',
	], 'bash receives the script and inputs in order');
	t.equal(bashCalls[0].cwd, result.cwd, 'bash runs in the cwd');
	t.equal(bashCalls[0].nvmDir, result.nvmDir, 'bash inherits the environment');
	t.match(result.stdout, /^got status code 0$/m, 'logs the status code');
	t.deepEqual(result.outputs, {}, 'sets no outputs');

	t.end();
});

test('node/run: `shell-command` runs verbatim, with npm ci and flags', (t) => {
	const result = runAction(script, {
		inputs: {
			'node-version': '0.8',
			'use-npm-ci': 'true',
			'shell-command': 'echo hi && exit 0',
			'skip-ls-check': 'true',
			'skip-install': 'true',
		},
		fakes: ['node', 'bash'],
	});

	t.equal(result.status, 0, 'exits 0');
	t.deepEqual(result.calls('bash').map((x) => x.args), [[
		commandSH,
		'0.8',
		'echo hi && exit 0',
		'',
		'',
		'',
		'true',
		'true',
		'ci',
	]], 'passes the shell command, `ci`, and `true` flags');

	t.end();
});

test('node/run: `command` and `shell-command` are mutually exclusive', (t) => {
	const result = runAction(script, {
		inputs: {
			'node-version': '20',
			'use-npm-ci': 'false',
			command: 'test',
			'shell-command': 'echo hi',
		},
		fakes: ['node', 'bash'],
	});

	t.equal(result.status, 1, 'exits 1');
	t.match(result.stderr, /TypeError: `command` and `shell-command` are mutually exclusive/, 'logs the error');
	t.deepEqual(result.calls('bash'), [], 'bash is not invoked');

	t.end();
});

test('node/run: one of `command` or `shell-command` is required', (t) => {
	const result = runAction(script, {
		inputs: {
			'node-version': '20',
			'use-npm-ci': 'false',
		},
		fakes: ['node', 'bash'],
	});

	t.equal(result.status, 1, 'exits 1');
	t.match(result.stderr, /TypeError: One of `command` or `shell-command` must be provided/, 'logs the error');
	t.deepEqual(result.calls('bash'), [], 'bash is not invoked');

	t.end();
});

test('node/run: cache hit restores, runs, and saves', (t) => {
	const result = runAction(script, {
		inputs: {
			'node-version': '20',
			'use-npm-ci': 'false',
			command: 'test',
			'cache-node-modules-key': 'run-key',
		},
		fakes: ['node', 'bash', 'git', 'zstd'],
		cache: {
			mode: 'hit',
			key: 'run-key',
			cacheId: 9,
		},
	});

	t.equal(result.status, 0, 'exits 0');
	t.deepEqual(result.report.pending, [], 'all mocks consumed');
	t.deepEqual(result.report.unmatched, [], 'no unexpected requests');

	const urls = requestURLs(result);
	t.match(urls[0], new RegExp(`^GET ${CACHE_URL}_apis/artifactcache/cache\\?keys=run-key&version=[0-9a-f]+$`), 'looks up the cache key');
	t.deepEqual(urls.slice(1), [
		`GET ${CACHE_URL}archive.tgz`,
		`POST ${CACHE_URL}_apis/artifactcache/caches`,
		`PATCH ${CACHE_URL}_apis/artifactcache/caches/9`,
		`POST ${CACHE_URL}_apis/artifactcache/caches/9`,
	], 'downloads the archive, then reserves, uploads, and commits the cache');
	t.equal(JSON.parse(result.report.requests[2].body).key, 'run-key', 'saves under the restored key');
	t.deepEqual(result.calls('git').map((x) => x.args), [['checkout', '--', 'node_modules']], 'restores committed node_modules via git');

	const bashCalls = result.calls('bash');
	t.equal(bashCalls.length, 1, 'bash is invoked once');
	t.equal(bashCalls[0].args[4], 'run-key', 'the cache hit key is passed to the script');
	t.equal(bashCalls[0].restored, 'from cache run-key', 'node_modules is restored before the script runs');

	t.end();
});

test('node/run: cache miss with failing git, and restore rejection', (t) => {
	const miss = runAction(script, {
		inputs: {
			'node-version': '20',
			'use-npm-ci': 'false',
			command: 'test',
			'cache-node-modules-key': 'run-key',
		},
		env: { FAKE_GIT_STATUS: '128' },
		fakes: ['node', 'bash', 'git', 'zstd'],
		cache: { mode: 'miss' },
	});

	t.equal(miss.status, 0, 'miss: exits 0');
	t.deepEqual(miss.report.pending, [], 'miss: all mocks consumed');
	t.deepEqual(miss.report.unmatched, [], 'miss: no unexpected requests');
	t.equal(miss.report.requests.length, 1, 'miss: only the lookup is made; nothing is saved');
	t.equal(miss.calls('git').length, 1, 'miss: git checkout is attempted');
	t.equal(miss.calls('bash')[0].args[4], '', 'miss: no cache hit is passed to the script');

	const rejected = runAction(script, {
		inputs: {
			'node-version': '20',
			'use-npm-ci': 'false',
			command: 'test',
			'cache-node-modules-key': 'bad,key',
		},
		fakes: ['node', 'bash', 'git'],
	});

	t.equal(rejected.status, 0, 'rejection: exits 0');
	t.deepEqual(rejected.report.requests, [], 'rejection: no requests');
	t.equal(rejected.calls('bash')[0].args[4], '', 'rejection: no cache hit is passed to the script');

	t.end();
});

test('node/run: script failure', (t) => {
	const result = runAction(script, {
		inputs: {
			'node-version': '20',
			'use-npm-ci': 'false',
			command: 'test',
			'cache-node-modules-key': 'run-key',
		},
		env: { FAKE_BASH_STATUS: '4' },
		fakes: ['node', 'bash', 'git', 'zstd'],
		cache: {
			mode: 'hit',
			key: 'run-key',
			cacheId: 9,
		},
	});

	t.equal(result.status, 4, 'exits with the script’s status code');
	t.match(result.stdout, /^got status code 4$/m, 'logs the status code');
	t.equal(result.stderr.trim(), '4', 'logs the thrown status');
	t.deepEqual(
		requestURLs(result).filter((x) => x.startsWith(`POST ${CACHE_URL}`) || x.startsWith(`PATCH ${CACHE_URL}`)),
		[],
		'does not save the cache',
	);

	t.end();
});

test('node/run: script killed by a signal', (t) => {
	const result = runAction(script, {
		inputs: {
			'node-version': '20',
			'use-npm-ci': 'false',
			command: 'test',
		},
		env: { FAKE_BASH_SIGNAL: '1' },
		fakes: ['node', 'bash'],
	});

	t.equal(result.status, 1, 'exits 1');
	t.match(result.stdout, /^got status code null$/m, 'logs the null status code');
	t.equal(result.stderr, '', 'a null rejection is not logged');

	t.end();
});

test('node/run: missing required inputs', (t) => {
	const noVersion = runAction(script, {
		inputs: {
			'use-npm-ci': 'false',
			command: 'test',
		},
		fakes: ['node', 'bash'],
	});

	t.equal(noVersion.status, 1, 'node-version: exits 1');
	t.match(noVersion.stderr, /Input required and not supplied: node-version/, 'node-version: logs the error');
	t.deepEqual(noVersion.calls('bash'), [], 'node-version: bash is not invoked');

	const noCI = runAction(script, {
		inputs: {
			'node-version': '20',
			command: 'test',
		},
		fakes: ['node', 'bash'],
	});

	t.equal(noCI.status, 1, 'use-npm-ci: exits 1');
	t.match(noCI.stderr, /Input required and not supplied: use-npm-ci/, 'use-npm-ci: throws at module evaluation');
	t.equal(noCI.calls('node').length, 1, 'use-npm-ci: setup-node-nvm already ran');
	t.deepEqual(noCI.calls('bash'), [], 'use-npm-ci: bash is not invoked');

	t.end();
});
