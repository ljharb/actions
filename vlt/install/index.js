'use strict';

const core = require('@actions/core');
const { spawnSync } = require('child_process');
const path = require('path');

const hijackActionsCore = require('../../node/helpers/hijackActionsCore');

const cacheKey = core.getInput('cache-node-modules-key');

const installCommand = 'install';

async function main() {
	const nvmDir = core.getInput('nvm-dir', { required: true }); // assert

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
		false,
		installCommand,
		false,
	].map(String);

	const { status } = spawnSync('bash', bashArgs, {
		cwd: process.cwd(),
		env: { ...process.env, NVM_DIR: nvmDir },
		stdio: 'inherit',
	});

	process.exitCode ||= status ?? 1;

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
