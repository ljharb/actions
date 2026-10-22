/* eslint camelcase: ["error", { "allow": ["^(?:before|after)_(?:install|success)$"] }] */

import fs from 'fs';
import path from 'path';

import test from 'tape';

import { runAction, repoRoot, CACHE_URL } from './harness.mjs';

const NVM_VERSION = 'v0.40.3';

/** @type {(result: import('./harness.mjs').RunResult) => string[]} */
const requestURLs = (result) => result.report.requests.map(({ method, url }) => `${method} ${url}`);

const nvmRequests = [
	'GET https://github.com/nvm-sh/nvm/releases/latest',
	`GET https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/nvm.sh`,
	`GET https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/nvm-exec`,
];

/**
 * Registers the tests shared by the `installNVM`-based entry points
 * (`node/build/index.mjs` and `node/engines/index.mjs`), which are identical apart
 * from how they compute the exit code.
 * @type {(script: string) => void}
 */
export default function installSuite(script) {
	const commandSH = path.join(repoRoot, path.dirname(script), 'command.sh');

	test(`${script}: success, no cache key`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': 'lts/*',
				'use-npm-ci': 'false',
				before_install: 'echo before',
				after_install: 'echo after',
				'skip-ls-check': 'false',
				'skip-install': 'false',
				'skip-latest-npm': 'false',
			},
			fakes: ['bash', 'git'],
			nvmVersion: NVM_VERSION,
		});

		t.equal(result.status, 0, 'exits 0');
		t.equal(result.stderr, '', 'no stderr');
		t.deepEqual(requestURLs(result), nvmRequests, 'downloads the latest nvm, and nothing else');
		t.deepEqual(result.report.pending, [], 'all mocks consumed');
		t.deepEqual(result.report.unmatched, [], 'no unexpected requests');
		t.equal(
			fs.readFileSync(path.join(result.nvmDir, 'nvm.sh'), 'utf8'),
			`# fake nvm.sh ${NVM_VERSION}\n`,
			'nvm.sh is written into NVM_DIR',
		);
		t.equal(
			fs.readFileSync(path.join(result.nvmDir, 'nvm-exec'), 'utf8'),
			`# fake nvm-exec ${NVM_VERSION}\n`,
			'nvm-exec is written into NVM_DIR',
		);

		const bashCalls = result.calls('bash');
		t.equal(bashCalls.length, 1, 'bash is invoked once');
		t.deepEqual(bashCalls[0].args, [
			commandSH,
			'lts/*',
			'echo before',
			'',
			'echo after',
			'false',
			'false',
			'install',
			'false',
		], 'bash receives the script and inputs in order');
		t.equal(bashCalls[0].cwd, result.cwd, 'bash runs in the cwd');
		t.equal(bashCalls[0].nvmDir, result.nvmDir, 'bash gets NVM_DIR');
		t.deepEqual(result.calls('git'), [], 'git is not invoked without a cache key');
		t.match(result.stdout, /^got status code 0$/m, 'logs the status code');
		t.deepEqual(result.outputs, { PATH: result.envPATH }, 'outputs PATH');

		t.end();
	});

	test(`${script}: boolean inputs and npm ci`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': '0.8',
				'use-npm-ci': 'true',
				'skip-ls-check': 'true',
				'skip-install': 'true',
				'skip-latest-npm': 'true',
			},
			fakes: ['bash'],
			nvmVersion: NVM_VERSION,
		});

		t.equal(result.status, 0, 'exits 0');
		t.deepEqual(result.calls('bash').map((x) => x.args), [[
			commandSH,
			'0.8',
			'',
			'',
			'',
			'true',
			'true',
			'ci',
			'true',
		]], 'passes `ci` and `true` flags');

		t.end();
	});

	test(`${script}: non-"true" use-npm-ci means npm install`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': '20',
				'use-npm-ci': 'TRUE',
			},
			fakes: ['bash'],
			nvmVersion: NVM_VERSION,
		});

		t.equal(result.status, 0, 'exits 0');
		t.equal(result.calls('bash')[0].args[7], 'install', 'only exactly `true` selects `npm ci`');

		t.end();
	});

	test(`${script}: cache hit restores, runs, and saves`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': '20',
				'use-npm-ci': 'false',
				'cache-node-modules-key': 'deps-key',
			},
			fakes: ['bash', 'git', 'zstd'],
			nvmVersion: NVM_VERSION,
			cache: {
				mode: 'hit',
				key: 'deps-key',
				cacheId: 42,
			},
		});

		t.equal(result.status, 0, 'exits 0');
		t.deepEqual(result.report.pending, [], 'all mocks consumed');
		t.deepEqual(result.report.unmatched, [], 'no unexpected requests');

		const urls = requestURLs(result);
		t.deepEqual(urls.slice(0, 3), nvmRequests, 'downloads nvm first');
		t.match(urls[3], new RegExp(`^GET ${CACHE_URL}_apis/artifactcache/cache\\?keys=deps-key&version=[0-9a-f]+$`), 'looks up the cache key');
		t.deepEqual(urls.slice(4), [
			`GET ${CACHE_URL}archive.tgz`,
			`POST ${CACHE_URL}_apis/artifactcache/caches`,
			`PATCH ${CACHE_URL}_apis/artifactcache/caches/42`,
			`POST ${CACHE_URL}_apis/artifactcache/caches/42`,
		], 'downloads the archive, then reserves, uploads, and commits the cache');
		t.equal(JSON.parse(result.report.requests[5].body).key, 'deps-key', 'saves under the restored key');

		t.deepEqual(result.calls('git').map((x) => x.args), [['checkout', '--', 'node_modules']], 'restores committed node_modules via git');
		t.equal(result.calls('git')[0].restored, 'from cache deps-key', 'git checkout runs after the cache is extracted');

		const bashCalls = result.calls('bash');
		t.equal(bashCalls.length, 1, 'bash is invoked once');
		t.equal(bashCalls[0].args[3], 'deps-key', 'the cache hit key is passed to the script');
		t.equal(bashCalls[0].restored, 'from cache deps-key', 'node_modules is restored before the script runs');
		t.match(result.stdout, /^Cache saved successfully$/m, 'cache is saved');
		t.deepEqual(result.outputs, { PATH: result.envPATH }, 'outputs PATH');

		t.end();
	});

	test(`${script}: cache miss, and git checkout failure is ignored`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': '20',
				'use-npm-ci': 'false',
				'cache-node-modules-key': 'deps-key',
			},
			env: { FAKE_GIT_STATUS: '1' },
			fakes: ['bash', 'git', 'zstd'],
			nvmVersion: NVM_VERSION,
			cache: { mode: 'miss' },
		});

		t.equal(result.status, 0, 'exits 0');
		t.deepEqual(result.report.pending, [], 'all mocks consumed');
		t.deepEqual(result.report.unmatched, [], 'no unexpected requests');
		t.deepEqual(
			requestURLs(result).filter((x) => x.includes(CACHE_URL)).map((x) => x.replace(/\?.*$/, '')),
			[`GET ${CACHE_URL}_apis/artifactcache/cache`],
			'only looks up the cache; does not save on a miss',
		);
		t.equal(result.calls('git').length, 1, 'git checkout is attempted');
		t.equal(result.calls('bash')[0].args[3], '', 'no cache hit is passed to the script');
		t.deepEqual(result.outputs, { PATH: result.envPATH }, 'outputs PATH');

		t.end();
	});

	test(`${script}: cache restore rejection is swallowed`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': '20',
				'use-npm-ci': 'false',
				'cache-node-modules-key': 'invalid,key',
			},
			fakes: ['bash', 'git'],
			nvmVersion: NVM_VERSION,
		});

		t.equal(result.status, 0, 'exits 0 despite the ValidationError from restoreCache');
		t.deepEqual(requestURLs(result), nvmRequests, 'no cache requests are made');
		t.equal(result.calls('git').length, 1, 'git checkout is still attempted');
		t.equal(result.calls('bash')[0].args[3], '', 'no cache hit is passed to the script');
		t.deepEqual(result.outputs, { PATH: result.envPATH }, 'outputs PATH');

		t.end();
	});

	test(`${script}: script failure`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': '20',
				'use-npm-ci': 'false',
				'cache-node-modules-key': 'deps-key',
			},
			env: { FAKE_BASH_STATUS: '3' },
			fakes: ['bash', 'git', 'zstd'],
			nvmVersion: NVM_VERSION,
			cache: {
				mode: 'hit',
				key: 'deps-key',
				cacheId: 7,
			},
		});

		t.equal(result.status, 3, 'exits with the script’s status code');
		t.match(result.stdout, /^got status code 3$/m, 'logs the status code');
		t.equal(result.stderr.trim(), '3', 'logs the thrown status');
		t.deepEqual(
			requestURLs(result).filter((x) => x.startsWith(`POST ${CACHE_URL}`) || x.startsWith(`PATCH ${CACHE_URL}`)),
			[],
			'does not save the cache',
		);
		t.deepEqual(result.outputs, {}, 'does not output PATH');

		t.end();
	});

	test(`${script}: script killed by a signal`, (t) => {
		const result = runAction(script, {
			inputs: {
				'node-version': '20',
				'use-npm-ci': 'false',
			},
			env: { FAKE_BASH_SIGNAL: '1' },
			fakes: ['bash'],
			nvmVersion: NVM_VERSION,
		});

		t.equal(result.status, 1, 'exits 1');
		t.match(result.stdout, /^got status code null$/m, 'logs the null status code');
		t.equal(result.stderr, '', 'a null rejection is not logged');
		t.deepEqual(result.outputs, {}, 'does not output PATH');

		t.end();
	});

	test(`${script}: missing node-version`, (t) => {
		const result = runAction(script, {
			inputs: { 'use-npm-ci': 'false' },
			fakes: ['bash'],
			nvmVersion: NVM_VERSION,
		});

		t.equal(result.status, 1, 'exits 1');
		t.match(result.stderr, /Input required and not supplied: node-version/, 'logs the error');
		t.deepEqual(result.calls('bash'), [], 'bash is not invoked');
		t.deepEqual(result.outputs, {}, 'does not output PATH');

		t.end();
	});

	test(`${script}: missing use-npm-ci`, (t) => {
		const result = runAction(script, {
			inputs: { 'node-version': '20' },
			fakes: ['bash'],
		});

		t.equal(result.status, 1, 'exits 1');
		t.match(result.stderr, /Input required and not supplied: use-npm-ci/, 'throws at module evaluation');
		t.deepEqual(result.report.requests, [], 'makes no requests');
		t.deepEqual(result.calls('bash'), [], 'bash is not invoked');

		t.end();
	});
}
