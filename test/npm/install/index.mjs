import test from 'tape';

import { makeSandbox, readBashArgs, runAction } from './helpers.mjs';
import { runIndexSuite } from './index-suite.mjs';

test('npm/install/index.mjs', (t) => {
	runIndexSuite(t, {
		dir: 'npm/install',
		baseEnv: {
			'INPUT_NVM-DIR': '/fake/nvm',
			'INPUT_NODE-VERSION': 'lts/*',
			'INPUT_USE-NPM-CI': 'false',
		},
		expectedArgs: ({
			nodeVersion,
			beforeInstall,
			cacheHit,
			afterInstall,
			skipLsCheck,
			npmInputs,
		}) => [
			nodeVersion,
			beforeInstall,
			cacheHit,
			afterInstall,
			skipLsCheck,
			npmInputs.skipInstall || 'false',
			npmInputs.useNpmCi === 'true' ? 'ci' : 'install',
			npmInputs.skipLatestNpm || 'false',
		],
	});

	t.test('missing `use-npm-ci` input: throws at import time, before running command.sh', (st) => {
		const sandbox = makeSandbox();
		st.teardown(sandbox.cleanup);

		const result = runAction('npm/install/index.mjs', sandbox, {
			'INPUT_NVM-DIR': '/fake/nvm',
			'INPUT_NODE-VERSION': 'lts/*',
		});

		st.equal(result.status, 1, 'exits 1');
		st.ok(result.stderr.includes('Input required and not supplied: use-npm-ci'), 'prints the missing input error');
		st.equal(readBashArgs(sandbox), null, 'command.sh is not run');

		st.end();
	});

	t.end();
});
