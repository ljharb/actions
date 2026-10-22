import { execFileSync } from 'child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'fs';
import path from 'path';

import test from 'tape';

import {
	actionDir,
	baseEnv,
	makeTmp,
	readJSONLines,
	runNode,
	writeExecutable,
} from './helpers.mjs';

const script = path.join(actionDir, 'index.mjs');
const commandSh = path.join(actionDir, 'command.sh');

// records its argv (one per line), `$NVM_DIR`, and cwd, then exits as `$FAKE_BASH_STATUS` says
const fakeBash = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_BASH_LOG"
printf '%s\\n' "$NVM_DIR" > "$FAKE_BASH_LOG.nvm"
pwd > "$FAKE_BASH_LOG.cwd"
if [ "$FAKE_BASH_STATUS" = signal ]; then
  kill -9 $$
fi
exit "\${FAKE_BASH_STATUS:-0}"
`;

/**
 * @param {import('tape').Test} t
 * @param {Record<string, string>} [inputs]
 * @param {Record<string, string>} [extraEnv]
 * @param {{ git?: boolean }} [options]
 */
function run(t, inputs = {}, extraEnv = {}, { git = false } = {}) {
	const tmp = makeTmp(t);
	const cwd = path.join(tmp, 'project');
	mkdirSync(cwd);
	const bin = path.join(tmp, 'bin');
	writeExecutable(path.join(bin, 'bash'), fakeBash);

	if (git) {
		mkdirSync(path.join(cwd, 'node_modules'));
		writeFileSync(path.join(cwd, 'node_modules', 'bundled.txt'), 'committed\n');
		/** @param {string[]} args */
		const g = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
		g('init', '-q');
		g('add', 'node_modules');
		g('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
		writeFileSync(path.join(cwd, 'node_modules', 'bundled.txt'), 'clobbered by cache restore\n');
	}

	const files = {
		bashLog: path.join(tmp, 'bash.log'),
		cacheLog: path.join(tmp, 'cache.log'),
		output: path.join(tmp, 'github-output'),
	};
	writeFileSync(files.output, '');

	/** @type {Record<string, string | undefined>} */
	const env = {
		...baseEnv(),
		GITHUB_OUTPUT: files.output,
		FAKE_BASH_LOG: files.bashLog,
		FAKE_CACHE_LOG: files.cacheLog,
		...extraEnv,
	};
	env.PATH = `${bin}${path.delimiter}${env.PATH}`;
	Object.entries(inputs).forEach(([name, value]) => {
		env[`INPUT_${name.toUpperCase()}`] = value;
	});

	const result = runNode(script, { cwd, env, fakeCache: true });

	return {
		...result,
		cwd,
		env,
		bashArgs: existsSync(files.bashLog) ? readFileSync(files.bashLog, 'utf8').split('\n').slice(0, -1) : null,
		bashNvmDir: existsSync(files.bashLog) ? readFileSync(`${files.bashLog}.nvm`, 'utf8').trim() : null,
		bashCwd: existsSync(files.bashLog) ? readFileSync(`${files.bashLog}.cwd`, 'utf8').trim() : null,
		cacheCalls: readJSONLines(files.cacheLog),
		output: readFileSync(files.output, 'utf8'),
	};
}

const requiredInputs = {
	'nvm-dir': '/fake/nvm',
	'node-version': '20',
};

test('bun/install: missing required `nvm-dir` input', (t) => {
	const r = run(t, { 'node-version': '20', 'cache-node-modules-key': 'k' });

	t.equal(r.status, 1, 'exits 1');
	t.match(r.stderr, /Input required and not supplied: nvm-dir/, 'reports the missing input');
	t.equal(r.bashArgs, null, 'command.sh is never run');
	t.deepEqual(r.cacheCalls, [], 'the cache is never touched');
	t.equal(r.output, '', 'no outputs are set');

	t.end();
});

test('bun/install: missing required `node-version` input', (t) => {
	const r = run(t, { 'nvm-dir': '/fake/nvm' });

	t.equal(r.status, 1, 'exits 1');
	t.match(r.stderr, /Input required and not supplied: node-version/, 'reports the missing input');
	t.equal(r.bashArgs, null, 'command.sh is never run');

	t.end();
});

test('bun/install: no cache key, command succeeds', (t) => {
	const r = run(t, {
		...requiredInputs,
		...Object.fromEntries([
			['before_install', 'echo before'],
			['after_install', 'echo after'],
		]),
	});

	t.equal(r.status, 0, 'exits 0');
	t.deepEqual(
		r.bashArgs,
		[
			commandSh,
			'20',
			'echo before',
			'',
			'echo after',
			'false',
			'false',
			'install',
			'false',
		],
		'runs command.sh with positional args: version, before_install, cache hit, after_install, skip-ls-check, skip-install, install command, skip-latest-npm',
	);
	t.equal(r.bashNvmDir, '/fake/nvm', '`nvm-dir` is passed as `$NVM_DIR`');
	t.equal(r.bashCwd, r.cwd, 'runs in the current working directory');
	t.deepEqual(r.cacheCalls, [], 'the cache is not used without a key');
	t.match(r.stdout, /got status code 0/, 'logs the status code');
	t.match(r.output, new RegExp(`^PATH<<(ghadelimiter_[^\\n]+)\\n${r.env.PATH?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\1\\n$`), 'sets the `PATH` output to the process PATH');

	t.end();
});

test('bun/install: `skip-ls-check`', (t) => {
	t.test('"true"', (st) => {
		const r = run(st, { ...requiredInputs, 'skip-ls-check': 'true' });
		st.equal(r.status, 0, 'exits 0');
		st.equal(r.bashArgs?.[5], 'true', 'passes `true` for SKIP_LS_CHECK');
		st.end();
	});

	t.test('anything else', (st) => {
		const r = run(st, { ...requiredInputs, 'skip-ls-check': 'yes' });
		st.equal(r.status, 0, 'exits 0');
		st.equal(r.bashArgs?.[5], 'false', 'passes `false` for SKIP_LS_CHECK');
		st.end();
	});

	t.end();
});

test('bun/install: cache hit', (t) => {
	const r = run(
		t,
		{ ...requiredInputs, 'cache-node-modules-key': 'my-key' },
		{ FAKE_CACHE_RESTORE: 'hit:restored-key' },
		{ git: true },
	);

	t.equal(r.status, 0, 'exits 0');
	t.deepEqual(
		r.cacheCalls,
		[
			{ fn: 'restoreCache', args: [['node_modules'], 'my-key'] },
			{ fn: 'saveCache', args: [['node_modules'], 'restored-key'] },
		],
		'restores node_modules by the key, then saves under the restored key',
	);
	t.equal(r.bashArgs?.[3], 'restored-key', 'passes the restored key as CACHE_HIT');
	t.equal(
		readFileSync(path.join(r.cwd, 'node_modules', 'bundled.txt'), 'utf8'),
		'committed\n',
		'committed files in node_modules are restored via `git checkout`',
	);
	t.match(r.output, /^PATH<</, 'sets the `PATH` output');

	t.end();
});

test('bun/install: cache miss, outside a git repo', (t) => {
	const r = run(
		t,
		{ ...requiredInputs, 'cache-node-modules-key': 'my-key' },
		{ FAKE_CACHE_RESTORE: 'miss' },
	);

	t.equal(r.status, 0, 'exits 0: the `git checkout` failure is ignored');
	t.deepEqual(
		r.cacheCalls,
		[{ fn: 'restoreCache', args: [['node_modules'], 'my-key'] }],
		'restores, but does not save on a miss',
	);
	t.equal(r.bashArgs?.[3], '', 'passes an empty CACHE_HIT');

	t.end();
});

test('bun/install: cache restore rejects', (t) => {
	const r = run(
		t,
		{ ...requiredInputs, 'cache-node-modules-key': 'my-key' },
		{ FAKE_CACHE_RESTORE: 'reject' },
	);

	t.equal(r.status, 0, 'exits 0: a restore failure is treated as a miss');
	t.doesNotMatch(r.stderr, /fake restoreCache failure/, 'the restore error is swallowed');
	t.deepEqual(
		r.cacheCalls,
		[{ fn: 'restoreCache', args: [['node_modules'], 'my-key'] }],
		'does not save',
	);
	t.equal(r.bashArgs?.[3], '', 'passes an empty CACHE_HIT');

	t.end();
});

test('bun/install: cache save rejects', (t) => {
	const r = run(
		t,
		{ ...requiredInputs, 'cache-node-modules-key': 'my-key' },
		{ FAKE_CACHE_RESTORE: 'hit:restored-key', FAKE_CACHE_SAVE: 'reject' },
	);

	t.equal(r.status, 1, 'exits 1');
	t.match(r.stderr, /fake saveCache failure/, 'reports the save error');
	t.equal(r.output, '', 'no outputs are set');

	t.end();
});

test('bun/install: command fails', (t) => {
	const r = run(
		t,
		{ ...requiredInputs, 'cache-node-modules-key': 'my-key' },
		{ FAKE_BASH_STATUS: '3', FAKE_CACHE_RESTORE: 'hit:restored-key' },
	);

	t.equal(r.status, 3, 'exits with the command’s status code');
	t.match(r.stdout, /got status code 3/, 'logs the status code');
	t.match(r.stderr, /^3$/m, 'prints the thrown status code');
	t.deepEqual(
		r.cacheCalls,
		[{ fn: 'restoreCache', args: [['node_modules'], 'my-key'] }],
		'does not save the cache',
	);
	t.equal(r.output, '', 'no outputs are set');

	t.end();
});

test('bun/install: command is killed by a signal', (t) => {
	const r = run(t, requiredInputs, { FAKE_BASH_STATUS: 'signal' });

	t.equal(r.status, 1, 'exits 1 when there is no status code');
	t.match(r.stdout, /got status code null/, 'logs the null status code');
	t.equal(r.stderr, '', 'a null rejection is not printed');
	t.equal(r.output, '', 'no outputs are set');

	t.end();
});
