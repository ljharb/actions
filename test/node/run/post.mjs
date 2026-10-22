/* eslint camelcase: ["error", { "allow": ["^(?:before|after)_(?:install|success)$"] }] */

import fs from 'fs';
import path from 'path';

import test from 'tape';

import { runAction } from '../build/helpers/harness.mjs';

const script = 'node/run/post.mjs';

test('node/run post: runs `after_success` via post.sh', (t) => {
	const result = runAction(script, {
		inputs: { after_success: 'echo "ran in $(pwd -P)" > after-success.txt' },
		fakes: ['curl'],
	});

	t.equal(result.status, 0, 'exits 0');
	t.equal(
		fs.readFileSync(path.join(result.cwd, 'after-success.txt'), 'utf8'),
		`ran in ${result.cwd}\n`,
		'after_success is evaluated in the cwd',
	);
	t.match(result.stdout, /^\* AFTER_SUCCESS: echo "ran in \$\(pwd -P\)" > after-success\.txt$/m, 'post.sh logs the command');
	t.deepEqual(result.calls('curl'), [], 'codecov is not fetched');

	t.end();
});

test('node/run post: `after_success` failure does not fail the post step', (t) => {
	const result = runAction(script, {
		inputs: { after_success: 'exit 7' },
	});

	t.equal(result.status, 0, 'exits 0; the post script’s status is ignored');
	t.match(result.stderr, /\+ eval exit 7/, 'post.sh did run the command');

	t.end();
});

test('node/run post: no `after_success` and no coverage does nothing', (t) => {
	const result = runAction(script, { fakes: ['curl'] });

	t.equal(result.status, 0, 'exits 0');
	t.match(result.stdout, /^\* AFTER_SUCCESS: $/m, 'post.sh runs with an empty command');
	t.deepEqual(result.calls('curl'), [], 'codecov is not fetched');

	t.end();
});

test('node/run post: no `after_success` with coverage uploads to codecov', (t) => {
	const result = runAction(script, {
		fakes: ['curl'],
		env: { FAKE_CURL_STDOUT: 'echo "uploader $*" > uploader.txt' },
		setup({ cwd }) {
			fs.mkdirSync(path.join(cwd, 'coverage'));
			fs.writeFileSync(path.join(cwd, 'coverage', 'coverage-final.json'), '{}');
		},
	});

	t.equal(result.status, 0, 'exits 0');
	t.deepEqual(
		result.calls('curl').map((x) => x.args),
		[['-s', 'https://codecov.io/bash']],
		'fetches the codecov uploader',
	);
	t.equal(
		fs.readFileSync(path.join(result.cwd, 'uploader.txt'), 'utf8'),
		'uploader -f coverage/coverage-final.json\n',
		'runs the fetched uploader with the coverage file',
	);

	t.end();
});
