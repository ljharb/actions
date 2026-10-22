import test from 'tape';

import { runPostSuite } from './post-suite.mjs';

test('npm/install/post.mjs', (t) => {
	runPostSuite(t, 'npm/install');

	t.end();
});
