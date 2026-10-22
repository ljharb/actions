import * as core from '@actions/core';
import * as github from '@actions/github';
import semver from 'semver';

import {
	addNotable,
	getPreset,
	getReqOpts,
	presets,
} from './versions.mjs';

/** @typedef {import('./versions.mjs').nvmVersionish} nvmVersionish */
/** @typedef {import('./versions.mjs').Type} Type */

/* eslint no-extra-parens: 0 */

/** @type {(opts: { envs: Record<string, string>, key: 'node-version', versionsAsRoot: boolean, reqs: nvmVersionish[], opts: nvmVersionish[] }) => void} */
function setOutput({
	envs,
	key,
	versionsAsRoot,
	reqs,
	opts,
}) {
	const makePayload = versionsAsRoot
		? /** @type {<T extends nvmVersionish[]>(x: T) => T} */ (x) => x
		// eslint-disable-next-line operator-linebreak
		: /** @type {<T extends nvmVersionish[]>(versions: T) => { envs: typeof envs, 'node-version': T }} */
		(versions) => ({
			...envs && { envs },
			[key]: versions,
		});

	const requiredsOutput = makePayload(reqs);
	core.setOutput('requireds', JSON.stringify(requiredsOutput));
	core.info(`requireds: ${JSON.stringify(requiredsOutput)}`);

	const optionalsOutput = makePayload(opts);
	core.setOutput('optionals', JSON.stringify(optionalsOutput));
	core.info(`optionals: ${JSON.stringify(optionalsOutput)}`);

	// Get the JSON webhook payload for the event that triggered the workflow
	const payload = JSON.stringify(github.context.payload, null, '\t');
	console.log(`The event payload: ${payload}`);
}

async function main() {
	const empty = core.getInput('empty') === 'true';
	const key = /** @type {'node-version'} */ (core.getInput('version_key')) || 'node-version';
	const versionsAsRoot = !!core.getInput('versionsAsRoot');

	const requireds = core.getInput('requireds');
	const optionals = core.getInput('optionals');
	const type = /** @type {Type} */ (core.getInput('type'));
	const preset = core.getInput('preset');
	const notable = core.getInput('notable');
	const fullSemver = core.getInput('fullSemver') === 'true';
	/** @type {Record<string, string>} */
	const envs = JSON.parse(core.getInput('envs') || 'null');
	if (envs && versionsAsRoot) {
		throw new TypeError('`envs` and `versionsAsRoot` are mutually exclusive');
	}
	if (preset && (requireds || optionals)) {
		throw new TypeError('if `preset` is provided, `requireds` and `optionals` must not be');
	}
	if (!preset && notable) {
		throw new TypeError('`notable` may only be provided if `preset` is provided');
	}
	if (type && (type !== 'majors' && type !== 'minors')) {
		throw new TypeError('`type` must be "majors" or "minors"');
	}

	if (empty) {
		setOutput({
			envs,
			key,
			versionsAsRoot,
			reqs: [],
			opts: [],
		});
		return;
	}

	if (preset && !presets.includes(preset) && !semver.validRange(preset)) {
		throw new TypeError(`\`preset\`, if provided, must be a valid semver range, or one of: \`${presets.join(', ')}\` (got \`${preset}\``);
	}

	if (!preset && (!semver.validRange(requireds) || !semver.validRange(optionals))) {
		throw new TypeError('`requireds` and `optionals` must both be valid semver ranges');
	}
	const {
		requireds: reqs,
		optionals: opts,
	} = await addNotable(
		await (preset
			? getPreset(preset, type, fullSemver)
			: getReqOpts(requireds, optionals, type, true, fullSemver)
		),
		{ notable, type },
	);

	setOutput({
		envs,
		key,
		versionsAsRoot,
		reqs,
		opts,
	});
}
main().catch((error) => {
	console.error(error);
	core.setFailed(error.message);
});
