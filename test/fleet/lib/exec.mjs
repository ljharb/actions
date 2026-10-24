import {
	mkdtempSync,
	realpathSync,
	rmSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import test from 'tape';

import { exec, gitAuthEnv } from '../../../fleet/lib/exec.mjs';
import { gitIsolation, tempDir } from './helpers/git.mjs';

const node = process.execPath;

test('exec: success', (t) => {
	const result = exec(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
	t.deepEqual(result, { status: 0, stdout: 'out', stderr: 'err' }, 'returns the status and both streams as strings');

	t.end();
});

test('exec: cwd, env, and input', (t) => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-exec-')));
	t.teardown(() => rmSync(dir, { recursive: true, force: true }));
	const script = `
		let input = '';
		process.stdin.on('data', (d) => { input += d; });
		process.stdin.on('end', () => {
			process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env.FLEET_EXEC_TEST, path: !!process.env.PATH, input }));
		});
	`;
	const { stdout } = exec(node, ['-e', script], {
		cwd: dir,
		env: { FLEET_EXEC_TEST: 'yes' },
		input: 'some input',
	});
	t.deepEqual(
		JSON.parse(stdout),
		{
			cwd: dir,
			env: 'yes',
			path: true,
			input: 'some input',
		},
		'runs in `cwd`, with `env` merged over the current environment, and `input` on stdin',
	);

	t.end();
});

test('exec: failure', (t) => {
	t.throws(
		() => exec(node, ['-e', 'process.stdout.write("ignored"); process.stderr.write("bad things\\n"); process.exit(3)']),
		(/** @type {unknown} */ e) => e instanceof Error && e.message === `\`${node} -e process.stdout.write("ignored"); process.stderr.write("bad things\\n"); process.exit(3)\` failed (exit 3):\nbad things`,
		'throws with the command, exit code, and stderr',
	);

	t.throws(
		() => exec(node, ['-e', 'process.stdout.write("only stdout\\n"); process.exit(2)']),
		(/** @type {unknown} */ e) => e instanceof Error && (/failed \(exit 2\):\nonly stdout$/).test(e.message),
		'falls back to stdout when stderr is empty',
	);

	t.throws(
		() => exec(node, ['-e', 'process.exit(1)']),
		(/** @type {unknown} */ e) => e instanceof Error && e.message === `\`${node} -e process.exit(1)\` failed (exit 1):`,
		'trims the message when there is no output',
	);

	t.end();
});

test('exec: allowFailure', (t) => {
	const result = exec(node, ['-e', 'process.stdout.write("x"); process.exit(4)'], { allowFailure: true });
	t.deepEqual(result, { status: 4, stdout: 'x', stderr: '' }, 'returns the failing status instead of throwing');

	t.end();
});

test('exec: spawn error', (t) => {
	t.throws(
		() => exec('fleet-exec-test-no-such-command', []),
		(/** @type {unknown} */ e) => e instanceof Error && 'code' in e && e.code === 'ENOENT',
		'rethrows the spawn error',
	);
	t.throws(
		() => exec('fleet-exec-test-no-such-command', [], { allowFailure: true }),
		(/** @type {unknown} */ e) => e instanceof Error && 'code' in e && e.code === 'ENOENT',
		'even with allowFailure',
	);

	t.end();
});

test('gitAuthEnv', (t) => {
	const env = gitAuthEnv('ghs_secret');

	t.deepEqual(env, {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`,
		GIT_TERMINAL_PROMPT: '0',
	}, 'configures a basic auth header for github.com, and disables prompting');
	t.equal(
		Buffer.from(env.GIT_CONFIG_VALUE_0.replace('AUTHORIZATION: basic ', ''), 'base64').toString('utf8'),
		'x-access-token:ghs_secret',
		'the header encodes the token as an installation access token',
	);
	t.ok(Object.values(env).every((value) => !value.includes('ghs_secret')), 'the token never appears in the clear');

	t.equal(gitAuthEnv('x', 'https://ghe.example.com').GIT_CONFIG_KEY_0, 'http.https://ghe.example.com/.extraheader', 'scopes the header to another server');
	t.equal(gitAuthEnv('x', 'https://ghe.example.com//').GIT_CONFIG_KEY_0, 'http.https://ghe.example.com/.extraheader', 'ignoring trailing slashes');

	const cwd = tempDir(t, 'git-auth-env');
	exec('git', ['init', '--quiet'], { cwd, env: gitIsolation });
	const { stdout } = exec('git', ['config', '--get', 'http.https://github.com/.extraheader'], { cwd, env: { ...gitIsolation, ...env } });
	t.equal(stdout.trim(), env.GIT_CONFIG_VALUE_0, 'git sees the header as config');
	const local = exec('git', ['config', '--local', '--get', 'http.https://github.com/.extraheader'], { cwd, env: { ...gitIsolation, ...env }, allowFailure: true });
	t.equal(local.status, 1, 'without it being written to `.git/config`');

	t.end();
});
