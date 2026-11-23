import { spawnSync } from 'child_process';
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import test from 'tape';

import { checkRepo } from '../../../fleet/drift/check.mjs';
import { planFixes } from '../../../fleet/drift/fix.mjs';
import { normalize } from '../../../fleet/drift/template.mjs';
import { evalModule, moduleURL } from './helpers/child.mjs';
import {
	nodeWorkflow,
	repoState,
	standardWorkflows,
	template,
} from './helpers/states.mjs';
import { versionFixture } from './helpers/versions.mjs';

/** @import { Plan, Category, Filters } from '../../../fleet/drift/fix.mjs' */
/** @import { Result } from '../../../fleet/drift/check.mjs' */
/** @import { RepoState } from '../../../fleet/lib/app.mjs' */
/** @import { Config } from '../../../fleet/lib/config.mjs' */

// every drifted file makes a temp dir for its diff; keep them all under one dir that is removed when this file's tests finish
const fileTemp = mkdtempSync(path.join(tmpdir(), 'fleet-fix-test-'));
const originalRunnerTemp = process.env.RUNNER_TEMP;

test('setup: RUNNER_TEMP for this file', (t) => {
	process.env.RUNNER_TEMP = fileTemp;
	t.end();
});

/** @type {(workflows: Record<string, boolean> | false) => Config} */
function config(workflows) {
	return { workflows, readme: true, keep: {} };
}

/** @type {(extra: { name: string, text: string | null }[], without?: string[]) => RepoState['workflows']} */
function withWorkflows(extra, without = []) {
	return [...standardWorkflows().filter((f) => !without.includes(f.name)), ...extra];
}

/** @type {(name: string) => string} */
function at(name) {
	return `.github/workflows/${name}`;
}

/** @type {(state: RepoState, filters?: Filters) => Promise<Plan>} */
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
	t.deepEqual(await plan(state, { categories: new Set(['missing']) }), { ...empty, writes: [missing] }, 'by category');
	t.deepEqual(
		await plan(state, { files: new Set(['rebase.yml']), categories: new Set(['missing']) }),
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
		await cases.reduce(
			async (previous, { state, files, categories }) => {
				await previous;
				plans.push(await planFixes(state, await checkRepo(state), { files: files && new Set(files), categories: categories && new Set(categories) }));
			},
			Promise.resolve(),
		);
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

test('planFixes: a rewritten file keeps the inputs the repository keeps', async (t) => {
	const pretest = `${template('node-pretest.yml')}    with:\n      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+\n      bogus: 1\n`;
	const workflows = withWorkflows([{ name: 'node-pretest.yml', text: pretest }], ['node-pretest.yml']);

	const plain = await plan(repoState({ workflows }));
	t.deepEqual(plain.writes.map((w) => [w.path, w.content]), [[at('node-pretest.yml'), template('node-pretest.yml')]], 'without `keep`, rewritten from its template');

	const keepBoth = { workflows: {}, readme: true, keep: { 'node-pretest.yml': ['skip-engines'], 'rebase.yml': ['nothing'] } };
	const kept = await plan(repoState({
		workflows,
		config: keepBoth,
	}));
	t.deepEqual(kept.writes.map((w) => [w.path, w.content]), [[at('node-pretest.yml'), `${template('node-pretest.yml')}    with:\n      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+\n`]], 'with it, keeping the kept input’s value and comment, and only that');

	const keepConfig = { workflows: {}, readme: true, keep: { 'node-pretest.yml': ['skip-engines'] } };
	const renamed = await plan(repoState({ workflows: withWorkflows([{ name: 'node-pretest.yml', text: pretest.replace('  tests:', '  pretest:') }], ['node-pretest.yml']), config: keepConfig }));
	t.deepEqual(renamed.writes.map((w) => [w.path, w.content]), kept.writes.map((w) => [w.path, w.content]), 'from a job with another id than the template’s, too');

	const twice = 'jobs:\n  a:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-engines: true\n  b:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-engines: true\n';
	const ambiguous = await plan(repoState({ workflows: withWorkflows([{ name: 'node-pretest.yml', text: twice }], ['node-pretest.yml']), config: keepConfig }));
	t.deepEqual(ambiguous, {
		writes: [],
		deletes: [],
		skipped: [{ path: at('node-pretest.yml'), why: 'the kept inputs can’t all be kept: job “a” passes skip-engines to pretest.yml, but no job with that id calls it now, and which other call of it should get them is ambiguous; job “b” passes skip-engines to pretest.yml, but no job with that id calls it now, and which other call of it should get them is ambiguous' }],
	}, 'but when which call it’s kept from is ambiguous, the file is skipped, rather than dropping it');
	t.end();
});

/** @type {(name: string, actual: string, expected: string) => string} */
function diffOf(name, actual, expected) {
	const dir = mkdtempSync(path.join(fileTemp, 'diff-'));
	writeFileSync(path.join(dir, 'actual'), actual);
	writeFileSync(path.join(dir, 'expected'), expected);
	const args = [
		'-u',
		'--label',
		`${name} (actual)`,
		'--label',
		`${name} (expected)`,
		path.join(dir, 'actual'),
		path.join(dir, 'expected'),
	];
	return spawnSync('diff', args, { encoding: 'utf8' }).stdout;
}

// `allVersions` is cached for the life of a process, so the version index is mocked in a child process of its own
test('planFixes: a drifted file’s diff is against exactly what fixing it writes', (t) => {
	const tensOpen = nodeWorkflow({ range: '>= 10', label: '>= 10' });
	const keepEngines = { workflows: {}, readme: true, keep: { 'node-pretest.yml': ['skip-engines'] } };
	/** @type {[label: string, engines: string | null, workflows: { name: string, text: string | null }[], config?: Config][]} */
	const cases = [
		[
			'no aggregating job, so no label to recover',
			'^20',
			[{ name: 'node.yml', text: nodeWorkflow({ range: '^20', label: '^20' }).replace('name: \'Tests: node.js ^20\'', 'name: \'Tests: node.js\'').replace(/\n {2}node:\n[^]*$/, '\n') }],
		],
		[
			'an unrecoverable range, in a shard',
			'>= 4 < 30',
			[
				{ name: 'node-aught.yml', text: nodeWorkflow({ range: '>= 4 < 10', label: '4 - 10' }) },
				{ name: 'node-tens.yml', text: multilineRange },
				{ name: 'node-twenties.yml', text: nodeWorkflow({ range: '>= 20', label: '>= 20' }) },
			],
		],
		[
			'an unrecoverable range, in the first shard, which starts where `engines.node` does',
			'>= 12 < 30',
			[
				{ name: 'node-tens.yml', text: multilineRange },
				{ name: 'node-twenties.yml', text: nodeWorkflow({ range: '>= 20', label: '>= 20' }) },
			],
		],
		[
			'a drifted open-ended shard, closed where an added one starts',
			'>= 4 < 30',
			[
				{ name: 'node-aught.yml', text: nodeWorkflow({ range: '>= 4 < 10', label: '4 - 10' }) },
				{ name: 'node-tens.yml', text: `# drifted too\n${tensOpen}` },
			],
		],
		[
			'a blank range, in the last shard',
			'>= 4 < 30',
			[
				{ name: 'node-aught.yml', text: nodeWorkflow({ range: '>= 4 < 10', label: '4 - 10' }) },
				{ name: 'node-tens.yml', text: nodeWorkflow({ range: '>= 10 < 20', label: '10 - 20' }) },
				{ name: 'node-twenties.yml', text: `# drifted\n${nodeWorkflow({ range: '', label: '>= 20' })}` },
			],
		],
		[
			'a kept input',
			null,
			[{ name: 'node-pretest.yml', text: `${template('node-pretest.yml')}    with:\n      skip-engines: true\n      bogus: 1\n` }],
			keepEngines,
		],
	];
	const states = cases.map(([, engines, workflows, workflowsConfig = { workflows: {}, readme: true, keep: {} }]) => repoState({
		packageJson: JSON.stringify(engines ? { engines: { node: engines } } : {}),
		workflows: withWorkflows(workflows, workflows.map((w) => w.name)),
		config: workflowsConfig,
	}));

	const source = `
		import { writeFileSync } from 'fs';
		import { checkRepo } from ${JSON.stringify(moduleURL('fleet/drift/check.mjs'))};
		import { planFixes } from ${JSON.stringify(moduleURL('fleet/drift/fix.mjs'))};

		const states = ${JSON.stringify(states)};
		const out = [];
		await states.reduce(
			async (previous, state) => {
				await previous;
				const result = await checkRepo(state);
				out.push({ result, plan: await planFixes(state, result) });
			},
			Promise.resolve(),
		);
		writeFileSync(process.env.FLEET_TEST_OUT, JSON.stringify(out));
	`;
	const { status, stderr, output } = evalModule(source, { versions: versionFixture() });
	t.equal(status, 0, 'the child succeeds');
	t.equal(stderr, '', 'with nothing on stderr');

	const out = /** @type {{ result: Result | null, plan: Plan }[]} */ (output); // eslint-disable-line no-extra-parens
	cases.forEach(([label, , workflows], i) => {
		const { result, plan: { writes } } = out[i];
		const drifted = result?.drifted ?? [];
		t.notEqual(drifted.length, 0, `${label}: drifts`);
		t.deepEqual(drifted.map((d) => d.name), workflows.map((w) => w.name).filter((name) => writes.some((w) => w.path === at(name) && w.reason !== 'missing')), `${label}: each rewritten file drifted`);
		t.equal(result?.error ?? null, null, `${label}: with no error`);
		drifted.forEach(({ name, diff }) => {
			const actual = normalize(String(workflows.find((w) => w.name === name)?.text));
			const write = writes.find((w) => w.path === at(name));
			t.equal(diff, diffOf(name, actual, String(write?.content)), `${label}: ${name}’s diff is against what fixing it writes`);
			t.doesNotMatch(diff, /\{\{\w+\}\}/, `${label}: ${name}’s diff has no placeholder`);
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
