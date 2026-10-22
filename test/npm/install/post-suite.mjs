// Shared test suite for the `npm/install` and `vlt/install` `post.mjs` entry points. No top-level side effects.

import { existsSync, readFileSync, realpathSync } from 'fs';
import path from 'path';

import {
	makeSandbox,
	readBashArgs,
	readLog,
	repoRoot,
	runAction,
} from './helpers.mjs';

/**
 * @param {import('tape').Test} t
 * @param {string} dir
 */
export function runPostSuite(t, dir) {
	const script = `${dir}/post.mjs`;
	const postSh = path.join(repoRoot, dir, 'post.sh');

	t.test('invokes bash with post.sh and the `after_success` input, in the cwd', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, { INPUT_AFTER_SUCCESS: 'echo yay' });

		st.equal(result.status, 0, 'exits successfully');
		st.deepEqual(readBashArgs(sandbox), [postSh, 'echo yay'], 'bash receives post.sh and after_success');
		st.equal(
			realpathSync(String(readLog(sandbox, 'bash.cwd')).trim()),
			realpathSync(sandbox.cwd),
			'bash runs in the current working directory',
		);

		st.end();
	});

	t.test('`after_success` defaults to an empty argument', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox);

		st.equal(result.status, 0, 'exits successfully');
		st.deepEqual(readBashArgs(sandbox), [postSh, ''], 'after_success is passed as an empty string');

		st.end();
	});

	t.test('a failing post.sh does not fail the post step', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, {
			INPUT_AFTER_SUCCESS: 'false',
			FAKE_BASH_STATUS: '7',
		});

		st.equal(result.status, 0, 'the bash exit status is ignored');
		st.deepEqual(readBashArgs(sandbox), [postSh, 'false'], 'bash was run');

		st.end();
	});

	t.test('with real bash: evaluates `after_success`', (st) => {
		const sandbox = makeSandbox({ fakeBash: false });
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox, { INPUT_AFTER_SUCCESS: 'echo ran > marker.txt' });

		st.equal(result.status, 0, 'exits successfully');
		const marker = path.join(sandbox.cwd, 'marker.txt');
		st.ok(existsSync(marker), 'after_success ran in the cwd');
		st.equal(existsSync(marker) && readFileSync(marker, 'utf8'), 'ran\n', 'with the expected output');
		st.ok(result.stdout.includes('* AFTER_SUCCESS: echo ran > marker.txt'), 'post.sh logs the command');

		st.end();
	});

	t.test('with real bash: no `after_success` runs nothing', (st) => {
		const sandbox = makeSandbox({ fakeBash: false });
		st.teardown(sandbox.cleanup);

		const result = runAction(script, sandbox);

		st.equal(result.status, 0, 'exits successfully');
		st.ok(result.stdout.includes('* AFTER_SUCCESS: \n'), 'post.sh logs an empty command');
		st.notOk(result.stdout.includes('******>'), 'no command is evaluated');

		st.end();
	});
}
