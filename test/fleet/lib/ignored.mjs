import test from 'tape';

import { isIgnored } from '../../../fleet/lib/ignored.mjs';

test('isIgnored', (t) => {
	t.ok(isIgnored('browserify/module-deps'), 'a browserify repository on the list');
	t.ok(isIgnored('Browserify/Module-Deps'), 'matched case-insensitively');
	t.notOk(isIgnored('browserify/resolve'), 'a browserify repository not on the list');
	t.notOk(isIgnored('ljharb/module-deps'), 'the same name in another account');
	t.notOk(isIgnored('browserify'), 'an account name alone');

	t.end();
});
