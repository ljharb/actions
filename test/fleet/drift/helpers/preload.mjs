// loaded via `node --import` into child processes; does nothing unless `FLEET_TEST_SCENARIO` is set
import { appendFileSync, readFileSync } from 'fs';

import nock from 'nock';

import { mockGitHub } from '../../lib/helpers/github.mjs';
import { mockVersions } from './versions.mjs';

/**
 * @typedef {{
 *   versions?: import('./versions.mjs').VersionFixture,
 *   github?: import('../../lib/helpers/github.mjs').Scenario,
 *   log?: string,
 *   throwStringOnSplit?: string,
 * }} ChildScenario
 */

const { FLEET_TEST_SCENARIO } = process.env;

if (FLEET_TEST_SCENARIO) {
	/** @type {ChildScenario} */
	const scenario = JSON.parse(readFileSync(FLEET_TEST_SCENARIO, 'utf8'));

	nock.disableNetConnect();

	if (scenario.versions) {
		mockVersions(scenario.versions);
	}

	const { log } = scenario;
	if (scenario.github && log) {
		mockGitHub(scenario.github, (r) => appendFileSync(log, `${JSON.stringify(r)}\n`));
	}

	// for exercising the handling of a thrown non-Error: `split` throws a string, but only for this exact input
	const sentinel = scenario.throwStringOnSplit;
	if (sentinel) {
		const { split } = String.prototype;
		// eslint-disable-next-line no-extend-native
		String.prototype.split = /** @type {typeof split} */ (/** @type {unknown} */ (function (/** @type {any[]} */ ...args) { // eslint-disable-line no-extra-parens
			if (String(this) === sentinel) {
				throw sentinel;
			}
			// @ts-expect-error spreading into an overloaded signature
			return split.apply(this, args);
		}));
	}
}
