'use strict';

const core = require('@actions/core');

/** @type {(setCacheHit: (x: boolean) => void) => void} */
module.exports = function hijackActionsCore(setCacheHit) {
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
				setCacheHit(arg === '::set-output name=cache-hit::true');
			}
		}
		// @ts-expect-error FIXME: not sure why arguments isn't allowed here
		return write.apply(process.stdout, arguments); // eslint-disable-line prefer-rest-params
	};
};
