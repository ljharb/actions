'use strict';

const os = require('os');
const path = require('path');
const { mkdirp } = require('mkdirp');

const downloadFile = require('./downloadFile');
const getLatestNVM = require('./getLatestNVM');

module.exports = async function installNVM() {
	const latest = await getLatestNVM();
	const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
	await mkdirp(nvmDir);

	await Promise.all([
		downloadFile(`https://raw.githubusercontent.com/nvm-sh/nvm/${latest}/nvm.sh`, path.join(nvmDir, 'nvm.sh')),
		downloadFile(`https://raw.githubusercontent.com/nvm-sh/nvm/${latest}/nvm-exec`, path.join(nvmDir, 'nvm-exec')),
	]);

	return nvmDir;
};
