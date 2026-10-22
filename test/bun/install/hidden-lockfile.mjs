import { spawnSync } from 'child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'fs';
import path from 'path';

import test from 'tape';

import {
	actionDir,
	baseEnv,
	makeTmp,
	readJSONLines,
	runNode,
	writeExecutable,
} from './helpers.mjs';

const script = path.join(actionDir, 'hidden-lockfile.js');

// a stand-in for the globally installed npm's `@npmcli/arborist`: the actual tree comes from `$FAKE_ARB_TREE`
const fakeArborist = `'use strict';
const fs = require('fs');
module.exports = class Arborist {
	constructor(options) {
		fs.appendFileSync(process.env.FAKE_ARB_LOG, JSON.stringify({ constructor: options }) + '\\n');
	}
	async loadActual() {
		const { loadError, nodes } = JSON.parse(fs.readFileSync(process.env.FAKE_ARB_TREE, 'utf8'));
		if (loadError) {
			throw new Error(loadError);
		}
		const inventory = new Map(nodes.map((n) => [n.location, { ...n, edgesIn: new Set(n.edgesIn) }]));
		const meta = {
			async save() {
				fs.writeFileSync(meta.filename, JSON.stringify({
					hiddenLockfile: meta.hiddenLockfile,
					resolved: Object.fromEntries(Array.from(inventory, ([location, node]) => [location, node.resolved || null])),
				}));
			},
		};
		return { inventory, meta };
	}
};
`;

// a stand-in for npm's `npm-package-arg`: alphabetic specs are tags, `!` is invalid, anything else is a range
const fakeNpa = `'use strict';
module.exports = function npa(arg) {
	const spec = arg.slice(arg.lastIndexOf('@') + 1);
	if (spec === '!') {
		throw new TypeError('invalid spec');
	}
	return { type: /^[a-z]+$/i.test(spec) ? 'tag' : 'range' };
};
`;

/**
 * @param {import('tape').Test} t
 * @param {{ nodeModules?: boolean, hiddenLockfile?: boolean, tree?: object }} options
 */
function runFake(t, { nodeModules = true, hiddenLockfile = false, tree = { nodes: [] } }) {
	const tmp = makeTmp(t);
	const cwd = path.join(tmp, 'project');
	mkdirSync(cwd);
	if (nodeModules) {
		mkdirSync(path.join(cwd, 'node_modules'));
	}
	if (hiddenLockfile) {
		writeFileSync(path.join(cwd, 'node_modules', '.package-lock.json'), '{"preexisting":true}');
	}

	const globalRoot = path.join(tmp, 'global');
	const npmDir = path.join(globalRoot, 'npm');
	mkdirSync(path.join(npmDir, 'node_modules', '@npmcli', 'arborist'), { recursive: true });
	mkdirSync(path.join(npmDir, 'node_modules', 'npm-package-arg'), { recursive: true });
	writeFileSync(path.join(npmDir, 'package.json'), '{"name":"npm","version":"0.0.0"}');
	writeFileSync(path.join(npmDir, 'node_modules', '@npmcli', 'arborist', 'index.js'), fakeArborist);
	writeFileSync(path.join(npmDir, 'node_modules', 'npm-package-arg', 'index.js'), fakeNpa);

	const files = {
		arbLog: path.join(tmp, 'arb.log'),
		npmLog: path.join(tmp, 'npm.log'),
		tree: path.join(tmp, 'tree.json'),
	};
	writeFileSync(files.tree, JSON.stringify(tree));

	const bin = path.join(tmp, 'bin');
	writeExecutable(path.join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> "${files.npmLog}"
echo "${globalRoot}"
`);

	/** @type {Record<string, string | undefined>} */
	const env = {
		...baseEnv(),
		FAKE_ARB_LOG: files.arbLog,
		FAKE_ARB_TREE: files.tree,
	};
	env.PATH = `${bin}${path.delimiter}${env.PATH}`;

	const result = runNode(script, { cwd, env });
	const lockfile = path.join(cwd, 'node_modules', '.package-lock.json');

	return {
		...result,
		cwd,
		arbCalls: readJSONLines(files.arbLog),
		npmCalls: existsSync(files.npmLog) ? readFileSync(files.npmLog, 'utf8').trim().split('\n') : [],
		lockfile: existsSync(lockfile) ? JSON.parse(readFileSync(lockfile, 'utf8')) : null,
	};
}

test('bun/install hidden-lockfile: no node_modules', (t) => {
	const r = runFake(t, { nodeModules: false });

	t.equal(r.status, 0, 'exits 0');
	t.deepEqual(r.npmCalls, [], 'npm is never consulted');
	t.deepEqual(r.arbCalls, [], 'arborist is never loaded');
	t.equal(r.lockfile, null, 'no lockfile is written');
	t.equal(r.stdout, '', 'logs nothing');

	t.end();
});

test('bun/install hidden-lockfile: an existing hidden lockfile', (t) => {
	const r = runFake(t, { hiddenLockfile: true });

	t.equal(r.status, 0, 'exits 0');
	t.deepEqual(r.npmCalls, [], 'npm is never consulted');
	t.deepEqual(r.arbCalls, [], 'arborist is never loaded');
	t.deepEqual(r.lockfile, { preexisting: true }, 'the existing lockfile is untouched');

	t.end();
});

test('bun/install hidden-lockfile: no dist-tag deps', (t) => {
	const r = runFake(t, {
		tree: {
			nodes: [
				{ location: '', packageName: 'root', edgesIn: [] },
				{ location: 'node_modules/resolved', resolved: 'https://example.com/r.tgz', version: '1.0.0', packageName: 'resolved', edgesIn: [{ name: 'resolved', spec: 'latest' }] },
				{ location: 'node_modules/nameless', version: '1.0.0', packageName: null, edgesIn: [{ name: 'nameless', spec: 'latest' }] },
				{ location: 'node_modules/versionless', packageName: 'versionless', edgesIn: [{ name: 'versionless', spec: 'latest' }] },
				{ location: 'node_modules/ranged', version: '1.0.0', packageName: 'ranged', edgesIn: [{ name: 'ranged', spec: '^1.0.0' }] },
				{ location: 'node_modules/invalid', version: '1.0.0', packageName: 'invalid', edgesIn: [{ name: 'invalid', spec: '!' }] },
				{ location: 'node_modules/orphan', version: '1.0.0', packageName: 'orphan', edgesIn: [] },
			],
		},
	});

	t.equal(r.status, 0, 'exits 0');
	t.deepEqual(r.npmCalls, ['root -g'], 'locates the global npm via `npm root -g`');
	t.deepEqual(r.arbCalls, [{ constructor: { path: r.cwd, offline: true } }], 'loads the actual tree offline, from the cwd');
	t.equal(r.lockfile, null, 'no lockfile is written, even for a tag-targeted node with no version');
	t.equal(r.stdout, '', 'logs nothing');

	t.end();
});

test('bun/install hidden-lockfile: dist-tag deps', (t) => {
	const r = runFake(t, {
		tree: {
			nodes: [
				{ location: '', packageName: 'root', edgesIn: [] },
				{ location: 'node_modules/foo', version: '1.2.3', packageName: 'foo', edgesIn: [{ name: 'foo', spec: 'next' }] },
				{ location: 'node_modules/@scope/bar', version: '2.0.0-rc.1', packageName: '@scope/bar', edgesIn: [{ name: '@scope/bar', spec: 'beta' }] },
				{ location: 'node_modules/baz', version: '3.0.0', packageName: 'baz', edgesIn: [{ name: 'baz', spec: '!' }, { name: 'baz', spec: '^3' }, { name: 'baz', spec: 'canary' }] },
				{ location: 'node_modules/ranged', version: '1.0.0', packageName: 'ranged', edgesIn: [{ name: 'ranged', spec: '^1.0.0' }] },
				{ location: 'node_modules/versionless', packageName: 'versionless', edgesIn: [{ name: 'versionless', spec: 'next' }] },
			],
		},
	});

	t.equal(r.status, 0, 'exits 0');
	t.equal(r.stderr, '', 'no errors');
	t.deepEqual(
		r.lockfile,
		{
			hiddenLockfile: true,
			resolved: {
				'': null,
				'node_modules/foo': 'https://registry.npmjs.org/foo/-/foo-1.2.3.tgz',
				'node_modules/@scope/bar': 'https://registry.npmjs.org/@scope/bar/-/bar-2.0.0-rc.1.tgz',
				'node_modules/baz': 'https://registry.npmjs.org/baz/-/baz-3.0.0.tgz',
				'node_modules/ranged': null,
				'node_modules/versionless': null,
			},
		},
		'synthesizes registry tarball URLs for versioned dist-tag targets only, and saves a hidden lockfile at node_modules/.package-lock.json',
	);
	t.equal(
		r.stdout,
		'synthesized node_modules/.package-lock.json (3 dist-tag dep(s)) for the bun-installed tree\n',
		'logs how many were synthesized',
	);

	t.end();
});

test('bun/install hidden-lockfile: loading the tree fails', (t) => {
	const r = runFake(t, { tree: { loadError: 'fake loadActual failure' } });

	t.equal(r.status, 1, 'exits 1');
	t.match(r.stderr, /fake loadActual failure/, 'reports the error');
	t.equal(r.lockfile, null, 'no lockfile is written');

	t.end();
});

test('bun/install hidden-lockfile: with the real global npm, makes `npm ls` accept a dist-tag dep', (t) => {
	const tmp = makeTmp(t);
	// isolate npm from the developer's / runner's user and global npmrc (npm refuses to load one file as both)
	const userNpmrc = path.join(tmp, 'user-npmrc');
	const globalNpmrc = path.join(tmp, 'global-npmrc');
	writeFileSync(userNpmrc, '');
	writeFileSync(globalNpmrc, '');

	/** @type {Record<string, string | undefined>} */
	const npmEnv = {
		...baseEnv(),
		...Object.fromEntries([
			['npm_config_userconfig', userNpmrc],
			['npm_config_globalconfig', globalNpmrc],
			['npm_config_offline', 'true'],
			['npm_config_audit', 'false'],
			['npm_config_fund', 'false'],
		]),
	};

	const rootResult = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', env: npmEnv });
	t.equal(rootResult.status, 0, 'precondition: `npm root -g` succeeds with the isolated config');
	const npmRoot = rootResult.stdout.trim();
	if (!npmRoot || !existsSync(path.join(npmRoot, 'npm', 'node_modules', '@npmcli', 'arborist'))) {
		t.skip('no globally installed npm with arborist found');
		t.end();
		return;
	}

	const cwd = path.join(tmp, 'project');
	mkdirSync(cwd);
	writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
		name: 'root',
		version: '0.0.0',
		dependencies: { foo: 'next', bar: '^1.0.0' },
	}));
	mkdirSync(path.join(cwd, 'node_modules', 'foo'), { recursive: true });
	writeFileSync(path.join(cwd, 'node_modules', 'foo', 'package.json'), '{"name":"foo","version":"4.5.6-pre"}');
	mkdirSync(path.join(cwd, 'node_modules', 'bar'), { recursive: true });
	writeFileSync(path.join(cwd, 'node_modules', 'bar', 'package.json'), '{"name":"bar","version":"1.0.0"}');

	const npmLs = () => spawnSync('npm', ['ls'], { cwd, encoding: 'utf8', env: npmEnv });

	t.notEqual(npmLs().status, 0, 'precondition: `npm ls` rejects the dist-tag dep without a hidden lockfile');

	const r = runNode(script, { cwd, env: npmEnv });
	t.equal(r.status, 0, 'exits 0');
	t.match(r.stdout, /\(1 dist-tag dep\(s\)\)/, 'synthesized one entry');

	const lock = JSON.parse(readFileSync(path.join(cwd, 'node_modules', '.package-lock.json'), 'utf8'));
	t.equal(lock.packages['node_modules/foo'].resolved, 'https://registry.npmjs.org/foo/-/foo-4.5.6-pre.tgz', 'the dist-tag dep gets a registry URL');
	t.notOk('resolved' in lock.packages['node_modules/bar'], 'the semver dep is left alone');

	const after = npmLs();
	t.equal(after.status, 0, '`npm ls` now passes');

	t.end();
});
