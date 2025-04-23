'use strict';

const cache = require('@actions/cache');
const core = require('@actions/core');
const { spawnSync, execSync } = require('child_process');
const path = require('path');

const installNVM = require('../helpers/installNVM');

const cacheKey = core.getInput('cache-node-modules-key');
const cachePaths = ['node_modules'];

const installCommand = core.getInput('use-npm-ci', { required: true }) === 'true' ? 'ci' : 'install';

async function main() {
	const nvmDir = await installNVM();

	/** @type {Awaited<ReturnType<typeof cache.restoreCache>>} */
	let cacheID;
	if (cacheKey) {
		cacheID = await cache.restoreCache(cachePaths, cacheKey).catch(() => void undefined);
		execSync('git checkout -- node_modules ||:'); // for bundled deps, like tape-lib
	}

	const bashArgs = [
		path.join(__dirname, 'command.sh'),
		core.getInput('node-version', { required: true }),
		core.getInput('before_install'),
		cacheID || '',
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

	if (cacheKey && cacheID) {
		await cache.saveCache(cachePaths, cacheID);
	}

	core.setOutput('PATH', process.env.PATH);
}
main().catch((error) => {
	if (error) {
		console.error(error);
	}
	process.exitCode ||= 1;
});
