import core from '@actions/core';
import { join } from 'path';
import { readFile } from 'fs/promises';
import pacote from 'pacote';

/** @typedef {{ name: string, version: string, [key: string]: unknown }} PackageFile */

/** @type {(packagePath: string) => Promise<PackageFile>} */
export async function readPackageFile(packagePath) {
	const packageFilePath = join(packagePath, 'package.json');
	core.debug(`Reading ${packageFilePath}…`);
	const data = await readFile(packageFilePath);
	return JSON.parse(`${data}`);
}

try {
	const packagePath = core.getInput('path') || '.';
	const { name, version } = await readPackageFile(packagePath);
	core.debug(`Fetching package ${name} information from npm…`);

	const { 'dist-tags': { latest }, versions } = await pacote.packument(name);

	const isNewVersion = !Object.hasOwn(versions, version);

	core.setOutput('is-new-version', `${isNewVersion}`);
	core.setOutput('published-version', latest);
	core.setOutput('committed-version', version);
} catch ({ message }) {
	core.setFailed(message);
}
