// loaded via `node --import` into child processes; does nothing unless `FLEET_TEST_SCENARIO` is set
import { appendFileSync, readFileSync } from 'fs';

import nock from 'nock';

import { mockGitHub } from '../../lib/helpers/github.mjs';
import { mockReport } from './report.mjs';
import { mockVersions } from './versions.mjs';

/** @import { VersionFixture } from './versions.mjs' */
/** @import { ReportScenario } from './report.mjs' */
/** @import { Scenario } from '../../lib/helpers/github.mjs' */

/**
 * @typedef {{
 *   versions?: VersionFixture,
 *   github?: Scenario,
 *   report?: ReportScenario,
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
	if (scenario.report && log) {
		mockReport(scenario.report, (r) => appendFileSync(log, `${JSON.stringify(r)}\n`));
	}

	// for exercising the handling of a thrown non-Error: `split` throws a string, but only for this exact input
	const sentinel = scenario.throwStringOnSplit;
	if (sentinel) {
		const { split } = String.prototype;
		/**
		 * @this {string}
		 * @param {any[]} args
		 * @returns {string[]}
		 */
		String.prototype.split = function (...args) { // eslint-disable-line no-extend-native
			if (String(this) === sentinel) {
				throw sentinel;
			}
			// @ts-expect-error spreading into an overloaded signature
			return split.apply(this, args);
		};
	}
}
