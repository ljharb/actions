import test from 'tape';

import { runIndexSuite } from '../../npm/install/index-suite.mjs';

test('vlt/install/index.mjs', (t) => {
	runIndexSuite(t, {
		dir: 'vlt/install',
		baseEnv: {
			'INPUT_NVM-DIR': '/fake/nvm',
			'INPUT_NODE-VERSION': 'lts/*',
		},
		// vlt has no `skip-install`, `use-npm-ci`, or `skip-latest-npm` inputs; those positions are hardcoded
		expectedArgs: ({
			nodeVersion,
			beforeInstall,
			cacheHit,
			afterInstall,
			skipLsCheck,
		}) => [
			nodeVersion,
			beforeInstall,
			cacheHit,
			afterInstall,
			skipLsCheck,
			'false',
			'install',
			'false',
		],
	});

	t.end();
});
