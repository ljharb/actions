import { readFileSync } from 'fs';
import path from 'path';

import test from 'tape';

import {
	actionDir,
	baseEnv,
	makeTmp,
	runNode,
} from './helpers.mjs';

const script = path.join(actionDir, 'post.mjs');

test('bun/install post: runs `after_success` via post.sh, in the cwd', (t) => {
	const cwd = makeTmp(t);
	const r = runNode(script, {
		cwd,
		env: {
			...baseEnv(),
			INPUT_AFTER_SUCCESS: 'echo "it ran in $(pwd)" > after-success.txt',
		},
	});

	t.equal(r.status, 0, 'exits 0');
	t.match(r.stdout, /\* AFTER_SUCCESS: echo "it ran in \$\(pwd\)" > after-success\.txt/, 'post.sh receives `after_success` as its argument');
	t.equal(
		readFileSync(path.join(cwd, 'after-success.txt'), 'utf8'),
		`it ran in ${cwd}\n`,
		'the command was evaluated in the current working directory',
	);

	t.end();
});

test('bun/install post: no `after_success`', (t) => {
	const cwd = makeTmp(t);
	const r = runNode(script, { cwd, env: baseEnv() });

	t.equal(r.status, 0, 'exits 0');
	t.match(r.stdout, /\* AFTER_SUCCESS: \n/, 'post.sh receives an empty argument');
	t.doesNotMatch(r.stdout, /\*{6}>/, 'no command is run');

	t.end();
});

test('bun/install post: a failing `after_success` does not fail the post step', (t) => {
	const cwd = makeTmp(t);
	const r = runNode(script, {
		cwd,
		env: {
			...baseEnv(),
			INPUT_AFTER_SUCCESS: 'exit 7',
		},
	});

	t.equal(r.status, 0, 'exits 0: post.mjs ignores the script’s status');
	t.match(r.stdout, /\*{6}> exit 7/, 'the command was run');
	t.match(r.stderr, /\+ eval exit 7/, 'post.sh evaluated the failing command');

	t.end();
});
