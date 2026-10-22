import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import test from 'tape';

import {
	repoRoot,
	runScript,
	readCommandFile,
	tmpDir,
} from './helpers.mjs';
import { ARCHIVE_URL, CACHE_URL, NVM_TAG } from './nock-setup.mjs';

const script = path.join(repoRoot, 'node', 'install', 'index.mjs');
const commandSh = path.join(repoRoot, 'node', 'install', 'command.sh');

const cacheEnv = {
	ACTIONS_CACHE_URL: CACHE_URL,
	ACTIONS_RUNTIME_TOKEN: 'fake-token',
};

/** @type {(dir: string) => string} */
function nvmDirIn(dir) {
	return path.join(dir, 'nvm');
}

/** @type {(t: import('tape').Test, result: import('./helpers.mjs').RunResult, nvmDir: string) => void} */
function assertNVMInstalled(t, result, nvmDir) {
	t.equal(fs.readFileSync(path.join(nvmDir, 'nvm.sh'), 'utf8'), '# fake nvm.sh\n', 'nvm.sh is downloaded into NVM_DIR');
	t.equal(fs.readFileSync(path.join(nvmDir, 'nvm-exec'), 'utf8'), '# fake nvm-exec\n', 'nvm-exec is downloaded into NVM_DIR');
	t.equal(readCommandFile(result.githubEnv, 'NVM_DIR'), nvmDir, 'NVM_DIR is exported');
}

test('node/install: defaults, no cache key', (t) => {
	const dir = tmpDir(t, 'defaults');
	const nvmDir = nvmDirIn(dir);
	const result = runScript(t, script, {
		dir,
		env: {
			NVM_DIR: nvmDir,
			'INPUT_NODE-VERSION': 'lts/*',
		},
	});

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(result.report.pending, [], 'all mocked requests were made');
	t.deepEqual(result.report.unmatched, [], 'no unexpected requests');
	t.deepEqual(
		result.report.requests.map(({ method, url }) => `${method} ${url}`).sort(),
		[
			'GET https://github.com/nvm-sh/nvm/releases/latest',
			`GET https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_TAG}/nvm-exec`,
			`GET https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_TAG}/nvm.sh`,
		],
		'only nvm is fetched; no cache requests',
	);
	assertNVMInstalled(t, result, nvmDir);

	t.equal(result.bashCalls.length, 1, 'bash is invoked once');
	const [call] = result.bashCalls;
	t.deepEqual(
		call.argv,
		[
			commandSh,
			'lts/*',
			'',
			'',
			'',
			'false',
			'false',
			'install',
			'false',
		],
		'command.sh is invoked with the default arguments',
	);
	t.equal(call.cwd, result.cwd, 'bash runs in the cwd');
	t.equal(call.NVM_DIR, nvmDir, 'bash receives NVM_DIR');
	t.match(result.stdout, /got status code 0/, 'logs the status code');
	t.equal(
		readCommandFile(result.githubOutput, 'PATH'),
		`${path.join(dir, 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin`,
		'PATH output is set',
	);
	t.deepEqual(result.tarCalls, [], 'tar is never invoked');

	t.end();
});

test('node/install: all boolean inputs, npm ci, and NVM_DIR defaulting to ~/.nvm', (t) => {
	const result = runScript(t, script, {
		env: {
			'INPUT_NODE-VERSION': '20',
			INPUT_BEFORE_INSTALL: 'echo before',
			INPUT_AFTER_INSTALL: 'echo after',
			'INPUT_SKIP-LS-CHECK': 'true',
			'INPUT_SKIP-INSTALL': 'true',
			'INPUT_USE-NPM-CI': 'true',
			'INPUT_SKIP-LATEST-NPM': 'true',
		},
	});
	const nvmDir = path.join(result.dir, '.nvm');

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(result.report.pending, [], 'all mocked requests were made');
	assertNVMInstalled(t, result, nvmDir);
	t.deepEqual(
		result.bashCalls.map((x) => x.argv),
		[
			[
				commandSh,
				'20',
				'echo before',
				'',
				'echo after',
				'true',
				'true',
				'ci',
				'true',
			],
		],
		'command.sh is invoked with every input',
	);
	t.equal(result.bashCalls[0].NVM_DIR, nvmDir, 'bash receives the default NVM_DIR');

	t.end();
});

test('node/install: missing required node-version', (t) => {
	const dir = tmpDir(t, 'missing');
	const result = runScript(t, script, {
		dir,
		env: { NVM_DIR: nvmDirIn(dir) },
	});

	t.equal(result.status, 1, 'exits with 1');
	t.match(result.stderr, /Input required and not supplied: node-version/, 'logs the error');
	t.deepEqual(result.bashCalls, [], 'bash is never invoked');
	t.equal(readCommandFile(result.githubOutput, 'PATH'), undefined, 'PATH output is not set');

	t.end();
});

test('node/install: command.sh fails', (t) => {
	const dir = tmpDir(t, 'fail');
	const result = runScript(t, script, {
		dir,
		env: {
			NVM_DIR: nvmDirIn(dir),
			'INPUT_NODE-VERSION': '18',
			FAKE_BASH_EXIT: '7',
		},
	});

	t.equal(result.status, 7, 'exits with the bash exit code');
	t.match(result.stdout, /got status code 7/, 'logs the status code');
	t.match(result.stderr, /^7$/m, 'logs the thrown status');
	t.equal(result.bashCalls.length, 1, 'bash is invoked once');
	t.equal(readCommandFile(result.githubOutput, 'PATH'), undefined, 'PATH output is not set');

	t.end();
});

test('node/install: command.sh is killed by a signal', (t) => {
	const dir = tmpDir(t, 'signal');
	const result = runScript(t, script, {
		dir,
		env: {
			NVM_DIR: nvmDirIn(dir),
			'INPUT_NODE-VERSION': '18',
			FAKE_BASH_EXIT: 'signal',
		},
	});

	t.equal(result.status, 1, 'exits with 1');
	t.match(result.stdout, /got status code null/, 'logs the null status code');
	t.doesNotMatch(result.stderr, /null/, 'a null rejection is not logged');
	t.equal(readCommandFile(result.githubOutput, 'PATH'), undefined, 'PATH output is not set');

	t.end();
});

test('node/install: cache miss, outside a git repo', (t) => {
	const dir = tmpDir(t, 'miss');
	const result = runScript(t, script, {
		dir,
		env: {
			...cacheEnv,
			NVM_DIR: nvmDirIn(dir),
			'INPUT_NODE-VERSION': '22',
			'INPUT_CACHE-NODE-MODULES-KEY': 'my-key',
			NOCK_SETUP_CACHE: 'miss',
		},
	});

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(result.report.pending, [], 'all mocked requests were made');
	t.deepEqual(result.report.unmatched, [], 'no unexpected requests');
	const lookup = result.report.requests.find(({ url }) => url.includes('/_apis/artifactcache/cache?'));
	t.ok(lookup, 'the cache is looked up');
	t.equal(lookup && new URL(lookup.url).searchParams.get('keys'), 'my-key', 'the cache is looked up by the provided key');
	t.equal(result.bashCalls.length, 1, 'bash is invoked once');
	t.equal(result.bashCalls[0].argv[3], '', 'no cache hit is passed to command.sh');
	t.notOk(
		result.report.requests.some(({ method }) => method === 'POST' || method === 'PATCH'),
		'the cache is not saved',
	);

	t.end();
});

test('node/install: cache key fails validation', (t) => {
	const dir = tmpDir(t, 'invalid');
	const result = runScript(t, script, {
		dir,
		env: {
			...cacheEnv,
			NVM_DIR: nvmDirIn(dir),
			'INPUT_NODE-VERSION': '22',
			'INPUT_CACHE-NODE-MODULES-KEY': 'has,comma',
		},
	});

	t.equal(result.status, 0, 'exit 0 proves restoreCache\'s rejection was swallowed by the `.catch`');
	t.deepEqual(result.report.unmatched, [], 'no unexpected requests');
	t.ok(
		result.report.requests.some(({ url }) => url.startsWith('https://raw.githubusercontent.com/')),
		'requests are being recorded',
	);
	t.notOk(
		result.report.requests.some(({ url }) => url.includes('/_apis/artifactcache/')),
		'restoreCache rejects during key validation, before any cache lookup (unlike a cache miss, which looks the key up)',
	);
	t.equal(result.bashCalls.length, 1, 'bash is invoked once');
	t.equal(result.bashCalls[0].argv[3], '', 'no cache hit is passed to command.sh');

	t.end();
});

test('node/install: cache hit, inside a git repo with committed node_modules', (t) => {
	const dir = tmpDir(t, 'hit');
	const cwd = path.join(dir, 'repo');
	fs.mkdirSync(path.join(cwd, 'node_modules', 'bundled'), { recursive: true });
	const bundledFile = path.join(cwd, 'node_modules', 'bundled', 'index.js');
	fs.writeFileSync(bundledFile, 'committed\n');
	/** @type {(...args: string[]) => void} */
	const git = (...args) => {
		execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', ...args], {
			cwd,
			stdio: 'ignore',
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				GIT_CONFIG_NOSYSTEM: '1',
			},
		});
	};
	git('init', '-q');
	git('add', '-f', 'node_modules');
	git('commit', '-q', '-m', 'init');
	fs.writeFileSync(bundledFile, 'clobbered by the cache\n');

	const result = runScript(t, script, {
		dir,
		cwd,
		env: {
			...cacheEnv,
			NVM_DIR: nvmDirIn(dir),
			'INPUT_NODE-VERSION': '22',
			'INPUT_CACHE-NODE-MODULES-KEY': 'my-key',
			NOCK_SETUP_CACHE: 'hit',
			NOCK_SETUP_RESTORED_KEY: 'restored-key',
		},
	});

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(result.report.pending, [], 'all mocked requests (restore, download, reserve, upload, commit) were made');
	t.deepEqual(result.report.unmatched, [], 'no unexpected requests');
	t.ok(
		result.report.requests.some(({ method, url }) => method === 'GET' && url === ARCHIVE_URL),
		'the archive is downloaded',
	);
	const reserve = result.report.requests.find(({ method, url }) => method === 'POST' && url.endsWith('/_apis/artifactcache/caches'));
	t.equal(reserve && JSON.parse(reserve.body).key, 'restored-key', 'the cache is saved under the restored key');
	t.equal(fs.readFileSync(bundledFile, 'utf8'), 'committed\n', 'committed node_modules are restored via git checkout');
	t.equal(result.bashCalls.length, 1, 'bash is invoked once');
	t.equal(result.bashCalls[0].argv[3], 'restored-key', 'the cache hit is passed to command.sh');
	t.ok(result.tarCalls.some((args) => args.includes('-xf')), 'the archive is extracted');
	t.ok(result.tarCalls.some((args) => args.includes('-cf')), 'the archive is created for saving');

	t.end();
});
