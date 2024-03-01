'use strict';

const core = require('@actions/core');
const { spawnSync } = require('child_process');
const path = require('path');
const hijackActionsCore = require('../helpers/hijackActionsCore');

const { status: nvmStatus } = spawnSync('node', [require.resolve('setup-node-nvm')]);

if (nvmStatus !== 0) {
	process.exitCode ||= nvmStatus ?? 1;
	// @ts-expect-error top-level return is valid in CJS
	return;
}

const cacheKey = core.getInput('cache-node-modules-key');

const installCommand = core.getInput('use-npm-ci', { required: true }) === 'true' ? 'ci' : 'install';

async function main() {
	/* eslint max-lines-per-function: 0 */
	let cacheHit = false;
	if (cacheKey) {
		process.env.INPUT_KEY = cacheKey;
		core.getInput('key', { required: true }); // assert
		process.env.INPUT_PATH = 'node_modules';
		core.getInput('path', { required: true }); // assert

		hijackActionsCore((x) => { cacheHit = x; });

		await require('cache/dist/restore').default(); // eslint-disable-line global-require
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
		cacheHit,
		core.getInput('after_install'),
		String(core.getInput('skip-ls-check')) === 'true',
		String(core.getInput('skip-install')) === 'true',
		installCommand,
	].map(String);

	const { status } = spawnSync('bash', bashArgs, {
		cwd: process.cwd(),
		stdio: 'inherit',
	});

	process.exitCode = status;

	core.info(`got status code ${status}`);

	if (status !== 0) {
		throw status;
	}

	if (cacheKey) {
		await require('cache/dist/save').default(); // eslint-disable-line global-require
	}
}
main().catch((error) => {
	if (error) {
		console.error(error);
	}
	process.exitCode ||= 1;
});
