import path from 'path';

import test from 'tape';

import { repoRoot, runScript } from './helpers.mjs';

const script = path.join(repoRoot, 'node', 'install', 'post.mjs');
const postSh = path.join(repoRoot, 'node', 'install', 'post.sh');

test('node/install post: runs post.sh with after_success', (t) => {
	const result = runScript(t, script, {
		env: { INPUT_AFTER_SUCCESS: 'npx codecov' },
	});

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(result.bashCalls.map((x) => x.argv), [[postSh, 'npx codecov']], 'post.sh is invoked with after_success');
	t.equal(result.bashCalls[0].cwd, result.cwd, 'bash runs in the cwd');
	t.deepEqual(result.report.requests, [], 'no network requests');

	t.end();
});

test('node/install post: defaults to an empty after_success', (t) => {
	const result = runScript(t, script);

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(result.bashCalls.map((x) => x.argv), [[postSh, '']], 'post.sh is invoked with an empty argument');

	t.end();
});

test('node/install post: a post.sh failure does not fail the step', (t) => {
	const result = runScript(t, script, {
		env: { FAKE_BASH_EXIT: '3' },
	});

	t.equal(result.status, 0, 'the exit status of post.sh is ignored');
	t.equal(result.bashCalls.length, 1, 'bash is invoked once');

	t.end();
});
