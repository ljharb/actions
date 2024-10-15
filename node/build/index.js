'use strict';

const core = require('@actions/core');
const { spawnSync } = require('child_process');
const path = require('path');

const hijackActionsCore = require('../helpers/hijackActionsCore');
const installNVM = require('../helpers/installNVM');

const cacheKey = core.getInput('cache-node-modules-key');

const installCommand = core.getInput('use-npm-ci', { required: true }) === 'true' ? 'ci' : 'install';

async function main() {
	const nvmDir = await installNVM();

	let cacheHit = false;
	if (cacheKey) {
		process.env.INPUT_KEY = cacheKey;
		core.getInput('key', { required: true }); // assert
		process.env.INPUT_PATH = 'node_modules';
		core.getInput('path', { required: true }); // assert

		hijackActionsCore((x) => { cacheHit = x; });

		await require('cache/dist/restore').default(); // eslint-disable-line global-require
	}

	const bashArgs = [
		path.join(__dirname, 'command.sh'),
		core.getInput('node-version', { required: true }),
		core.getInput('before_install'),
		cacheHit,
		core.getInput('after_install'),
		String(core.getInput('skip-ls-check')) === 'true',
		String(core.getInput('skip-install')) === 'true',
		installCommand,
		String(core.getInput('skip-latest-npm')) === 'true',
	].map(String);

	const { status } = spawnSync('bash', bashArgs, {
		cwd: process.cwd(),
		env: { ...process.env, NVM_DIR: nvmDir },
		stdio: 'inherit',
	});

	process.exitCode = status || 0;

	core.info(`got status code ${status}`);

	if (status !== 0) {
		throw status;
	}

	if (cacheKey) {
		await require('cache/dist/save').default(); // eslint-disable-line global-require
	}

	core.setOutput('PATH', process.env.PATH);
}
main().catch((error) => {
	if (error) {
		console.error(error);
	}
	process.exitCode ||= 1;
});
