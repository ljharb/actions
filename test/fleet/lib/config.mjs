import test from 'tape';

import { mergeConfig, parseConfig } from '../../../fleet/lib/config.mjs';

/** @import { Config } from '../../../fleet/lib/config.mjs' */

const file = '`some/file.json`';

test('parseConfig: no config file', (t) => {
	[undefined, null].forEach((text) => {
		const { config, error } = parseConfig(text, file);
		t.equal(error, null, `${text}: no error`);
		t.deepEqual(config, {}, `${text}: sets nothing`);
	});

	t.end();
});

test('parseConfig: invalid JSON', (t) => {
	const { config, error } = parseConfig('{ nope', file);
	t.equal(error, '`some/file.json` is not valid JSON', 'reports that the file is not valid JSON, labeled with the file');
	t.deepEqual(config, {}, 'sets nothing');

	t.end();
});

test('parseConfig: invalid JSON does not leak the file’s contents', (t) => {
	const secret = 'ghp_SuperSecretToken0123456789abcdef';
	[
		`{ "token": "${secret}" `,
		`{ "token": ${secret} }`,
		`${secret}`,
		`{ "workflows": true, "${secret}" }`,
	].forEach((text) => {
		const { config, error } = parseConfig(text, file);
		t.equal(error, '`some/file.json` is not valid JSON', `${JSON.stringify(text)}: only the label, and no parse details`);
		t.notOk(String(error).includes('SuperSecret'), `${JSON.stringify(text)}: no part of the secret`);
		t.notOk(String(error).includes('token'), `${JSON.stringify(text)}: no other part of the file`);
		t.deepEqual(config, {}, `${JSON.stringify(text)}: sets nothing`);
	});

	t.end();
});

test('parseConfig: a non-Error thrown while parsing', (t) => {
	const { parse } = JSON;
	JSON.parse = () => {
		throw 'not an error'; // eslint-disable-line no-throw-literal
	};
	try {
		const { error } = parseConfig('{}', file);
		t.equal(error, '`some/file.json` is not valid JSON', 'the thrown value is not included');
	} finally {
		JSON.parse = parse;
	}

	t.end();
});

test('parseConfig: not an object', (t) => {
	['null', '[]', '1', '"str"', 'true'].forEach((text) => {
		const { config, error } = parseConfig(text, file);
		t.equal(error, '`some/file.json` must contain a JSON object', `${text}: rejected`);
		t.deepEqual(config, {}, `${text}: sets nothing`);
	});

	t.end();
});

test('parseConfig: file labels', (t) => {
	t.equal(parseConfig('{', 'first').error, 'first is not valid JSON', 'invalid JSON uses the label');
	t.equal(parseConfig('[]', 'second').error, 'second must contain a JSON object', 'a non-object uses the label');
	t.match(String(parseConfig('{ "workflows": 1 }', 'third').error), /^third: `workflows` must be /, 'an invalid key uses the label');

	t.end();
});

test('parseConfig: empty object', (t) => {
	const { config, error } = parseConfig('{}', file);
	t.equal(error, null, 'no error');
	t.deepEqual(config, {}, 'sets nothing');
	t.notOk('workflows' in config, 'leaves `workflows` unset, so it can be merged');

	t.end();
});

test('parseConfig: workflows opt-out', (t) => {
	const { config, error } = parseConfig('{ "workflows": false }', file);
	t.equal(error, null, 'no error');
	t.equal(config.workflows, false, '`false` opts out');

	t.end();
});

test('parseConfig: workflows opt-in with `true`', (t) => {
	const { config, error } = parseConfig('{ "workflows": true }', file);
	t.equal(error, null, 'no error');
	t.ok('workflows' in config, 'sets `workflows`');
	t.deepEqual(config.workflows, {}, '`true` is the same as `{}`');

	const other = parseConfig('{ "workflows": true }', file).config;
	t.notEqual(other.workflows, config.workflows, 'each call gets its own object');

	t.end();
});

test('parseConfig: workflow overrides', (t) => {
	const { config, error } = parseConfig(JSON.stringify({
		workflows: {
			'node-twenties.yml': true,
			'rebase.yml': false,
			'foo_bar.baz-1.yaml': true,
		},
		unknown: 'ignored',
	}), file);
	t.equal(error, null, 'no error');
	t.deepEqual(Object.keys(config), ['workflows'], 'only the keys the file sets; unknown keys are ignored');
	t.ok(config.workflows, 'workflows is an object');
	if (config.workflows) {
		t.equal(Object.getPrototypeOf(config.workflows), null, 'has a null prototype, so names like `constructor` can’t collide');
		t.deepEqual(
			{ ...config.workflows },
			{
				'node-twenties.yml': true,
				'rebase.yml': false,
				'foo_bar.baz-1.yaml': true,
			},
			'keeps every override',
		);
	}

	const proto = parseConfig('{ "workflows": { "__proto__.yml": true } }', file);
	t.equal(proto.error, null, 'a dotted name is fine');

	t.end();
});

test('parseConfig: invalid workflows', (t) => {
	const message = '`some/file.json`: `workflows` must be a boolean, or an object mapping workflow file names (`*.yml` or `*.yaml`) to booleans';
	const cases = [
		['null', null],
		['number', 1],
		['array', ['rebase.yml']],
		['string', 'rebase.yml'],
		['non-boolean value', { 'rebase.yml': 'yes' }],
		['non-workflow file name', { 'README.md': true }],
		['path', { 'sub/rebase.yml': true }],
	];
	cases.forEach(([label, workflows]) => {
		const { config, error } = parseConfig(JSON.stringify({ workflows }), file);
		t.equal(error, message, `${label}: rejected`);
		t.deepEqual(config, {}, `${label}: leaves \`workflows\` unset`);
	});

	t.end();
});

test('parseConfig: results are not shared mutably', (t) => {
	const a = parseConfig('{}', file).config;
	const b = parseConfig('{ "workflows": { "rebase.yml": false } }', file).config;
	t.notEqual(a, b, 'each call gets its own config object');
	a.workflows = false;
	t.deepEqual(parseConfig('{}', file).config, {}, 'mutating a result does not leak into later results');
	t.deepEqual(parseConfig(null, file).config, {}, 'nor into the no-file result');

	t.end();
});

/** @type {(workflows: Config['workflows'] | undefined) => Partial<Config>} */
function partial(workflows) {
	return workflows === undefined ? {} : { workflows };
}

/** @type {(workflows: Config['workflows']) => false | Record<string, boolean>} */
function plain(workflows) {
	return workflows && { ...workflows };
}

test('mergeConfig: precedence', (t) => {
	const accountObject = { 'rebase.yml': false, 'node.yml': true };
	const ownObject = { 'rebase.yml': true, 'node-twenties.yml': true };
	/** @type {[string, Config['workflows'] | undefined, Config['workflows'] | undefined, false | Record<string, boolean>][]} */
	const cases = [
		['neither set: the built-in default', undefined, undefined, {}],
		['own unset, account `false`: the account’s `false`', false, undefined, false],
		['own unset, account object: the account’s object', accountObject, undefined, accountObject],
		['own `false`, account unset: `false`', undefined, false, false],
		['own `false`, account `false`: `false`', false, false, false],
		['own `false`, account object: `false` wins', accountObject, false, false],
		['own object, account unset: the own object', undefined, ownObject, ownObject],
		['own object, account `false`: the own object', false, ownObject, ownObject],
		['own `{}` (or `true`), account `false`: opted back in, with the defaults', false, {}, {}],
		[
			'both objects: merged, own entries winning',
			accountObject,
			ownObject,
			{ 'rebase.yml': true, 'node.yml': true, 'node-twenties.yml': true },
		],
		['own `{}` (or `true`), account object: the account’s entries', accountObject, {}, accountObject],
	];
	cases.forEach(([label, account, own, expected]) => {
		const merged = mergeConfig(partial(account), partial(own));
		t.ok(Object.hasOwn(merged, 'workflows'), `${label}: \`workflows\` is set`);
		t.deepEqual(plain(merged.workflows), expected, label);
	});

	t.end();
});

test('mergeConfig: with parsed configs', (t) => {
	const account = parseConfig('{ "workflows": { "rebase.yml": false, "node.yml": true } }', 'account').config;
	t.deepEqual(
		plain(mergeConfig(account, parseConfig('{ "workflows": true }', 'own').config).workflows),
		{ 'rebase.yml': false, 'node.yml': true },
		'`true` opts in, keeping the account’s entries',
	);
	t.deepEqual(
		plain(mergeConfig(account, parseConfig('{ "workflows": { "node.yml": false } }', 'own').config).workflows),
		{ 'rebase.yml': false, 'node.yml': false },
		'an own entry overrides the account’s',
	);
	t.equal(mergeConfig(account, parseConfig('{ "workflows": false }', 'own').config).workflows, false, 'an own `false` opts out');
	t.deepEqual(
		plain(mergeConfig(account, parseConfig('{ "workflows": 1 }', 'own').config).workflows),
		{ 'rebase.yml': false, 'node.yml': true },
		'an invalid own key falls back to the account’s',
	);
	t.equal(
		mergeConfig(parseConfig('{ "workflows": false }', 'account').config, parseConfig('{}', 'own').config).workflows,
		false,
		'an account’s `false` applies to a repository that doesn’t set `workflows`',
	);

	t.end();
});

test('mergeConfig: fresh, null-prototype results, with no shared mutation', (t) => {
	const account = { workflows: { 'rebase.yml': false } };
	const own = { workflows: { 'node.yml': true } };
	const merged = mergeConfig(account, own);
	t.ok(merged.workflows, 'an object');
	if (merged.workflows) {
		t.equal(Object.getPrototypeOf(merged.workflows), null, 'has a null prototype');
		t.notEqual(merged.workflows, account.workflows, 'is not the account’s object');
		t.notEqual(merged.workflows, own.workflows, 'is not the own object');
		merged.workflows['extra.yml'] = true;
	}
	t.deepEqual(account, { workflows: { 'rebase.yml': false } }, 'the account’s config is untouched');
	t.deepEqual(own, { workflows: { 'node.yml': true } }, 'the own config is untouched');

	/** @type {[string, Partial<Config>, Partial<Config>][]} */
	const cases = [
		['neither set', {}, {}],
		['only the account set', account, {}],
		['only own set', {}, own],
	];
	cases.forEach(([label, a, o]) => {
		const result = mergeConfig(a, o);
		t.ok(result.workflows && Object.getPrototypeOf(result.workflows) === null, `${label}: a null-prototype object`);
		t.notEqual(result.workflows, a.workflows, `${label}: not the account’s object`);
		t.notEqual(result.workflows, o.workflows, `${label}: not the own object`);
	});

	const first = mergeConfig({}, {});
	if (first.workflows) {
		first.workflows['leak.yml'] = true;
	}
	const second = mergeConfig({}, {});
	t.notEqual(second.workflows, first.workflows, 'each call gets its own object');
	t.deepEqual(plain(second.workflows), {}, 'mutating a result does not leak into the built-in default');

	const objects = mergeConfig(account, own);
	t.deepEqual(plain(objects.workflows), { 'rebase.yml': false, 'node.yml': true }, 'a mutated earlier result does not affect a later merge');

	t.end();
});

/** @type {(keep: Config['keep'] | undefined) => Record<string, string[]> | undefined} */
function plainKeep(keep) {
	return keep && { ...keep };
}

test('parseConfig: `keep`', (t) => {
	const { config, error } = parseConfig('{ "keep": { "node-pretest.yml": ["skip-engines"], "node-aught.yml": ["skip-ls-check", "after_install"] } }', file);
	t.equal(error, null, 'no error');
	t.deepEqual(plainKeep(config.keep), { 'node-pretest.yml': ['skip-engines'], 'node-aught.yml': ['skip-ls-check', 'after_install'] }, 'the inputs to keep, by workflow file');
	t.equal(Object.getPrototypeOf(config.keep), null, 'with a null prototype');
	t.deepEqual(plainKeep(parseConfig('{ "keep": {} }', file).config.keep), {}, 'an empty object keeps nothing');

	[
		['not an object', '["skip-engines"]'],
		['`null`', 'null'],
		['a file name that isn’t a workflow’s', '{ "pretest": ["skip-engines"] }'],
		['inputs that aren’t an array', '{ "node-pretest.yml": "skip-engines" }'],
		['an input that isn’t a string', '{ "node-pretest.yml": [true] }'],
		['an input that isn’t a name', '{ "node-pretest.yml": ["skip engines"] }'],
	].forEach(([label, keep]) => {
		const parsed = parseConfig(`{ "keep": ${keep} }`, file);
		t.equal(parsed.error, '`some/file.json`: `keep` must be an object mapping workflow file names (`*.yml` or `*.yaml`) to arrays of input names', `${label}: an error`);
		t.notOk('keep' in parsed.config, `${label}: sets nothing`);
	});

	const account = parseConfig('{ "keep": { "node-pretest.yml": ["skip-engines"] }, "workflows": false }', file, { account: true });
	t.equal(account.error, '`some/file.json`: `keep` only applies to one repository, so it can only be set in its own `.github/ljharb-actions.json`', 'an account’s defaults can’t set it');
	t.deepEqual(account.config, { workflows: false }, 'but its other keys still apply');

	const raw = { keep: { 'node-pretest.yml': ['skip-engines'] } };
	const parsed = parseConfig(JSON.stringify(raw), file).config;
	parsed.keep?.['node-pretest.yml'].push('y');
	t.deepEqual(parseConfig(JSON.stringify(raw), file).config.keep?.['node-pretest.yml'], ['skip-engines'], 'each parse has its own arrays');
	t.end();
});

test('parseConfig: `keep` can only name inputs that the reusable workflow the file’s template calls declares', (t) => {
	const one = parseConfig('{ "keep": { "node-pretest.yml": ["skip-engines", "nope"], "node.yml": ["range"] } }', file);
	t.equal(one.error, '`some/file.json`: `keep`’s `node-pretest.yml` names `nope`, which `pretest.yml` doesn’t declare as an input', 'an undeclared input is an error, naming it');
	t.deepEqual(plainKeep(one.config.keep), { 'node-pretest.yml': ['skip-engines'], 'node.yml': ['range'] }, 'which is never kept, but everything else still is');

	const several = parseConfig('{ "keep": { "node-pretest.yml": ["range", "nope"] } }', file);
	t.equal(several.error, '`some/file.json`: `keep`’s `node-pretest.yml` names `range`, `nope`, which `pretest.yml` doesn’t declare as inputs', 'as are several, naming each');
	t.deepEqual(plainKeep(several.config.keep), { 'node-pretest.yml': [] }, 'keeping none of them');

	const untemplated = parseConfig('{ "keep": { "custom.yml": ["skip-engines"], "rebase.yml": ["x"], "node-pretest.yml": ["skip-pack"] } }', file);
	t.equal(untemplated.error, '`some/file.json`: `keep` names `custom.yml`, but `/fix` never writes a file of that name that calls one of this repo’s reusable workflows, so it has no inputs to keep; `keep`’s `rebase.yml` names `x`, which `rebase.yml` doesn’t declare as an input', 'a file with no template is an error too, as is one whose template’s workflow declares no inputs');
	t.deepEqual(plainKeep(untemplated.config.keep), { 'rebase.yml': [], 'node-pretest.yml': ['skip-pack'] }, 'neither kept');
	t.end();
});

test('mergeConfig: `keep` is only ever a repository’s own', (t) => {
	t.deepEqual(plainKeep(mergeConfig({}, {}).keep), {}, 'neither set: nothing kept');
	const own = parseConfig('{ "keep": { "node-pretest.yml": ["skip-engines"] } }', 'own').config;
	const merged = mergeConfig({ keep: { 'node.yml': ['os'] } }, own);
	t.deepEqual(plainKeep(merged.keep), { 'node-pretest.yml': ['skip-engines'] }, 'the repository’s own, never an account’s');
	t.equal(Object.getPrototypeOf(merged.keep), null, 'a null-prototype object');
	t.notEqual(merged.keep, own.keep, 'not the repository’s object');
	t.end();
});
