'use strict';

const cache = require('@actions/cache');
const core = require('@actions/core');
const { spawnSync, execSync } = require('child_process');
const path = require('path');

const { status: nvmStatus } = spawnSync('node', [require.resolve('setup-node-nvm')]);

if (nvmStatus !== 0) {
	process.exitCode ||= nvmStatus ?? 1;
	// @ts-expect-error top-level return is valid in CJS
	return;
}

const cacheKey = core.getInput('cache-node-modules-key');
const cachePaths = ['node_modules'];

const installCommand = core.getInput('use-npm-ci', { required: true }) === 'true' ? 'ci' : 'install';

async function main() {
	/** @type {Awaited<ReturnType<typeof cache.restoreCache>>} */
	let cacheID;
	if (cacheKey) {
		cacheID = await cache.restoreCache(cachePaths, cacheKey).catch(() => void undefined);
		execSync('git checkout -- node_modules ||:'); // for bundled deps, like tape-lib
	}

	const cmd = core.getInput('command');
	const shellCmd = core.getInput('shell-command');
	if (cmd && shellCmd) {
		throw new TypeError('`command` and `shell-command` are mutually exclusive');
	} else if (!cmd && !shellCmd) {
		throw new TypeError('One of `command` or `shell-command` must be provided');
	}

	const bashArgs = [
		path.join(__dirname, 'command.sh'),
		core.getInput('node-version', { required: true }),
		shellCmd || `npm run "${cmd}"`,
		core.getInput('before_install'),
		cacheID || '',
		core.getInput('after_install'),
		String(core.getInput('skip-ls-check')) === 'true',
		String(core.getInput('skip-install')) === 'true',
		installCommand,
	].map(String);

	const { status } = spawnSync('bash', bashArgs, {
		cwd: process.cwd(),
		stdio: 'inherit',
	});

	process.exitCode ||= status || 0;

	core.info(`got status code ${status}`);

	if (status !== 0) {
		throw status;
	}

	if (cacheKey && cacheID) {
		await cache.saveCache(cachePaths, cacheID);
	}
}
main().catch((error) => {
	if (error) {
		console.error(error);
	}
	process.exitCode ||= 1;
});
