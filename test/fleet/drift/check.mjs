import {
	mkdtempSync,
	readdirSync,
	rmSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import test from 'tape';

import {
	checkRepo,
	checkSafely,
	normalize,
	placeholders,
	templateFor,
} from '../../../fleet/drift/check.mjs';
import { evalModule, moduleURL } from './helpers/child.mjs';
import {
	nodeWorkflow,
	repoState,
	standardWorkflows,
	template,
} from './helpers/states.mjs';
import { versionFixture } from './helpers/versions.mjs';

/** @typedef {import('../../../fleet/drift/check.mjs').Result} Result */
/** @typedef {import('../../../fleet/lib/app.mjs').RepoState} RepoState */
/** @typedef {import('../../../fleet/lib/config.mjs').Config} Config */

/** @type {(names: string[]) => () => void} */
function overrideEnv(names) {
	/** @type {Map<string, string | undefined>} */
	const originals = new Map(names.map((name) => [name, process.env[name]]));
	return () => {
		for (const [name, value] of originals) {
			if (typeof value === 'string') {
				process.env[name] = value;
			} else {
				delete process.env[name];
			}
		}
	};
}

// every drifted file makes a temp dir for its diff; keep them all under one dir that is removed when this file's tests finish
const fileTemp = mkdtempSync(path.join(tmpdir(), 'fleet-check-test-'));
/** @type {null | (() => void)} */
let restoreFileTemp = null;

test('setup: RUNNER_TEMP for this file', (t) => {
	restoreFileTemp = overrideEnv(['RUNNER_TEMP']);
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

/** @type {(result: Result | null) => Result} */
function present(result) {
	if (!result) {
		throw new Error('expected a result');
	}
	return result;
}

/** @type {(result: Result | null) => Omit<Result, 'drifted'> & { drifted: string[] }} */
function summarize(result) {
	const r = present(result);
	return { ...r, drifted: r.drifted.map((d) => d.name) };
}

test('normalize', (t) => {
	t.equal(normalize('a\r\nb\rc\n'), 'a\nb\nc\n', 'normalizes line endings');
	t.equal(normalize('a  \nb\t\n'), 'a\nb\n', 'strips trailing whitespace');
	t.equal(normalize('a\n\n\n'), 'a\n', 'collapses trailing newlines to one');
	t.equal(normalize('a'), 'a\n', 'adds a final newline');
	t.equal(normalize(''), '\n', 'empty');
	t.equal(normalize('  a\n\n  b'), '  a\n\n  b\n', 'keeps leading indentation and inner blank lines');

	t.end();
});

test('placeholders', (t) => {
	t.deepEqual(placeholders(template('node.yml')), ['label', 'range', 'type', 'command'], 'each once, in order of first appearance');
	t.deepEqual(placeholders(template('rebase.yml')), [], 'a GitHub Actions expression is not a placeholder');

	t.end();
});

test('templateFor', (t) => {
	for (const name of ['rebase.yml', 'node-pretest.yml', 'require-allow-edits.yml']) {
		t.equal(templateFor(name), name, `${name} has its own template`);
	}
	for (const name of ['node.yml', 'node-aught.yml', 'node-tens.yml', 'node-twenties.yml', 'node-100s.yml']) {
		t.equal(templateFor(name), 'node.yml', `${name}, a node test shard, has the node template`);
	}
	for (const name of ['custom.yml', 'node-tests.yml', 'node.yaml', 'toString', '__proto__', 'hasOwnProperty']) {
		t.equal(templateFor(name), null, `${name} has no template`);
	}

	t.end();
});

test('checkRepo: an unreadable repository', async (t) => {
	t.deepEqual(await checkRepo(repoState({ stateError: 'could not read', workflows: null })), {
		repository: 'ljharb/repo',
		missing: [],
		unexpected: [],
		drifted: [],
		unreadable: [],
		error: 'could not read',
	}, 'reports only the state error, not every file as missing');

	t.end();
});

test('checkRepo: skipped repositories', async (t) => {
	t.equal(await checkRepo(repoState({ archived: true, workflows: null })), null, 'archived repos are skipped');
	t.equal(await checkRepo(repoState({ config: config(false), workflows: null })), null, 'opted-out repos are skipped');

	t.end();
});

test('checkRepo: a clean repository', async (t) => {
	t.equal(await checkRepo(repoState()), null, 'exactly the templates: no discrepancies');

	const messy = standardWorkflows().map(({ name, text }) => ({ name, text: `${text.replace(/\n/g, '  \r\n')}\n\n\n` }));
	t.equal(await checkRepo(repoState({ workflows: messy })), null, 'line endings and trailing whitespace are not drift');

	t.equal(
		await checkRepo(repoState({ workflows: withWorkflows([{ name: 'other.yml', text: 'anything' }, { name: 'weird.yml', text: null }]) })),
		null,
		'other workflow files are not reported',
	);

	t.end();
});

test('checkRepo: missing standard workflows', async (t) => {
	t.deepEqual(summarize(await checkRepo(repoState({ workflows: null }))), {
		repository: 'ljharb/repo',
		missing: ['node-pretest.yml', 'rebase.yml', 'require-allow-edits.yml'],
		unexpected: [],
		drifted: [],
		unreadable: [],
		error: null,
	}, 'no workflows directory: all the standard ones are missing, sorted');

	t.deepEqual(
		summarize(await checkRepo(repoState({ workflows: withWorkflows([], ['rebase.yml']) }))).missing,
		['rebase.yml'],
		'one missing',
	);

	t.end();
});

test('checkRepo: drift', async (t) => {
	const rebase = template('rebase.yml').replace('ubuntu', 'windows').replace('Automatic Rebase', 'Auto Rebase');
	const result = await checkRepo(repoState({ workflows: withWorkflows([{ name: 'rebase.yml', text: rebase }], ['rebase.yml']) }));
	const { drifted } = summarize(result);
	t.deepEqual(drifted, ['rebase.yml'], 'the changed file drifted');

	const [{ diff }] = present(result).drifted;
	t.match(diff, /^--- rebase\.yml \(actual\)\n\+\+\+ rebase\.yml \(expected\)\n/, 'a unified diff, labelled actual vs expected');
	t.match(diff, /^-name: Auto Rebase$/m, 'shows the actual line');
	t.match(diff, /^\+name: Automatic Rebase$/m, 'shows the expected line');

	t.end();
});

test('checkRepo: template placeholders', async (t) => {
	t.equal(
		await checkRepo(repoState({ workflows: withWorkflows([{ name: 'node.yml', text: nodeWorkflow({ label: '>= 0.8', range: '>= 0.8', command: 'npm run tests-only -- --x' }) }]) })),
		null,
		'any one-line values match the placeholders',
	);

	const mismatched = nodeWorkflow({ label: 'one' }).replace('name: \'node one\'', 'name: \'node two\'');
	const result = await checkRepo(repoState({ workflows: withWorkflows([{ name: 'node.yml', text: mismatched }]) }));
	t.deepEqual(summarize(result).drifted, ['node.yml'], 'a repeated placeholder must have the same value each time');
	const [{ diff }] = present(result).drifted;
	t.match(diff, /^-\s+name: 'node two'$/m, 'the actual line');
	t.match(diff, /^\+\s+name: 'node one'$/m, 'the expected line uses the value recovered from the first occurrence');
	t.doesNotMatch(diff, /range: /, 'lines that match are not in the diff');

	const multiline = nodeWorkflow().replace('range: \'>= 4\'', 'range: >\n        >= 4');
	const unguessable = await checkRepo(repoState({ workflows: withWorkflows([{ name: 'node.yml', text: multiline }]) }));
	t.deepEqual(summarize(unguessable).drifted, ['node.yml'], 'a placeholder never matches across lines');
	t.match(present(unguessable).drifted[0].diff, /^\+\s+range: '\{\{range\}\}'$/m, 'a value that can’t be recovered stays a placeholder in the expected text');

	t.end();
});

test('checkRepo: drifted files share one cached template', async (t) => {
	const results = await Promise.all(['a', 'b'].map((label) => checkRepo(repoState({
		repository: `ljharb/${label}`,
		workflows: withWorkflows([{ name: 'rebase.yml', text: `# ${label}\n${template('rebase.yml')}` }], ['rebase.yml']),
	}))));
	t.deepEqual(results.map((r) => summarize(r).drifted), [['rebase.yml'], ['rebase.yml']], 'both drift');
	t.match(present(results[1]).drifted[0].diff, /^-# b$/m, 'and each has its own diff');

	t.end();
});

test('checkRepo: diffs are written under RUNNER_TEMP when set', async (t) => {
	const runnerTemp = mkdtempSync(path.join(fileTemp, 'runner-temp-'));
	const restore = overrideEnv(['RUNNER_TEMP']);
	process.env.RUNNER_TEMP = runnerTemp;
	t.teardown(() => {
		restore();
		rmSync(runnerTemp, { recursive: true, force: true });
	});

	const result = await checkRepo(repoState({ workflows: withWorkflows([{ name: 'rebase.yml', text: 'nope' }], ['rebase.yml']) }));
	t.deepEqual(summarize(result).drifted, ['rebase.yml'], 'drifted');
	const dirs = readdirSync(runnerTemp);
	t.equal(dirs.length, 1, 'one temp dir was made');
	t.match(dirs[0], /^drift-/, 'named for drift');
	t.deepEqual(readdirSync(path.join(runnerTemp, dirs[0])).sort(), ['actual', 'expected'], 'holding the two sides of the diff');

	t.end();
});

test('checkRepo: diffs are written under the OS temp dir when RUNNER_TEMP is unset', async (t) => {
	const osTemp = mkdtempSync(path.join(fileTemp, 'os-temp-'));
	// `os.tmpdir()` reads these on every call
	const restore = overrideEnv([
		'RUNNER_TEMP',
		'TMPDIR',
		'TEMP',
		'TMP',
	]);
	delete process.env.RUNNER_TEMP;
	process.env.TMPDIR = osTemp;
	process.env.TEMP = osTemp;
	process.env.TMP = osTemp;
	t.teardown(() => {
		restore();
		rmSync(osTemp, { recursive: true, force: true });
	});
	t.equal(tmpdir(), osTemp, 'precondition: the OS temp dir is redirected');

	const result = await checkRepo(repoState({ workflows: withWorkflows([{ name: 'rebase.yml', text: 'nope' }], ['rebase.yml']) }));
	t.deepEqual(summarize(result).drifted, ['rebase.yml'], 'drifted');
	t.match(present(result).drifted[0].diff, /^-nope$/m, 'with a diff');
	const dirs = readdirSync(osTemp);
	t.equal(dirs.length, 1, 'one temp dir was made');
	t.match(dirs[0], /^drift-/, 'named for drift');

	t.end();
});

test('checkRepo: unreadable files', async (t) => {
	t.deepEqual(
		summarize(await checkRepo(repoState({ workflows: withWorkflows([{ name: 'rebase.yml', text: null }], ['rebase.yml']) }))),
		{
			repository: 'ljharb/repo',
			missing: [],
			unexpected: [],
			drifted: [],
			unreadable: ['rebase.yml'],
			error: null,
		},
		'a file whose contents could not be read is reported as unreadable',
	);

	t.end();
});

test('checkRepo: per-repository overrides', async (t) => {
	const result = await checkRepo(repoState({
		config: config({
			'rebase.yml': false, // present and drifted, but ignored
			'require-allow-edits.yml': false, // absent, and ignored
			'node-pretest.yml': true, // present and drifted, so still checked
			'custom.yml': true, // absent: missing
			'present.yml': true, // present: no template, so only its presence is checked
			'node-twenties.yml': true, // absent: missing, even with no `engines.node`
			'node.yml': false, // present and drifted, but ignored
		}),
		workflows: [
			{ name: 'rebase.yml', text: 'drifted' },
			{ name: 'node-pretest.yml', text: 'drifted' },
			{ name: 'present.yml', text: 'anything' },
			{ name: 'node.yml', text: 'drifted' },
		],
	}));
	t.deepEqual(summarize(result), {
		repository: 'ljharb/repo',
		missing: ['custom.yml', 'node-twenties.yml'],
		unexpected: [],
		drifted: ['node-pretest.yml'],
		unreadable: [],
		error: null,
	}, 'overrides decide what’s expected and what’s ignored');

	t.equal(
		await checkRepo(repoState({ config: config({ 'rebase.yml': false }), workflows: withWorkflows([], ['rebase.yml']) })),
		null,
		'an ignored, absent standard file is not missing',
	);

	t.end();
});

test('checkSafely', async (t) => {
	t.equal(await checkSafely(repoState()), null, 'a clean repository');

	/** @type {(thrown: unknown) => RepoState['workflows']} */
	const throwing = (thrown) => /** @type {RepoState['workflows']} */ (/** @type {unknown} */ ({ // eslint-disable-line no-extra-parens
		map() {
			throw thrown;
		},
	}));
	const empty = {
		repository: 'ljharb/repo', missing: [], unexpected: [], drifted: [], unreadable: [],
	};
	t.deepEqual(await checkSafely(repoState({ workflows: throwing(new Error('`engines.node` is `0.x`')) })), {
		...empty, error: 'could not be checked: `engines.node` is `0.x`',
	}, 'a public repository’s error is that repository’s, with its message');
	t.deepEqual(await checkSafely(repoState({ workflows: throwing('a string') })), { ...empty, error: 'could not be checked: a string' }, 'a non-Error is stringified');
	t.deepEqual(await checkSafely(repoState({ private: true, workflows: throwing(new Error('`engines.node` is `0.x`')) })), {
		...empty, error: 'could not be checked',
	}, 'a private repository’s error has no message');
	t.end();
});

test('checkRepo: node workflows without `engines.node` are only compared when present', async (t) => {
	const result = await checkRepo(repoState({
		packageJson: '{ "name": "x" }',
		workflows: withWorkflows([
			{ name: 'node.yml', text: nodeWorkflow() },
			{ name: 'node-tens.yml', text: 'drifted' },
			{ name: 'node-aught.yml', text: null },
		]),
	}));
	t.deepEqual(summarize(result), {
		repository: 'ljharb/repo',
		missing: [],
		unexpected: [],
		drifted: ['node-tens.yml'],
		unreadable: ['node-aught.yml'],
		error: null,
	}, 'present shards are compared against the node template; none are missing or unexpected');

	t.end();
});

test('checkRepo: config and package.json errors', async (t) => {
	t.deepEqual(
		summarize(await checkRepo(repoState({ configError: 'bad config' }))),
		{
			repository: 'ljharb/repo',
			missing: [],
			unexpected: [],
			drifted: [],
			unreadable: [],
			error: 'bad config',
		},
		'a config error alone is reported',
	);

	const invalid = summarize(await checkRepo(repoState({ packageJson: '{ nope' })));
	t.match(String(invalid.error), /^`package\.json` is not valid JSON: /, 'invalid package.json');

	t.equal(
		summarize(await checkRepo(repoState({ packageJson: '{ "engines": { "node": "not a range!" } }' }))).error,
		'`engines.node` in `package.json` is not a valid semver range: not a range!',
		'invalid `engines.node`',
	);

	t.equal(
		summarize(await checkRepo(repoState({ configError: 'bad config', packageJson: '{ "engines": { "node": "nope" } }', workflows: null }))).error,
		'bad config; `engines.node` in `package.json` is not a valid semver range: nope',
		'both errors, joined',
	);

	for (const packageJson of ['null', '[]', '{ "engines": null }', '{ "engines": { "node": 4 } }', '{ "engines": { "npm": ">= 4" } }']) {
		t.equal(await checkRepo(repoState({ packageJson })), null, `${packageJson}: no \`engines.node\` string, so no error and no node expectations`); // eslint-disable-line no-await-in-loop
	}

	t.end();
});

test('checkRepo: a non-Error thrown while parsing package.json', async (t) => {
	const { parse } = JSON;
	JSON.parse = () => {
		throw 'not an error'; // eslint-disable-line no-throw-literal
	};
	/** @type {Promise<Result | null>} */
	let promise;
	try {
		// `package.json` is parsed synchronously, before checkRepo's first `await`
		promise = checkRepo(repoState({ packageJson: '{}' }));
	} finally {
		JSON.parse = parse;
	}
	t.equal(summarize(await promise).error, '`package.json` is not valid JSON: not an error', 'stringifies the thrown value');

	t.end();
});

// `allVersions` is cached for the life of a process, so the version index is mocked in a child process of its own
test('checkRepo: node workflows per `engines.node`', (t) => {
	/** @type {(engines: string | null, workflows: { name: string, text: string | null }[], workflowsConfig?: Record<string, boolean>) => RepoState} */
	const state = (engines, workflows, workflowsConfig = {}) => repoState({
		packageJson: JSON.stringify(engines ? { engines: { node: engines } } : {}),
		workflows: withWorkflows(workflows),
		config: config(workflowsConfig),
	});
	const majors = nodeWorkflow({ type: 'majors' });
	const quotedMajors = nodeWorkflow({ type: '"majors"' });
	const cases = [
		['one file fits, and is present', state('^20', [{ name: 'node.yml', text: nodeWorkflow() }])],
		['one file fits, but is missing; another is present', state('^20', [{ name: 'node-tens.yml', text: nodeWorkflow() }])],
		['split by decade (minors)', state('>= 4 < 30', [{ name: 'node.yml', text: nodeWorkflow() }, { name: 'node-tens.yml', text: nodeWorkflow() }])],
		['all shards use `majors`, so one file fits', state('>= 4 < 30', [{ name: 'node-aught.yml', text: majors }, { name: 'node-tens.yml', text: quotedMajors }])],
		['mixed types count as `minors`', state('>= 4 < 30', [{ name: 'node-aught.yml', text: majors }, { name: 'node-tens.yml', text: nodeWorkflow() }])],
		['a shard with no `type` counts as `minors`', state('>= 4 < 30', [{ name: 'node.yml', text: 'name: node\n' }])],
		['an unreadable shard doesn’t decide the type', state('>= 4 < 30', [{ name: 'node-aught.yml', text: majors }, { name: 'node-tens.yml', text: null }])],
		['an override can ignore an expected shard', state('>= 4 < 30', [], { 'node-tens.yml': false, 'node-twenties.yml': true })],
		['no released versions satisfy the range', state('>= 1000', [{ name: 'node.yml', text: nodeWorkflow() }])],
	];

	const { status, stderr, output } = evalModule(`
		import { writeFileSync } from 'fs';
		import { checkRepo } from ${JSON.stringify(moduleURL('fleet/drift/check.mjs'))};

		const states = ${JSON.stringify(cases.map(([, s]) => s))};
		const results = [];
		for (const s of states) {
			results.push(await checkRepo(s));
		}
		writeFileSync(process.env.FLEET_TEST_OUT, JSON.stringify(results));
	`, { versions: versionFixture() });
	t.equal(status, 0, 'the child succeeds');
	t.equal(stderr, '', 'with nothing on stderr');

	const results = /** @type {(Result | null)[]} */ (output); // eslint-disable-line no-extra-parens
	const expected = [
		null,
		{ missing: ['node.yml'], unexpected: ['node-tens.yml'], drifted: [], unreadable: [] },
		{ missing: ['node-aught.yml', 'node-twenties.yml'], unexpected: ['node.yml'], drifted: [], unreadable: [] },
		{ missing: ['node.yml'], unexpected: ['node-aught.yml', 'node-tens.yml'], drifted: [], unreadable: [] },
		{ missing: ['node-twenties.yml'], unexpected: [], drifted: [], unreadable: [] },
		{ missing: ['node-aught.yml', 'node-tens.yml', 'node-twenties.yml'], unexpected: ['node.yml'], drifted: [], unreadable: [] },
		{ missing: ['node.yml'], unexpected: ['node-aught.yml', 'node-tens.yml'], drifted: [], unreadable: [] },
		{ missing: ['node-aught.yml', 'node-twenties.yml'], unexpected: [], drifted: [], unreadable: [] },
		{ missing: [], unexpected: ['node.yml'], drifted: [], unreadable: [] },
	];
	cases.forEach(([label], i) => {
		const result = results[i];
		t.deepEqual(
			result && {
				missing: result.missing, unexpected: result.unexpected, drifted: result.drifted.map((d) => d.name), unreadable: result.unreadable,
			},
			expected[i],
			String(label),
		);
		t.equal(result?.error ?? null, null, `${label}: no error`);
	});

	t.end();
});

test('cleanup: RUNNER_TEMP for this file', (t) => {
	if (restoreFileTemp) {
		restoreFileTemp();
	}
	rmSync(fileTemp, { recursive: true, force: true });
	t.end();
});
