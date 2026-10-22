import {
	mkdtempSync,
	realpathSync,
	rmSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import test from 'tape';

import { exec } from '../../../fleet/lib/exec.mjs';

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
