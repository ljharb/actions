import {
	mkdtempSync,
	readdirSync,
	rmSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import test from 'tape';

import {
	checkReadme,
	checkReadmeSafely,
	identityOf,
	isCovered,
	packageName,
	unreadable,
} from '../../../fleet/readme/check.mjs';
import {
	definitions,
	headingFor,
	npmBadge,
	standardBadges,
} from '../../../fleet/readme/readme.mjs';
import { repoState } from '../drift/helpers/states.mjs';

/** @import { Result } from '../../../fleet/readme/check.mjs' */
/** @import { RepoState } from '../../../fleet/lib/app.mjs' */
/** @import { Config } from '../../../fleet/lib/config.mjs' */

const identity = { name: 'pkg', repository: 'ljharb/repo', branch: 'main' };

// the README a package's repository should have: its canonical header, some prose, then every link definition the header uses
const canonical = [
	headingFor(identity.name),
	'',
	...standardBadges,
	'',
	npmBadge,
	'',
	'Some prose about the package.',
	'',
	...definitions(identity).map(([label, url]) => `[${label}]: ${url}`),
	'',
].join('\n');

const packageJson = JSON.stringify({ name: 'pkg', version: '1.0.0' });

/** @type {(readme: boolean) => Config} */
function config(readme) {
	return { workflows: {}, readme, keep: {} };
}

/** @type {(overrides?: Partial<RepoState>) => RepoState} */
function state(overrides = {}) {
	return repoState({
		packageJson,
		readme: canonical,
		readmeRegular: true,
		...overrides,
	});
}

/** @type {(result: Result | null) => Result} */
function present(result) {
	if (!result) {
		throw new Error('expected a result');
	}
	return result;
}

// every drifted README makes a temp dir for its diff; keep them all under one dir that is removed when this file's tests finish
const fileTemp = mkdtempSync(path.join(tmpdir(), 'fleet-readme-check-test-'));
/** @type {string | undefined} */
let originalRunnerTemp;

test('setup: RUNNER_TEMP for this file', (t) => {
	originalRunnerTemp = process.env.RUNNER_TEMP;
	process.env.RUNNER_TEMP = fileTemp;
	t.end();
});

test('packageName', (t) => {
	t.deepEqual(packageName(null), { name: null, error: null }, 'no `package.json`: no package, and no error');
	t.deepEqual(packageName('{ nope'), { name: null, error: '`package.json` is not valid JSON' }, 'invalid JSON is an error');
	t.notOk(packageName('{ "secret": "abc" ').error?.includes('secret'), 'which doesn’t quote the file');
	t.deepEqual(packageName(JSON.stringify({ name: 'pkg', private: true })), { name: null, error: null }, 'a private package is not published: no package, and no error');
	t.deepEqual(packageName(JSON.stringify({ name: 'pkg', private: 'true' })), { name: 'pkg', error: null }, 'only `private: true` makes it private');
	['null', '[]', '"pkg"', '3'].forEach((json) => {
		t.deepEqual(packageName(json), { name: null, error: null }, `\`${json}\`, which isn’t an object, is no package`);
	});
	t.deepEqual(packageName(JSON.stringify({ version: '1.0.0' })), { name: null, error: '`package.json` has no valid `name`' }, 'no name is an error');
	t.deepEqual(packageName(JSON.stringify({ name: 3 })), { name: null, error: '`package.json` has no valid `name`' }, 'a name that isn’t a string is an error');
	['', 'has space', 'a/b', '@scope', '@scope/', 'pkg\n', '<script>'].forEach((name) => {
		t.deepEqual(packageName(JSON.stringify({ name })), { name: null, error: '`package.json` has no valid `name`' }, `${JSON.stringify(name)} is not a valid name`);
	});
	t.deepEqual(packageName(packageJson), { name: 'pkg', error: null }, 'a plain name');
	t.deepEqual(packageName(JSON.stringify({ name: 'es-abstract.x_y' })), { name: 'es-abstract.x_y', error: null }, 'dots, dashes, and underscores are fine');
	t.deepEqual(packageName(JSON.stringify({ name: '@ljharb/pkg' })), { name: '@ljharb/pkg', error: null }, 'a scoped name');

	t.end();
});

test('isCovered', (t) => {
	t.equal(isCovered(state()), true, 'a repository that publishes a package is covered');
	t.equal(isCovered(state({ stateError: 'could not read', archived: true, packageJson: null })), true, 'one whose state could not be read is covered, so that it’s reported');
	t.equal(isCovered(state({ archived: true })), false, 'an archived one isn’t');
	t.equal(isCovered(state({ config: config(false) })), false, 'one opted out with `readme: false` isn’t');
	t.equal(isCovered(state({ packageJson: null })), false, 'one with no `package.json` isn’t');
	t.equal(isCovered(state({ packageJson: JSON.stringify({ name: 'pkg', private: true }) })), false, 'one whose package is private isn’t');
	t.equal(isCovered(state({ packageJson: '{ nope' })), true, 'one whose `package.json` is invalid is, so that it’s reported');
	t.equal(isCovered(state({ packageJson: JSON.stringify({ version: '1.0.0' }) })), true, 'as is one whose `package.json` has no valid name');
	t.equal(isCovered(state({ packageJson: '{ nope', config: config(false) })), false, 'but not when it’s opted out');

	t.end();
});

test('identityOf', (t) => {
	t.deepEqual(identityOf(state()), { identity }, 'the package’s name, the repository, and its default branch');
	t.deepEqual(identityOf(state({ packageJson: JSON.stringify({ name: '@ljharb/pkg' }), defaultBranch: 'trunk' })), {
		identity: { name: '@ljharb/pkg', repository: 'ljharb/repo', branch: 'trunk' },
	}, 'a scoped name, and a default branch other than `main`');
	t.deepEqual(identityOf(state({ defaultBranch: null })), { error: 'the repository has no default branch' }, 'no default branch');
	t.deepEqual(identityOf(state({ packageJson: null })), { error: 'it doesn’t publish a package' }, 'no package');
	t.deepEqual(identityOf(state({ packageJson: '{ nope' })), { error: '`package.json` is not valid JSON' }, 'an invalid `package.json`');

	t.end();
});

test('unreadable', (t) => {
	t.equal(unreadable(state()), null, 'a regular README that was read in full is readable');
	t.equal(unreadable(state({ readme: null, readmeRegular: false })), 'there is no `README.md`', 'no README');
	t.equal(unreadable(state({ readme: null, readmeRegular: true })), '`README.md` could not be read in full', 'a README too big to read in full (truncated)');
	t.equal(unreadable(state({ readmeRegular: false })), '`README.md` is not a regular file', 'a symbolic link (or executable)');

	t.end();
});

test('checkReadme: repositories it skips, and ones it can’t read', (t) => {
	const empty = { repository: 'ljharb/repo', drifted: [], diff: '' };
	t.deepEqual(checkReadme(state({ stateError: 'could not read', readme: null, packageJson: null })), { ...empty, error: 'could not read' }, 'a state error is reported');
	t.equal(checkReadme(state({ archived: true, readme: 'anything' })), null, 'an archived repository is skipped');
	t.equal(checkReadme(state({ config: config(false), readme: 'anything' })), null, 'an opted-out repository is skipped');
	t.equal(checkReadme(state({ packageJson: null, readme: 'anything' })), null, 'a repository without a package is skipped');
	t.equal(checkReadme(state({ packageJson: JSON.stringify({ name: 'pkg', private: true }), readme: 'anything' })), null, 'a private package is skipped');

	t.deepEqual(checkReadme(state({ packageJson: '{ nope' })), { ...empty, error: '`package.json` is not valid JSON' }, 'an invalid `package.json` is an error');
	t.deepEqual(checkReadme(state({ defaultBranch: null })), { ...empty, error: 'the repository has no default branch' }, 'no default branch is an error');
	t.deepEqual(checkReadme(state({ readme: null, readmeRegular: false })), { ...empty, error: 'there is no `README.md`' }, 'no README is an error');
	t.deepEqual(checkReadme(state({ readme: null, readmeRegular: true })), { ...empty, error: '`README.md` could not be read in full' }, 'a truncated README is an error');
	t.deepEqual(checkReadme(state({ readme: 'README.other', readmeRegular: false })), { ...empty, error: '`README.md` is not a regular file' }, 'a symbolic link is an error, not drift');

	t.end();
});

test('checkReadme: a canonical README', (t) => {
	t.equal(checkReadme(state()), null, 'has no discrepancies');
	const extra = '[![CII Best Practices](https://bestpractices.dev/projects/1/badge)](https://bestpractices.dev/projects/1)';
	const downloads = '[![Downloads][downloads-image]][downloads-url]';
	t.equal(checkReadme(state({ readme: canonical.replace(downloads, `${downloads}\n${extra}`) })), null, 'an extra badge after the standard ones is fine');

	t.end();
});

test('checkReadme: a drifted README', (t) => {
	const readme = canonical
		.replace('# pkg <sup>', '# old-name <sup>')
		.replace('[![coverage][codecov-image]][codecov-url]\n', '')
		.replace('https://img.shields.io/npm/l/pkg.svg', 'https://img.shields.io/npm/l/old-name.svg');
	const result = present(checkReadme(state({ readme })));
	t.equal(result.repository, 'ljharb/repo', 'is the repository’s');
	t.deepEqual(result.drifted, ['heading', 'badges', 'links'], 'with every kind of discrepancy, in order');
	t.equal(result.error, null, 'and no error');
	const { diff } = result;
	t.match(diff, /^--- README\.md \(actual\)$/m, 'a diff from the actual README');
	t.match(diff, /^\+\+\+ README\.md \(expected\)$/m, 'to the expected one');
	t.match(diff, /^-# old-name <sup>/m, 'removing the wrong heading');
	t.match(diff, /^\+# pkg <sup>\[!\[Version Badge\]\[npm-version-svg\]\]\[package-url\]<\/sup>$/m, 'adding the right one');
	t.match(diff, /^\+\[!\[coverage\]\[codecov-image\]\]\[codecov-url\]$/m, 'adding the missing badge');
	t.match(diff, /^-\[license-image\]: https:\/\/img\.shields\.io\/npm\/l\/old-name\.svg$/m, 'removing the wrong definition');
	t.match(diff, /^\+\[license-image\]: https:\/\/img\.shields\.io\/npm\/l\/pkg\.svg$/m, 'adding the right one');

	t.deepEqual(present(checkReadme(state({ readme: canonical.replace('# pkg <sup>', '# old-name <sup>') }))).drifted, ['heading'], 'only the heading');
	t.deepEqual(present(checkReadme(state({ readme: canonical.replace('[![coverage][codecov-image]][codecov-url]\n', '') }))).drifted, ['badges'], 'only the badges');
	const links = present(checkReadme(state({ readme: canonical.replace(/^\[actions-url\]: .*\n/m, '') })));
	t.deepEqual(links.drifted, ['links'], 'only a missing definition');
	t.match(links.diff, /^\+\[actions-url\]: https:\/\/github\.com\/ljharb\/repo\/actions$/m, 'which the diff adds');

	const obsolete = canonical.replace(
		'[![Downloads][downloads-image]][downloads-url]\n',
		'[![Downloads][downloads-image]][downloads-url]\n[![dependency status][deps-svg]][deps-url]\n',
	).replace(/\n$/, '\n[deps-svg]: https://david-dm.org/ljharb/repo.svg\n[deps-url]: https://david-dm.org/ljharb/repo\n');
	const removed = present(checkReadme(state({ readme: obsolete })));
	t.deepEqual(removed.drifted, ['badges', 'links'], 'an obsolete badge, and the definitions only it used, are drift');
	t.match(removed.diff, /^-\[!\[dependency status\]\[deps-svg\]\]\[deps-url\]$/m, 'which the diff removes');
	t.match(removed.diff, /^-\[deps-url\]: https:\/\/david-dm\.org\/ljharb\/repo$/m, 'with its definitions');

	t.end();
});

test('unreadable: a README under another name', (t) => {
	t.equal(unreadable(state({ readmeName: 'README.markdown' })), null, 'a regular one that was read in full is readable');
	t.equal(unreadable(state({ readmeName: 'readme.md', readme: null })), '`readme.md` could not be read in full', 'one too big to read in full is named');
	t.equal(unreadable(state({ readmeName: 'README.markdown', readmeRegular: false })), '`README.markdown` is not a regular file', 'as is one that isn’t a regular file');
	t.equal(unreadable(state({ readmeName: null, readme: null, readmeRegular: false })), 'there is no `README.md`', 'with none npm takes, there’s no `README.md`');
	t.equal(
		unreadable(state({
			readmeName: null,
			readmeAmbiguous: ['README.markdown', 'readme.md'],
			readme: null,
			readmeRegular: false,
		})),
		'several files npm could take as its README: `README.markdown`, `readme.md`',
		'several npm could take, which it can’t tell apart, are named',
	);

	t.end();
});

test('checkReadme: a README under another name', (t) => {
	const renamed = present(checkReadme(state({ readmeName: 'README.markdown' })));
	t.deepEqual(renamed, {
		repository: 'ljharb/repo',
		readme: 'README.markdown',
		drifted: ['filename'],
		diff: '',
		error: null,
	}, 'a canonical one is only filename drift, named, with no diff, since its text is as it should be');

	const both = present(checkReadme(state({ readmeName: 'readme.md', readme: canonical.replace('# pkg <sup>', '# old-name <sup>') })));
	t.deepEqual(both.drifted, ['filename', 'heading'], 'its other discrepancies are found too, after its file name');
	t.equal(both.readme, 'readme.md', 'named');
	t.match(both.diff, /^--- readme\.md \(actual\)$/m, 'with a diff from the actual README, as it’s named');
	t.match(both.diff, /^\+\+\+ README\.md \(expected\)$/m, 'to the expected `README.md`');
	t.match(both.diff, /^\+# pkg <sup>/m, 'fixing its heading');

	const several = {
		readmeName: null,
		readmeAmbiguous: ['README.markdown', 'readme.md'],
		readme: null,
		readmeRegular: false,
	};
	t.deepEqual(checkReadme(state(several)), {
		repository: 'ljharb/repo',
		drifted: [],
		diff: '',
		error: 'several files npm could take as its README: `README.markdown`, `readme.md`',
	}, 'several npm could take are an error, not drift');

	t.end();
});

test('checkReadme: a README whose only discrepancy is its file name is diffed against only what `/fix` would change in it', (t) => {
	const mixed = canonical.replace('Some prose about the package.\n', 'Some prose about the package.\r\n');
	t.equal(present(checkReadme(state({ readmeName: 'readme.md', readme: mixed }))).diff, '', 'nothing, even with mixed line endings, which fixing anything else would make all `\\n`s');

	const org = mixed.replace('[package-url]: https://npmjs.com/package/pkg', '[package-url]: https://npmjs.org/package/pkg');
	const relinked = present(checkReadme(state({ readmeName: 'readme.md', readme: org })));
	t.deepEqual(relinked.drifted, ['filename'], 'with its `[package-url]` on `npmjs.org`, still only its file name drifted');
	t.deepEqual(
		relinked.diff.split('\n').filter((line) => (/^[-+][^-+]/).test(line)),
		['-[package-url]: https://npmjs.org/package/pkg', '+[package-url]: https://npmjs.com/package/pkg'],
		'but its diff is that definition, written on `npmjs.com`, as `/fix` writes it when it renames it, and nothing else',
	);

	t.end();
});

test('checkReadme: how the title is found', (t) => {
	t.equal(checkReadme(state({ readme: `\uFEFF${canonical}` })), null, 'a canonical README after a byte order mark has no discrepancies');
	const bomDrifted = present(checkReadme(state({ readme: `\uFEFF${canonical.replace('# pkg <sup>', '# old-name <sup>')}` })));
	t.deepEqual(bomDrifted.drifted, ['heading'], 'after a byte order mark, a drifted title is found, and only it drifts');
	t.match(bomDrifted.diff, /^\+\uFEFF# pkg <sup>/m, 'which the diff replaces, keeping the byte order mark');

	const setext = present(checkReadme(state({ readme: canonical.replace(`${headingFor('pkg')}\n`, 'pkg <sup>[![Version Badge][npm-version-svg]][package-url]</sup>\n===\n') })));
	t.deepEqual(setext.drifted, ['heading'], 'a setext title, even with the right text, is heading drift, and only that');
	t.match(setext.diff, /^-===$/m, 'the diff removes its underline');
	t.match(setext.diff, /^\+# pkg <sup>\[!\[Version Badge\]\[npm-version-svg\]\]\[package-url\]<\/sup>$/m, 'and adds the ATX heading');

	const priority = present(checkReadme(state({ readme: canonical.replace(`${headingFor('pkg')}\n`, '#1 priority\n') })));
	t.deepEqual(priority.drifted, ['heading', 'badges'], '`#1 priority` as the first line is no title, so the heading is missing, and the badges under it');
	t.match(priority.diff, /^\+# pkg <sup>/m, 'the diff inserts the heading');
	t.doesNotMatch(priority.diff, /^-#1 priority$/m, 'leaving that line alone');

	const codeSpan = canonical.replace('Some prose about the package.', 'Some prose about the package.\n\n```js `not a fence`');
	t.equal(checkReadme(state({ readme: codeSpan })), null, 'a fence-like line with a backtick in its info string opens no fence that would hide the definitions');

	t.end();
});

test('checkReadme: diffs are written under RUNNER_TEMP', (t) => {
	const before = new Set(readdirSync(fileTemp));
	checkReadme(state({ readme: canonical.replace('# pkg <sup>', '# old-name <sup>') }));
	const added = readdirSync(fileTemp).filter((name) => !before.has(name));
	t.equal(added.length, 1, 'one temp dir for the diff');
	t.ok(added.every((name) => name.startsWith('readme-drift-')), 'named for the README drift report');

	t.end();
});

/** @type {(names: string[]) => () => void} */
function overrideEnv(names) {
	/** @type {Map<string, string | undefined>} */
	const originals = new Map(names.map((name) => [name, process.env[name]]));
	return () => {
		originals.forEach((value, name) => {
			if (typeof value === 'string') {
				process.env[name] = value;
			} else {
				delete process.env[name];
			}
		});
	};
}

test('checkReadme: diffs are written under the OS temp dir when RUNNER_TEMP is unset', (t) => {
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

	const result = present(checkReadme(state({ readme: canonical.replace('# pkg <sup>', '# old-name <sup>') })));
	t.deepEqual(result.drifted, ['heading'], 'drifted');
	t.match(result.diff, /^-# old-name <sup>/m, 'with a diff');
	const dirs = readdirSync(osTemp);
	t.equal(dirs.length, 1, 'one temp dir for the diff');
	t.match(dirs[0], /^readme-drift-/, 'named for the README drift report');

	t.end();
});

test('checkReadme: a configuration error is surfaced', (t) => {
	const configError = '`.github/ljharb-actions.json` is not valid JSON';
	t.deepEqual(checkReadme(state({ configError })), {
		repository: 'ljharb/repo', drifted: [], diff: '', error: configError,
	}, 'on a canonical README, by itself');
	const drifted = present(checkReadme(state({ configError, readme: canonical.replace('# pkg <sup>', '# old-name <sup>') })));
	t.deepEqual(drifted.drifted, ['heading'], 'alongside the drift');
	t.equal(drifted.error, configError, 'as the error');
	t.equal(present(checkReadme(state({ configError, readme: null, readmeRegular: false }))).error, `${configError}; there is no \`README.md\``, 'before why the README can’t be read');
	t.equal(present(checkReadme(state({ configError, defaultBranch: null }))).error, `${configError}; the repository has no default branch`, 'before why it can’t be checked');

	t.end();
});

/** @type {(base: RepoState, error: unknown) => RepoState} */
function throwing(base, error) {
	return Object.defineProperty(base, 'readme', {
		enumerable: true,
		get() {
			throw error;
		},
	});
}

test('checkReadmeSafely', (t) => {
	const empty = { repository: 'ljharb/repo', drifted: [], diff: '' };
	t.equal(checkReadmeSafely(state()), null, 'a canonical README');
	t.deepEqual(present(checkReadmeSafely(state({ readme: canonical.replace('# pkg <sup>', '# old-name <sup>') }))).drifted, ['heading'], 'a drifted one is as `checkReadme` has it');
	t.deepEqual(checkReadmeSafely(throwing(state(), new Error('boom'))), { ...empty, error: 'could not be checked: boom' }, 'a failure is that repository’s error');
	t.deepEqual(checkReadmeSafely(throwing(state(), 'a string')), { ...empty, error: 'could not be checked: a string' }, 'a non-Error is stringified');
	t.deepEqual(checkReadmeSafely(throwing(state({ private: true }), new Error('secret contents'))), { ...empty, error: 'could not be checked' }, 'a private repository’s error has no message');

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
