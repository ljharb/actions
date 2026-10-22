import test from 'tape';

import { runPostSuite } from '../../npm/install/post-suite.mjs';

test('vlt/install/post.mjs', (t) => {
	runPostSuite(t, 'vlt/install');

	t.end();
});
