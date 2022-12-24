'use strict';

const core = require('@actions/core');
const { spawnSync } = require('child_process');
const path = require('path');
const https = require('https');
const fs = require('fs');

const cacheKey = core.getInput('cache-node-modules-key');

const installCommand = core.getInput('use-npm-ci', { required: true }) === 'true' ? 'ci' : 'install';

async function getLatestNVM() {
	return new Promise((resolve) => {
		https.get('https://github.com/nvm-sh/nvm/releases/latest', (res) => {
			if (res.statusCode === 302) {
				resolve(res.headers.location.split('/').slice(-1)[0]);
			} else {
				throw res;
			}
		});
	});
}

async function installNVM() {
	const latest = await getLatestNVM();
	const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME, '.nvm');
	const url = `https://raw.githubusercontent.com/nvm-sh/nvm/${latest}/nvm.sh`;

	const file = fs.createWriteStream(path.join(nvmDir, 'nvm.sh'));
	return new Promise((resolve) => {
		https.get(url, (response) => {
			response.pipe(file);

			file.on('finish', () => {
				file.close();
				resolve();
			});
		});
	});
}

async function main() {
	await installNVM();

	let cacheHit = false;
	if (cacheKey) {
		process.env.INPUT_KEY = cacheKey;
		core.getInput('key', { required: true }); // assert
		process.env.INPUT_PATH = 'node_modules';
		core.getInput('path', { required: true }); // assert

		const { write } = process.stdout;
		process.stdout.write = function (arg) {
			if (typeof arg === 'string') {
				if (arg.startsWith('::save-state name=')) {
					const [name, value] = arg.slice('::save-state name='.length).split('::');
					core.info(`hijacking core.saveState output: ${name.split(',')}=${value}`);
					name.split(',').forEach((x) => {
						process.env[`STATE_${x}`] = value;
					});
				} else if (arg.startsWith('::set-output name=cache-hit::')) {
					core.info(`hijacking core.setOutput output: ${arg}`);
					cacheHit = arg === '::set-output name=cache-hit::true';
				}
			}
			return write.apply(process.stdout, arguments); // eslint-disable-line prefer-rest-params
		};

		await require('cache/dist/restore').default(); // eslint-disable-line global-require
	}

	const { status } = spawnSync('bash', [
		path.join(__dirname, 'command.sh'),
		core.getInput('node-version', { required: true }),
		core.getInput('before_install'),
		String(cacheHit),
		core.getInput('after_install'),
		String(core.getInput('skip-ls-check')) === 'true',
		String(core.getInput('skip-install')) === 'true',
		installCommand,
		String(core.getInput('skip-latest-npm')) === 'true',
	], {
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

	core.setOutput('PATH', process.env.PATH);
}
main().catch((error) => {
	if (error) {
		console.error(error);
	}
	if (!process.exitCode) {
		process.exitCode = 1;
	}
});
