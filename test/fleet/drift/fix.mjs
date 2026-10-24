import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import test from 'tape';

import { checkRepo } from '../../../fleet/drift/check.mjs';
import { planFixes } from '../../../fleet/drift/fix.mjs';
import { evalModule, moduleURL } from './helpers/child.mjs';
import {
	nodeWorkflow,
	repoState,
	standardWorkflows,
	template,
} from './helpers/states.mjs';
import { versionFixture } from './helpers/versions.mjs';

/** @typedef {import('../../../fleet/drift/fix.mjs').Plan} Plan */
/** @typedef {import('../../../fleet/drift/fix.mjs').Category} Category */
/** @typedef {import('../../../fleet/lib/app.mjs').RepoState} RepoState */
/** @typedef {import('../../../fleet/lib/config.mjs').Config} Config */

// every drifted file makes a temp dir for its diff; keep them all under one dir that is removed when this file's tests finish
const fileTemp = mkdtempSync(path.join(tmpdir(), 'fleet-fix-test-'));
const originalRunnerTemp = process.env.RUNNER_TEMP;

test('setup: RUNNER_TEMP for this file', (t) => {
	process.env.RUNNER_TEMP = fileTemp;
	t.end();
});

/** @type {(workflows: Record<string, boolean> | false) => Config} */
function config(workflows) {
	return /** @type {Config} */ ({ workflows }); // eslint-disable-line no-extra-parens
}

/** @type {(extra: { name: string, text: string | null }[], without?: string[]) => RepoState['workflows']} */
function withWorkflows(extra, without = []) {
	return [...standardWorkflows().filter((f) => !without.includes(f.name)), ...extra];
}

/** @type {(name: string) => string} */
function at(name) {
	return `.github/workflows/${name}`;
}

/** @type {(state: RepoState, filters?: import('../../../fleet/drift/fix.mjs').Filters) => Promise<Plan>} */
async function plan(state, filters) {
	return planFixes(state, await checkRepo(state), filters);
}

const empty = { writes: [], deletes: [], skipped: [] };

// a node workflow whose `range` spans two lines, which a one-line placeholder can't recover
const multilineRange = nodeWorkflow({ range: '>= 10', label: '>= 10' }).replace('range: \'>= 10\'', 'range: >\n        >= 10');

test('planFixes: nothing to fix', async (t) => {
	t.deepEqual(await planFixes(repoState(), null), empty, 'no result: no changes');
	t.deepEqual(await plan(repoState()), empty, 'a clean repository: no changes');
	t.deepEqual(
		await plan(repoState({ stateError: 'could not read', config: config(false), workflows: null })),
		empty,
		'an unreadable repository: its error is reported, but there’s nothing to change',
	);

	t.end();
});

test('planFixes: standard workflows', async (t) => {
	t.deepEqual(await plan(repoState({ workflows: null })), {
		writes: ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'].map((name) => ({ path: at(name), content: template(name), reason: 'missing' })),
		deletes: [],
		skipped: [],
	}, 'missing files are written from their templates, in path order');

	const drifted = withWorkflows([
		{ name: 'rebase.yml', text: template('rebase.yml').replace('Automatic Rebase', 'Auto Rebase') },
		{ name: 'require-allow-edits.yml', text: '# nope\n' },
	], ['rebase.yml', 'require-allow-edits.yml']);
	t.deepEqual(await plan(repoState({ workflows: drifted })), {
		writes: ['rebase.yml', 'require-allow-edits.yml'].map((name) => ({ path: at(name), content: template(name), reason: 'drifted' })),
		deletes: [],
		skipped: [],
	}, 'drifted files are rewritten to their templates');

	t.end();
});

test('planFixes: files that can’t be written', async (t) => {
	t.deepEqual(await plan(repoState({ config: config({ 'custom.yml': true }) })), {
		writes: [],
		deletes: [],
		skipped: [{ path: at('custom.yml'), why: 'there is no template for it' }],
	}, 'a missing file with no template is skipped');

	t.deepEqual(await plan(repoState({ config: config({ 'node-twenties.yml': true }) })), {
		writes: [],
		deletes: [],
		skipped: [{ path: at('node-twenties.yml'), why: 'there is no valid `engines.node` in `package.json` to derive its node version range from' }],
	}, 'a missing node test file with no `engines.node` is skipped');

	t.deepEqual(await plan(repoState({ packageJson: '{ "engines": { "node": "nope" } }', workflows: withWorkflows([{ name: 'node.yml', text: multilineRange }]) })), {
		writes: [],
		deletes: [],
		skipped: [{ path: at('node.yml'), why: '`{{range}}` could not be recovered from the current file, and there is no valid `engines.node` in `package.json` to derive its node version range from' }],
	}, 'a drifted node test file with an unrecoverable value and no valid `engines.node` is skipped, never written with a placeholder');

	t.deepEqual(await plan(repoState({ workflows: withWorkflows([{ name: 'node.yml', text: null }]) })), empty, 'unreadable files are left alone');

	t.end();
});

test('planFixes: drifted node test files keep their own values', async (t) => {
	const values = {
		label: '>= 0.8', range: '>= 0.8', type: 'majors', command: 'npm run tests-only -- --x',
	};
	const state = repoState({ workflows: withWorkflows([{ name: 'node.yml', text: `# a comment\n${nodeWorkflow(values)}` }]) });
	t.deepEqual(await plan(state), {
		writes: [{ path: at('node.yml'), content: nodeWorkflow(values), reason: 'drifted' }],
		deletes: [],
		skipped: [],
	}, 'every value is recovered, so `engines.node` isn’t needed');

	t.end();
});

test('planFixes: filters', async (t) => {
	const state = repoState({
		workflows: withWorkflows([{ name: 'rebase.yml', text: '# nope\n' }], ['rebase.yml', 'node-pretest.yml']),
	});
	const drifted = { path: at('rebase.yml'), content: template('rebase.yml'), reason: 'drifted' };
	const missing = { path: at('node-pretest.yml'), content: template('node-pretest.yml'), reason: 'missing' };
	const all = { writes: [missing, drifted], deletes: [], skipped: [] };

	t.deepEqual(await plan(state), all, 'no filters: everything');
	t.deepEqual(await plan(state, { files: new Set(), categories: new Set() }), all, 'empty filters: everything');
	t.deepEqual(await plan(state, { files: new Set(['rebase.yml']) }), { ...empty, writes: [drifted] }, 'by file name');
	t.deepEqual(await plan(state, { categories: new Set(/** @type {Category[]} */ (['missing'])) }), { ...empty, writes: [missing] }, 'by category'); // eslint-disable-line no-extra-parens
	t.deepEqual(
		await plan(state, { files: new Set(['rebase.yml']), categories: new Set(/** @type {Category[]} */ (['missing'])) }), // eslint-disable-line no-extra-parens
		empty,
		'both must match',
	);

	t.end();
});

/** @typedef {[label: string, engines: string | null, workflows: { name: string, text: string | null }[], options?: { config?: Record<string, boolean>, files?: string[], categories?: Category[] }]} Case */

// `allVersions` is cached for the life of a process, so the version index is mocked in a child process of its own
test('planFixes: node test files per `engines.node`', (t) => {
	const tensOpen = nodeWorkflow({ range: '>= 10', label: '>= 10' });
	// both `name:` lines edited, so `{{label}}` can't be recovered
	const unlabeled = tensOpen.replace('name: \'Tests: node.js >= 10\'', 'name: \'Tests: >= 10\'').replace('name: \'node >= 10\'', 'name: \'node.js >= 10\'');
	/** @type {Case[]} */
	const cases = [
		['one file, from `engines.node`', '^20', []],
		[
			'decade shards, the first starting at 0',
			'>= 0.8 < 30',
			[],
		],
		[
			'decade shards past `nineties`, the first starting where `engines.node` does',
			'>= 8',
			[],
		],
		[
			'the first shard starts where `engines.node` does, past its decade’s start',
			'>= 12 < 30',
			[],
		],
		[
			'`majors`, from the existing node test files; a shard no longer needed is deleted',
			'>= 4',
			[{ name: 'node-aught.yml', text: nodeWorkflow({ type: 'majors' }) }],
		],
		[
			'a shard added after an open-ended one closes it',
			'>= 4 < 30',
			[
				{ name: 'node-aught.yml', text: nodeWorkflow({ range: '>= 4 < 10', label: '4 - 10' }) },
				{ name: 'node-tens.yml', text: `# drifted too\n${tensOpen}` },
			],
		],
		[
			'only drift: no shard is added, so the open-ended one stays open',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: `# drifted too\n${tensOpen}` }],
			{ categories: ['drifted'] },
		],
		[
			'only the added shard: its range rewrite comes with it',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: `# drifted too\n${tensOpen}` }],
			{ files: ['node-twenties.yml'] },
		],
		[
			'only open-ended alternatives are closed; a label without `>=` gets a bound',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: nodeWorkflow({ range: '^8 || >= 10', label: 'tens' }) }],
			{ files: ['node-twenties.yml'] },
		],
		[
			'a closed predecessor is only fixed for drift',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: `# drifted\n${nodeWorkflow({ range: '>= 10 < 20', label: '10 - 20' })}` }],
			{ files: ['node-tens.yml', 'node-twenties.yml'] },
		],
		[
			'an unrecoverable range: the predecessor gets its defaults, label and all',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: multilineRange }],
			{ files: ['node-tens.yml', 'node-twenties.yml'] },
		],
		[
			'an unrecoverable label: the predecessor gets its defaults, range and all, never a default label closed again',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: unlabeled }],
			{ files: ['node-twenties.yml'] },
		],
		[
			'a blank range is unrecovered, never closed to `< 20`',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: nodeWorkflow({ range: '', label: '>= 10' }) }],
			{ files: ['node-twenties.yml'] },
		],
		[
			'an unrecoverable type alone keeps the recovered range and label',
			'^20',
			[{ name: 'node.yml', text: nodeWorkflow({ range: '^20', label: '^20', type: 'majors' }).replace('type: majors', 'type:\n        majors') }],
		],
		[
			'only missing files: an open-ended predecessor is still closed',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: `# drifted too\n${tensOpen}` }],
			{ categories: ['missing'] },
		],
		[
			'an unexpected open-ended shard is never closed, even when it isn’t deleted',
			'>= 12 < 30',
			[{ name: 'node-aught.yml', text: nodeWorkflow({ range: '>= 4', label: '>= 4' }) }],
			{ categories: ['missing'] },
		],
		[
			'an unexpected shard is deleted only when its name is wanted',
			'>= 4',
			[{ name: 'node-aught.yml', text: nodeWorkflow({ type: 'majors' }) }],
			{ files: ['node.yml'] },
		],
		[
			'an unreadable predecessor',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: null }],
			{ files: ['node-twenties.yml'] },
		],
		[
			'a predecessor with an invalid range',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: nodeWorkflow({ range: 'nope', label: 'nope' }) }],
			{ files: ['node-twenties.yml'] },
		],
		[
			'an ignored predecessor',
			'>= 4 < 30',
			[{ name: 'node-tens.yml', text: tensOpen }],
			{ config: { 'node-tens.yml': false }, files: ['node-twenties.yml'] },
		],
		[
			'a shard `engines.node` doesn’t need has no known range',
			'^20',
			[{ name: 'node.yml', text: nodeWorkflow({ range: '^20', label: '^20' }) }, { name: 'node-tens.yml', text: multilineRange }],
			{ config: { 'node-twenties.yml': true, 'node-tens.yml': true } },
		],
	];
	const states = cases.map(([, engines, workflows, { config: workflowsConfig = {}, files, categories } = {}]) => ({
		state: repoState({
			packageJson: JSON.stringify(engines ? { engines: { node: engines } } : {}),
			workflows: withWorkflows(workflows),
			config: config(workflowsConfig),
		}),
		files,
		categories,
	}));

	const { status, stderr, output } = evalModule(`
		import { writeFileSync } from 'fs';
		import { checkRepo } from ${JSON.stringify(moduleURL('fleet/drift/check.mjs'))};
		import { planFixes } from ${JSON.stringify(moduleURL('fleet/drift/fix.mjs'))};

		const cases = ${JSON.stringify(states)};
		const plans = [];
		for (const { state, files, categories } of cases) {
			plans.push(await planFixes(state, await checkRepo(state), { files: files && new Set(files), categories: categories && new Set(categories) }));
		}
		writeFileSync(process.env.FLEET_TEST_OUT, JSON.stringify(plans));
	`, { versions: versionFixture() });
	t.equal(status, 0, 'the child succeeds');
	t.equal(stderr, '', 'with nothing on stderr');

	/** @type {(name: string, values: Parameters<typeof nodeWorkflow>[0], reason: Plan['writes'][number]['reason']) => Plan['writes'][number]} */
	const node = (name, values, reason) => ({ path: at(name), content: nodeWorkflow(values), reason });
	/** @type {Plan[]} */
	const expected = [
		{ ...empty, writes: [node('node.yml', { range: '^20', label: '^20' }, 'missing')] },
		{
			...empty,
			writes: [
				node('node-aught.yml', { range: '< 10', label: '< 10' }, 'missing'),
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'missing'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-100s.yml', { range: '>= 100', label: '>= 100' }, 'missing'),
				node('node-aught.yml', { range: '>= 8 < 10', label: '8 - 10' }, 'missing'),
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'missing'),
				node('node-thirties.yml', { range: '>= 30 < 40', label: '30 - 40' }, 'missing'),
				node('node-twenties.yml', { range: '>= 20 < 30', label: '20 - 30' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 12 < 20', label: '12 - 20' }, 'missing'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			writes: [node('node.yml', { range: '>= 4', label: '>= 4', type: 'majors' }, 'missing')],
			deletes: [{ path: at('node-aught.yml'), reason: 'unexpected' }],
			skipped: [],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'range'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{ ...empty, writes: [node('node-tens.yml', { range: '>= 10', label: '>= 10' }, 'drifted')] },
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'range'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '^8 || >= 10 < 20', label: 'tens < 20' }, 'range'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'drifted'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'range'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'range'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'range'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{ ...empty, writes: [node('node.yml', { range: '^20', label: '^20', type: 'majors' }, 'drifted')] },
		{
			...empty,
			writes: [
				node('node-aught.yml', { range: '>= 4 < 10', label: '4 - 10' }, 'missing'),
				node('node-tens.yml', { range: '>= 10 < 20', label: '10 - 20' }, 'range'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{
			...empty,
			writes: [
				node('node-tens.yml', { range: '>= 12 < 20', label: '12 - 20' }, 'missing'),
				node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing'),
			],
		},
		{ ...empty, writes: [node('node.yml', { range: '>= 4', label: '>= 4', type: 'majors' }, 'missing')] },
		{
			writes: [node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing')],
			deletes: [],
			skipped: [{ path: at('node-tens.yml'), why: 'it could not be read, so whether it overlaps the added `node-twenties.yml` is unknown' }],
		},
		{
			writes: [node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing')],
			deletes: [],
			skipped: [{ path: at('node-tens.yml'), why: 'its range, `nope`, is not a valid semver range, so whether it overlaps the added `node-twenties.yml` is unknown' }],
		},
		{
			writes: [node('node-twenties.yml', { range: '>= 20', label: '>= 20' }, 'missing')],
			deletes: [],
			skipped: [{ path: at('node-tens.yml'), why: 'it’s ignored by `ljharb-actions.json`, so it’s left as it is, though it may overlap the added `node-twenties.yml`' }],
		},
		{
			writes: [],
			deletes: [],
			skipped: [
				{ path: at('node-tens.yml'), why: '`{{range}}` could not be recovered from the current file, and `engines.node` (`^20`) doesn’t need it, so its node version range is unknown' },
				{ path: at('node-twenties.yml'), why: '`engines.node` (`^20`) doesn’t need it, so its node version range is unknown' },
			],
		},
	];
	const plans = /** @type {Plan[]} */ (output); // eslint-disable-line no-extra-parens
	cases.forEach(([label], i) => {
		t.deepEqual(plans[i], expected[i], label);
	});
	plans.forEach((p) => {
		p.writes.forEach((w) => {
			t.doesNotMatch(w.content, /\{\{\w+\}\}/, `${w.path} has no placeholders left`);
		});
	});

	t.end();
});

test('cleanup: RUNNER_TEMP for this file', (t) => {
	if (typeof originalRunnerTemp === 'string') {
		process.env.RUNNER_TEMP = originalRunnerTemp;
	} else {
		delete process.env.RUNNER_TEMP;
	}
	rmSync(fileTemp, { recursive: true, force: true });
	t.end();
});
