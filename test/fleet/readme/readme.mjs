import test from 'tape';

import {
	categories,
	definitions,
	drift,
	fixReadme,
	headingFor,
	isCategory,
	kindOf,
	npmBadge,
	readmePath,
	standardBadges,
} from '../../../fleet/readme/readme.mjs';

/** @import { Category, Identity } from '../../../fleet/readme/readme.mjs' */

/** @type {Identity} */
const identity = { name: 'foo', repository: 'ljharb/foo', branch: 'main' };

/** @type {Identity} */
const scoped = { name: '@scope/name', repository: 'scope/name', branch: 'trunk' };

/** @type {(id?: Identity) => string[]} */
function definitionLines(id = identity) {
	return definitions(id).map(([label, url]) => `[${label}]: ${url}`);
}

/**
 * The header a README should start with: its heading, the standard badges, any `extra` badge lines, and the npm badge.
 * @type {(options?: { id?: Identity, extra?: string[] }) => string[]}
 */
function header({ id = identity, extra = [] } = {}) {
	return [
		headingFor(id.name),
		'',
		...standardBadges,
		...extra,
		'',
		npmBadge,
	];
}

/**
 * A whole canonical README: the header, then `body`, then `defs` (every definition, by default), joined with `eol`, with a final newline.
 * @type {(options?: { id?: Identity, extra?: string[], body?: string[], defs?: string[], eol?: string }) => string}
 */
function canonical({
	id = identity,
	extra = [],
	body = ['A description of foo.'],
	defs = definitionLines(id),
	eol = '\n',
} = {}) {
	return `${[
		...header({ id, extra }),
		'',
		...body,
		'',
		...defs,
	].join(eol)}${eol}`;
}

/** @type {(...categories: Category[]) => Set<Category>} */
function only(...cats) {
	return new Set(cats);
}

/** @type {(text: string, label: string) => number} */
function definitionCount(text, label) {
	const pattern = new RegExp(`^\\[${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]:`, 'gim');
	return (text.match(pattern) ?? []).length;
}

// every README any test here fixes, so that each can also be shown to be idempotent at the end
/** @type {Map<string, { text: string, id: Identity }>} */
const fixtures = new Map();

/** @type {(name: string, text: string, id?: Identity) => string} */
function fixture(name, text, id = identity) {
	fixtures.set(name, { text, id });
	return text;
}

test('readme: categories are heading, badges, and links, and only those are categories', (t) => {
	t.deepEqual(categories, ['heading', 'badges', 'links'], 'the categories, in order');
	t.ok(Object.isFrozen(categories), 'the categories are frozen');
	categories.forEach((c) => {
		t.equal(isCategory(c), true, `\`${c}\` is a category`);
	});
	['', 'heading ', 'Heading', 'badge', 'link', 'workflows', 'all'].forEach((word) => {
		t.equal(isCategory(word), false, `\`${word}\` is not a category`);
	});
	t.equal(readmePath, 'README.md', 'the README is README.md');
	t.end();
});

test('readme: definitions for a plain package name', (t) => {
	t.deepEqual(definitions(identity), [
		['package-url', 'https://npmjs.org/package/foo'],
		['npm-version-svg', 'https://versionbadg.es/ljharb/foo.svg'],
		['npm-badge-png', 'https://nodei.co/npm/foo.png?downloads=true&stars=true'],
		['license-image', 'https://img.shields.io/npm/l/foo.svg'],
		['license-url', 'LICENSE'],
		['downloads-image', 'https://img.shields.io/npm/dm/foo.svg'],
		['downloads-url', 'https://npm-stat.com/charts.html?package=foo'],
		['codecov-image', 'https://codecov.io/gh/ljharb/foo/branch/main/graphs/badge.svg'],
		['codecov-url', 'https://app.codecov.io/gh/ljharb/foo/'],
		['actions-image', 'https://img.shields.io/github/check-suites/ljharb/foo/main'],
		['actions-url', 'https://github.com/ljharb/foo/actions'],
	], 'every definition, in the order they are added');
	t.end();
});

test('readme: definitions for a scoped package name use the name for npm URLs and the repository and branch for GitHub URLs', (t) => {
	t.deepEqual(definitions(scoped), [
		['package-url', 'https://npmjs.org/package/@scope/name'],
		['npm-version-svg', 'https://versionbadg.es/scope/name.svg'],
		['npm-badge-png', 'https://nodei.co/npm/@scope/name.png?downloads=true&stars=true'],
		['license-image', 'https://img.shields.io/npm/l/@scope/name.svg'],
		['license-url', 'LICENSE'],
		['downloads-image', 'https://img.shields.io/npm/dm/@scope/name.svg'],
		['downloads-url', 'https://npm-stat.com/charts.html?package=@scope/name'],
		['codecov-image', 'https://codecov.io/gh/scope/name/branch/trunk/graphs/badge.svg'],
		['codecov-url', 'https://app.codecov.io/gh/scope/name/'],
		['actions-image', 'https://img.shields.io/github/check-suites/scope/name/trunk'],
		['actions-url', 'https://github.com/scope/name/actions'],
	], 'every definition, for a scoped package');
	t.end();
});

test('readme: headingFor is the name with the version badge', (t) => {
	t.equal(headingFor('foo'), '# foo <sup>[![Version Badge][npm-version-svg]][package-url]</sup>', 'a plain name');
	t.equal(headingFor('@scope/name'), '# @scope/name <sup>[![Version Badge][npm-version-svg]][package-url]</sup>', 'a scoped name');
	t.end();
});

test('readme: the standard badges and the npm badge', (t) => {
	t.deepEqual(standardBadges, [
		'[![github actions][actions-image]][actions-url]',
		'[![coverage][codecov-image]][codecov-url]',
		'[![License][license-image]][license-url]',
		'[![Downloads][downloads-image]][downloads-url]',
	], 'the standard badges, in order');
	t.ok(Object.isFrozen(standardBadges), 'the standard badges are frozen');
	t.equal(npmBadge, '[![npm badge][npm-badge-png]][package-url]', 'the npm badge');
	t.end();
});

test('readme: kindOf classifies each family of badge image URL', (t) => {
	/** @type {[string, string][]} */
	const cases = [
		['https://versionbadg.es/ljharb/foo.svg', 'version'],
		['http://versionbadg.es/ljharb/foo.svg', 'version'],
		['https://badge.fury.io/js/foo.svg', 'version'],
		['https://www.badge.fury.io/js/foo.svg', 'version'],
		['https://img.shields.io/github/check-suites/ljharb/foo/main', 'ci'],
		['https://img.shields.io/github/check-runs/ljharb/foo/main', 'ci'],
		['https://img.shields.io/github/actions/workflow/status/ljharb/foo/node.yml', 'ci'],
		['https://img.shields.io/github/workflow/status/ljharb/foo/Tests', 'ci'],
		['https://travis-ci.org/ljharb/foo.svg', 'ci'],
		['https://travis-ci.com/ljharb/foo.svg?branch=main', 'ci'],
		['https://api.travis-ci.org/ljharb/foo.svg', 'ci'],
		['https://github.com/ljharb/foo/actions/workflows/node.yml/badge.svg', 'ci'],
		['https://github.com/ljharb/foo/workflows/Tests/badge.svg', 'ci'],
		['https://codecov.io/gh/ljharb/foo/branch/main/graphs/badge.svg', 'coverage'],
		['https://app.codecov.io/gh/ljharb/foo/', 'coverage'],
		['https://coveralls.io/repos/ljharb/foo/badge.svg', 'coverage'],
		['https://david-dm.org/ljharb/foo.svg', 'obsolete'],
		['https://david-dm.org/ljharb/foo/dev-status.svg', 'obsolete'],
		['https://status.david-dm.org/gh/ljharb/foo.svg', 'obsolete'],
		['https://ci.testling.com/ljharb/foo.png', 'obsolete'],
		['https://www.gittip.com/ljharb/', 'obsolete'],
		['https://gratipay.com/ljharb/', 'obsolete'],
		['https://img.shields.io/gittip/ljharb.svg', 'obsolete'],
		['https://img.shields.io/gratipay/ljharb.svg', 'obsolete'],
		['https://img.shields.io/gratipay/user/ljharb.svg', 'obsolete'],
		['https://img.shields.io/npm/l/foo.svg', 'license'],
		['https://img.shields.io/npm/dm/foo.svg', 'downloads'],
		['https://img.shields.io/npm/dt/foo.svg', 'downloads'],
		['https://img.shields.io/npm/dw/foo.svg', 'downloads'],
		['https://img.shields.io/npm/dy/foo.svg', 'downloads'],
		['https://nodei.co/npm/foo.png?downloads=true&stars=true', 'npm'],
		['https://www.nodei.co/npm/foo.png', 'npm'],
		['HTTPS://NODEI.CO/NPM/foo.png', 'npm'],
		['https://bestpractices.coreinfrastructure.org/projects/1234/badge', 'extra'],
		['https://img.shields.io/npm/v/foo.svg', 'extra'],
		['https://img.shields.io/badge/anything-here-blue', 'extra'],
		['LICENSE', 'extra'],
		['', 'extra'],
	];
	cases.forEach(([url, kind]) => {
		t.equal(kindOf(url), kind, `\`${url}\` is \`${kind}\``);
	});
	t.end();
});

test('readme: an exactly canonical README has no drift, and fixing it changes nothing', (t) => {
	const text = fixture('canonical', canonical());
	t.deepEqual(drift(text, identity), [], 'no drift');
	t.deepEqual(fixReadme(text, identity), { text, skipped: [] }, 'fixing it changes nothing');
	categories.forEach((c) => {
		t.deepEqual(fixReadme(text, identity, only(c)), { text, skipped: [] }, `fixing only \`${c}\` changes nothing`);
	});

	const scopedText = fixture('canonical, scoped', canonical({ id: scoped }), scoped);
	t.deepEqual(drift(scopedText, scoped), [], 'a canonical scoped README has no drift');
	t.equal(fixReadme(scopedText, scoped).text, scopedText, 'fixing a canonical scoped README changes nothing');

	t.deepEqual(drift(text, scoped), ['heading', 'links'], 'one package’s canonical README, checked as another’s, has a drifted heading and links but the same badges');
	t.end();
});

test('readme: only the heading drifts', (t) => {
	const plainHeading = fixture('plain heading', canonical().replace(headingFor('foo'), '# foo'));
	t.deepEqual(drift(plainHeading, identity), ['heading'], 'a heading without the version badge is only heading drift');
	t.equal(fixReadme(plainHeading, identity).text, canonical(), 'fixing it gives the canonical README');

	const wrongName = fixture('wrong name in heading', canonical().replace('# foo ', '# bar '));
	t.deepEqual(drift(wrongName, identity), ['heading'], 'a heading with the wrong name is only heading drift');
	t.equal(fixReadme(wrongName, identity).text, canonical(), 'fixing it gives the canonical README');

	const noSpace = fixture('heading without a space', canonical().replace('# foo ', '#foo '));
	t.deepEqual(drift(noSpace, identity), ['heading'], 'a heading written `#foo`, with no space, is still the heading, and only it drifts');
	t.equal(fixReadme(noSpace, identity).text, canonical(), 'fixing it gives the canonical README');

	const bareNoSpace = fixture('bare heading without a space', canonical().replace(headingFor('foo'), '#foo'));
	t.deepEqual(drift(bareNoSpace, identity), ['heading'], 'a bare `#foo` heading is only heading drift');
	t.equal(fixReadme(bareNoSpace, identity).text, canonical(), 'fixing it gives the canonical README');

	const trailing = fixture('heading with trailing spaces', canonical().replace(headingFor('foo'), `${headingFor('foo')}   `));
	t.deepEqual(drift(trailing, identity), [], 'trailing whitespace on the heading is not drift');
	t.end();
});

test('readme: only the badges drift', (t) => {
	const missingCoverage = fixture('missing coverage badge', canonical().replace(`${standardBadges[1]}\n`, ''));
	t.deepEqual(drift(missingCoverage, identity), ['badges'], 'a missing standard badge is only badge drift');
	t.equal(fixReadme(missingCoverage, identity).text, canonical(), 'fixing it gives the canonical README');

	const reordered = fixture('reordered badges', canonical().replace(
		`${standardBadges[0]}\n${standardBadges[1]}\n`,
		`${standardBadges[1]}\n${standardBadges[0]}\n`,
	));
	t.deepEqual(drift(reordered, identity), ['badges'], 'reordered standard badges are only badge drift');
	t.equal(fixReadme(reordered, identity).text, canonical(), 'fixing it gives the canonical README');

	const oneLine = fixture('badges on one line', canonical().replace(standardBadges.map((b) => `${b}\n`).join(''), `${standardBadges.join(' ')}\n`));
	t.deepEqual(drift(oneLine, identity), ['badges'], 'the standard badges all on one line are badge drift');
	t.equal(fixReadme(oneLine, identity).text, canonical(), 'fixing it puts each on its own line');

	const noNpm = fixture('no npm badge', canonical().replace(`\n${npmBadge}\n`, ''));
	t.deepEqual(drift(noNpm, identity), ['badges'], 'a missing npm badge is only badge drift');
	t.equal(fixReadme(noNpm, identity).text, canonical(), 'fixing it gives the canonical README');

	const noBadges = fixture('no badges', [headingFor('foo'), '', 'A description of foo.', '', ...definitionLines()].join('\n').concat('\n'));
	t.deepEqual(drift(noBadges, identity), ['badges'], 'no badges at all is only badge drift');
	t.equal(fixReadme(noBadges, identity).text, canonical(), 'fixing it adds them all');

	const trailingSpaces = fixture('badges with trailing spaces', canonical().replace(`${standardBadges[0]}\n`, `${standardBadges[0]}  \n`));
	t.deepEqual(drift(trailingSpaces, identity), [], 'trailing whitespace on a badge line (a Markdown line break) is not drift');
	t.end();
});

test('readme: only the links drift', (t) => {
	const wrongURL = fixture('wrong codecov-url', canonical().replace('[codecov-url]: https://app.codecov.io/gh/ljharb/foo/', '[codecov-url]: https://codecov.io/gh/ljharb/foo'));
	t.deepEqual(drift(wrongURL, identity), ['links'], 'a wrong definition is only link drift');
	t.equal(fixReadme(wrongURL, identity).text, canonical(), 'fixing it rewrites that definition in place');

	const withTitle = fixture('definition with a title', canonical().replace('[license-url]: LICENSE', '[license-url]: LICENSE "the license"'));
	t.deepEqual(drift(withTitle, identity), ['links'], 'a definition with a title is link drift');
	t.equal(fixReadme(withTitle, identity).text, canonical(), 'fixing it drops the title');

	const defs = definitionLines();
	const withoutLicenseURL = defs.filter((line) => !line.startsWith('[license-url]:'));
	const missing = fixture('missing license-url', canonical({ defs: withoutLicenseURL }));
	t.deepEqual(drift(missing, identity), ['links'], 'a missing definition is only link drift');
	t.equal(
		fixReadme(missing, identity).text,
		canonical({ defs: [...withoutLicenseURL, '[license-url]: LICENSE'] }),
		'fixing it appends the missing definition after the last one',
	);

	const otherAfter = ['[other]: https://example.com'];
	const missingWithOther = fixture('missing definitions, then another', canonical({ defs: ['[package-url]: https://npmjs.org/package/foo', ...otherAfter], body: ['A description of foo, with [a link][other].'] }));
	t.deepEqual(drift(missingWithOther, identity), ['links'], 'many missing definitions are only link drift');
	t.equal(
		fixReadme(missingWithOther, identity).text,
		canonical({ defs: ['[package-url]: https://npmjs.org/package/foo', ...otherAfter, ...defs.slice(1)], body: ['A description of foo, with [a link][other].'] }),
		'fixing it appends the missing definitions, in order, after the last kept one',
	);

	const noDefs = fixture('no definitions', `${[...header(), '', 'A description of foo.'].join('\n')}\n\n\n`);
	t.deepEqual(drift(noDefs, identity), ['links'], 'no definitions at all is only link drift');
	t.equal(fixReadme(noDefs, identity).text, canonical(), 'fixing it appends them all at the end, after one blank line, dropping extra trailing blank lines');

	const angle = fixture('definition in angle brackets', canonical().replace('[actions-url]: https://github.com/ljharb/foo/actions', '[actions-url]: <https://github.com/ljharb/foo/actions>'));
	t.deepEqual(drift(angle, identity), ['links'], 'a definition written in angle brackets is not written as it should be');
	t.equal(fixReadme(angle, identity).text, canonical(), 'fixing it rewrites it');

	const indented = fixture('indented definition', canonical().replace('[actions-url]:', '   [actions-url]:'));
	t.deepEqual(drift(indented, identity), ['links'], 'an indented definition is still a definition, written differently');
	t.equal(fixReadme(indented, identity).text, canonical(), 'fixing it rewrites it in place, once');
	t.end();
});

// an older form of these READMEs: numbered references, a travis badge, david-dm badges, a testling badge, and a gittip badge
const obsoleteText = `# foo <sup>[![Version Badge][2]][1]</sup>

[![Build Status][3]][4]
[![dependency status][5]][6]
[![dev dependency status][7]][8]
[![License][license-image]][license-url]
[![Downloads][downloads-image]][downloads-url]
[![gittip][gittip-image]][gittip-url]

[![npm badge][11]][1]

[![browser support][9]][10]

A description of foo.

[1]: https://npmjs.org/package/foo
[2]: https://versionbadg.es/ljharb/foo.svg
[3]: https://travis-ci.org/ljharb/foo.svg
[4]: https://travis-ci.org/ljharb/foo
[5]: https://david-dm.org/ljharb/foo.svg
[6]: https://david-dm.org/ljharb/foo
[7]: https://david-dm.org/ljharb/foo/dev-status.svg
[8]: https://david-dm.org/ljharb/foo#info=devDependencies
[9]: https://ci.testling.com/ljharb/foo.png
[10]: https://ci.testling.com/ljharb/foo
[11]: https://nodei.co/npm/foo.png?downloads=true&stars=true
[license-image]: https://img.shields.io/npm/l/foo.svg
[license-url]: LICENSE
[downloads-image]: https://img.shields.io/npm/dm/foo.svg
[downloads-url]: https://npm-stat.com/charts.html?package=foo
[gittip-image]: https://img.shields.io/gittip/ljharb.svg
[gittip-url]: https://www.gittip.com/ljharb/
`;

// the definitions, in the order a fix of `obsoleteText` leaves them: the kept ones in place, then the missing ones in `definitions`' order
const obsoleteFixedDefs = [
	'[license-image]: https://img.shields.io/npm/l/foo.svg',
	'[license-url]: LICENSE',
	'[downloads-image]: https://img.shields.io/npm/dm/foo.svg',
	'[downloads-url]: https://npm-stat.com/charts.html?package=foo',
	'[package-url]: https://npmjs.org/package/foo',
	'[npm-version-svg]: https://versionbadg.es/ljharb/foo.svg',
	'[npm-badge-png]: https://nodei.co/npm/foo.png?downloads=true&stars=true',
	'[codecov-image]: https://codecov.io/gh/ljharb/foo/branch/main/graphs/badge.svg',
	'[codecov-url]: https://app.codecov.io/gh/ljharb/foo/',
	'[actions-image]: https://img.shields.io/github/check-suites/ljharb/foo/main',
	'[actions-url]: https://github.com/ljharb/foo/actions',
];

test('readme: obsolete badges are drift, and fixing removes them and the definitions only they used', (t) => {
	fixture('obsolete badges', obsoleteText);
	t.deepEqual(drift(obsoleteText, identity), ['heading', 'badges', 'links'], 'every category drifts');
	const { text, skipped } = fixReadme(obsoleteText, identity);
	t.deepEqual(skipped, [], 'nothing is skipped');
	t.equal(text, canonical({ defs: obsoleteFixedDefs }), 'the obsolete badges and the numbered and obsolete definitions are gone, and the standard ones are added');
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', 'gittip-image', 'gittip-url'].forEach((label) => {
		t.equal(definitionCount(text, label), 0, `the \`[${label}]\` definition is removed`);
	});
	t.doesNotMatch(text, /david-dm|travis-ci|testling|gittip/, 'nothing of the obsolete services remains');
	t.deepEqual(drift(text, identity), [], 'the fixed README has no drift');
	t.end();
});

test('readme: a definition an obsolete badge used is kept when something else in the text still references it', (t) => {
	const text = fixture('obsolete definition referenced elsewhere', obsoleteText.replace(
		'A description of foo.',
		'A description of foo. Its [old CI][4] and its [dependencies][ 6 ] are still linked.',
	));
	const fixed = fixReadme(text, identity).text;
	t.equal(definitionCount(fixed, '4'), 1, '`[4]`, referenced in the prose, is kept');
	t.equal(definitionCount(fixed, '6'), 1, '`[6]`, referenced in the prose with spaces in its brackets, is kept');
	['1', '2', '3', '5', '7', '8', '9', '10', '11'].forEach((label) => {
		t.equal(definitionCount(fixed, label), 0, `\`[${label}]\`, which nothing references any more, is removed`);
	});
	t.doesNotMatch(fixed, /^\[!\[Build Status\]/m, 'the travis badge itself is gone');
	t.deepEqual(drift(fixed, identity), [], 'the fixed README has no drift');
	t.end();
});

test('readme: an obsolete definition used twice is removed every time it is defined', (t) => {
	const text = fixture('duplicated obsolete definition', obsoleteText.replace(
		'[gittip-url]: https://www.gittip.com/ljharb/\n',
		'[gittip-url]: https://www.gittip.com/ljharb/\n[5]: https://david-dm.org/ljharb/foo.svg?again\n',
	));
	const fixed = fixReadme(text, identity).text;
	t.equal(definitionCount(fixed, '5'), 0, 'both definitions of `[5]` are gone');
	t.equal(fixed, canonical({ defs: obsoleteFixedDefs }), 'the result is the same as without the duplicate');
	t.end();
});

test('readme: extra badges are kept after the standard ones', (t) => {
	const cii = '[![CII Best Practices][cii-image]][cii-url]';
	const ciiDefs = [
		'[cii-image]: https://bestpractices.coreinfrastructure.org/projects/1234/badge',
		'[cii-url]: https://bestpractices.coreinfrastructure.org/projects/1234',
	];
	const kept = fixture('extra badge', canonical({ extra: [cii], defs: [...definitionLines(), ...ciiDefs] }));
	t.deepEqual(drift(kept, identity), [], 'an extra badge after the standard ones is not drift');
	t.equal(fixReadme(kept, identity).text, kept, 'fixing it changes nothing');

	const before = fixture('extra badge first', [
		headingFor('foo'),
		'',
		cii,
		...standardBadges,
		'',
		npmBadge,
		'',
		'A description of foo.',
		'',
		...definitionLines(),
		...ciiDefs,
	].join('\n').concat('\n'));
	t.deepEqual(drift(before, identity), ['badges'], 'an extra badge before the standard ones is badge drift');
	t.equal(fixReadme(before, identity).text, kept, 'fixing it moves the extra badge after the standard ones, and keeps its definitions');

	const twoExtras = '[![a](https://example.com/a.svg)](https://example.com/a) [![b](https://example.com/b.svg)](https://example.com/b)';
	const afterNpm = fixture('extra badges after the npm badge', canonical({ defs: [...definitionLines(), ...ciiDefs] }).replace(`${npmBadge}\n`, `${npmBadge}\n\n${twoExtras}\n${cii}\n`));
	t.deepEqual(drift(afterNpm, identity), ['badges'], 'extra badges after the npm badge are badge drift');
	t.equal(
		fixReadme(afterNpm, identity).text,
		canonical({ extra: [twoExtras, cii], defs: [...definitionLines(), ...ciiDefs] }),
		'fixing it moves them, in their original order and lines, before the npm badge',
	);
	t.end();
});

test('readme: on a line that mixes obsolete and extra badges, only the extra ones are kept', (t) => {
	const text = fixture('mixed badge line', [
		'# foo <sup>[![Version Badge][npm-version-svg]][package-url]</sup>',
		'',
		...standardBadges,
		'[![dependency status][deps-svg]][deps-url] [![CII Best Practices][cii-image]][cii-url] [![dev dependency status][dev-deps-svg]][dev-deps-url]',
		'',
		npmBadge,
		'',
		'A description of foo.',
		'',
		...definitionLines(),
		'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
		'[deps-url]: https://david-dm.org/ljharb/foo',
		'[cii-image]: https://bestpractices.coreinfrastructure.org/projects/1234/badge',
		'[cii-url]: https://bestpractices.coreinfrastructure.org/projects/1234',
		'[dev-deps-svg]: https://david-dm.org/ljharb/foo/dev-status.svg',
		'[dev-deps-url]: https://david-dm.org/ljharb/foo#info=devDependencies',
	].join('\n').concat('\n'));
	t.deepEqual(drift(text, identity), ['badges', 'links'], 'the obsolete badges are badge drift, and their definitions link drift');
	t.equal(
		fixReadme(text, identity).text,
		canonical({
			extra: ['[![CII Best Practices][cii-image]][cii-url]'],
			defs: [
				...definitionLines(),
				'[cii-image]: https://bestpractices.coreinfrastructure.org/projects/1234/badge',
				'[cii-url]: https://bestpractices.coreinfrastructure.org/projects/1234',
			],
		}),
		'fixing it keeps only the extra badge, on its own line, and only its definitions',
	);
	t.end();
});

test('readme: an obsolete badge whose definitions are missing is told by its label', (t) => {
	const text = fixture('undefined obsolete badge', canonical().replace(`${standardBadges[3]}\n`, `${standardBadges[3]}\n[![dependency status][deps-svg]][deps-url]\n`));
	t.deepEqual(drift(text, identity), ['badges'], 'it is badge drift');
	t.equal(fixReadme(text, identity).text, canonical(), 'fixing it removes it rather than keeping it as an extra');
	t.end();
});

test('readme: a standard badge whose definition is missing is not kept as an extra badge too', (t) => {
	const withoutCodecov = definitionLines().filter((line) => !line.startsWith('[codecov-'));
	const text = fixture('standard badge without definitions', canonical({ defs: withoutCodecov }));
	t.deepEqual(drift(text, identity), ['links'], 'only the links drift');
	const fixed = fixReadme(text, identity).text;
	t.equal((fixed.match(/\[!\[coverage\]/g) ?? []).length, 1, 'the coverage badge appears once');
	t.equal(fixed, canonical({ defs: [...withoutCodecov, ...definitionLines().filter((line) => line.startsWith('[codecov-'))] }), 'its definitions are appended');

	const relabeled = fixture('standard badges with other alt text and no definitions', [
		headingFor('foo'),
		'',
		'[![Build Status][actions-image]][actions-url]',
		'[![Coverage Status][codecov-image]][codecov-url]',
		'[![license][license-image]][license-url]',
		'[![downloads][downloads-image]][downloads-url]',
		'',
		'[![npm][npm-badge-png]][package-url]',
		'',
		'A description of foo.',
	].join('\n').concat('\n'));
	t.deepEqual(drift(relabeled, identity), ['badges', 'links'], 'standard badges written differently, with no definitions, are badge and link drift');
	t.equal(fixReadme(relabeled, identity).text, canonical(), 'fixing it replaces them, by their labels, without keeping any as an extra');
	t.end();
});

test('readme: inline-URL badges are classified by their image URL', (t) => {
	const travis = '[![Build Status](https://travis-ci.org/ljharb/foo.svg?branch=main)](https://travis-ci.org/ljharb/foo)';
	const david = '[![dependencies](<https://david-dm.org/ljharb/foo.svg> "deps")](https://david-dm.org/ljharb/foo)';
	const cii = '[![CII Best Practices](https://bestpractices.coreinfrastructure.org/projects/1234/badge)](https://bestpractices.coreinfrastructure.org/projects/1234)';
	const text = fixture('inline badges', [
		'# foo',
		'',
		travis,
		david,
		cii,
		'[![npm](https://nodei.co/npm/foo.png)](https://npmjs.org/package/foo)',
		'',
		'A description of foo.',
	].join('\n').concat('\n'));
	t.deepEqual(drift(text, identity), ['heading', 'badges', 'links'], 'everything drifts');
	t.equal(fixReadme(text, identity).text, canonical({ extra: [cii] }), 'fixing it removes the ci, obsolete, and npm inline badges, keeping only the extra one');
	t.end();
});

test('readme: a README with no heading has one inserted at the top', (t) => {
	const text = fixture('no heading', 'A description of foo.\n');
	t.deepEqual(drift(text, identity), ['heading', 'badges', 'links'], 'everything drifts');
	t.deepEqual(fixReadme(text, identity), { text: canonical(), skipped: [] }, 'fixing everything gives the canonical README');

	t.deepEqual(
		fixReadme(text, identity, only('heading')),
		{ text: `${headingFor('foo')}\n\nA description of foo.\n`, skipped: [] },
		'fixing only the heading inserts it, and a blank line, at the top',
	);
	t.deepEqual(
		fixReadme(text, identity, only('badges')),
		{ text, skipped: [{ why: 'there’s no heading to put the badges under' }] },
		'fixing only the badges is skipped, with a reason, and changes nothing',
	);
	const badgesAndLinks = fixReadme(text, identity, only('badges', 'links'));
	t.deepEqual(badgesAndLinks.skipped, [{ why: 'there’s no heading to put the badges under' }], 'fixing the badges and links skips the badges');
	t.equal(badgesAndLinks.text, `A description of foo.\n\n${definitionLines().join('\n')}\n`, 'but still adds the definitions');

	const subheadings = fixture('only subheadings', '## Usage\n\nA description of foo.\n');
	t.equal(fixReadme(subheadings, identity, only('heading')).text, `${headingFor('foo')}\n\n## Usage\n\nA description of foo.\n`, 'a level-two heading is not the heading, so one is inserted above it');

	const blankFirst = fixture('no heading, blank first line', '\nA description of foo.\n');
	t.equal(fixReadme(blankFirst, identity, only('heading')).text, `${headingFor('foo')}\n\nA description of foo.\n`, 'no extra blank line is added when the README starts with one');

	const empty = fixture('empty', '');
	t.deepEqual(drift(empty, identity), ['heading', 'badges', 'links'], 'an empty README drifts in everything');
	t.deepEqual(drift(fixReadme(empty, identity).text, identity), [], 'an empty README, fixed, has no drift');
	t.end();
});

test('readme: content before the heading is preserved', (t) => {
	const banner = ['<p align="center">', '  <img src="banner.png" alt="foo">', '</p>', ''];
	const text = fixture('banner', [
		...banner,
		'# foo',
		'',
		'[![Build Status][travis-svg]][travis-url]',
		'',
		'A description of foo.',
		'',
		'[travis-svg]: https://travis-ci.org/ljharb/foo.svg',
		'[travis-url]: https://travis-ci.org/ljharb/foo',
	].join('\n').concat('\n'));
	t.deepEqual(drift(text, identity), ['heading', 'badges', 'links'], 'everything drifts');
	t.equal(fixReadme(text, identity).text, `${banner.join('\n')}\n${canonical()}`, 'the banner is kept, and the header fixed below it');

	const canonicalWithBanner = fixture('canonical with banner', `${banner.join('\n')}\n${canonical()}`);
	t.deepEqual(drift(canonicalWithBanner, identity), [], 'a canonical README after a banner has no drift');
	t.end();
});

test('readme: fenced code blocks are ignored', (t) => {
	const code = [
		'```markdown',
		'# not-the-heading',
		'',
		'[![Build Status][travis-svg]][travis-url]',
		'',
		'[package-url]: https://example.com/wrong',
		'[travis-svg]: https://travis-ci.org/ljharb/foo.svg',
		'```',
	];
	const text = fixture('fenced code in body', canonical({ body: ['A description of foo.', '', ...code] }));
	t.deepEqual(drift(text, identity), [], 'a heading, badge, and definitions in a fenced code block are not drift');
	t.equal(fixReadme(text, identity).text, text, 'fixing it changes nothing');

	const tildes = ['~~~~', '# also-not-the-heading', '```', '[codecov-url]: https://example.com/wrong', '~~~~'];
	const nested = fixture('tilde fence containing a backtick fence', canonical({ body: ['A description of foo.', '', ...tildes] }));
	t.deepEqual(drift(nested, identity), [], 'a backtick fence line inside a tilde fence does not close it');

	const noHeading = fixture('heading only inside code', ['Some text.', '', ...code, ''].join('\n'));
	t.equal(
		fixReadme(noHeading, identity, only('heading')).text,
		`${headingFor('foo')}\n\n${noHeading}`,
		'a heading only inside a code block is not the heading, so one is inserted at the top',
	);

	const fencedFirst = fixture('fenced definition before the real one', canonical({ body: ['A description of foo.', '', '```', '[codecov-url]: https://example.com/wrong', '```'] }));
	t.deepEqual(drift(fencedFirst, identity), [], 'a fenced definition before the real one does not count as the first definition');

	const unclosed = fixture('unclosed fence', `${canonical({ defs: [] }).trimEnd()}\n\n\`\`\`\n[package-url]: https://example.com/wrong\n`);
	const fixedUnclosed = fixReadme(unclosed, identity).text;
	t.ok(fixedUnclosed.includes('[package-url]: https://example.com/wrong'), 'a definition inside an unclosed fence is left alone');
	t.end();
});

test('readme: line endings are kept', (t) => {
	const crlf = fixture('CRLF canonical', canonical({ eol: '\r\n' }));
	t.deepEqual(drift(crlf, identity), [], 'a canonical CRLF README has no drift');
	t.equal(fixReadme(crlf, identity).text, crlf, 'fixing it changes nothing');

	const crlfDrifted = fixture('CRLF drifted', obsoleteText.replace(/\n/g, '\r\n'));
	const fixed = fixReadme(crlfDrifted, identity).text;
	t.equal(fixed, canonical({ defs: obsoleteFixedDefs, eol: '\r\n' }), 'a drifted CRLF README is fixed with CRLF line endings');
	t.doesNotMatch(fixed, /(?<!\r)\n/, 'no bare LF is introduced');

	const crlfNoDefs = fixture('CRLF no definitions', `${[...header(), '', 'A description of foo.'].join('\r\n')}\r\n`);
	t.equal(fixReadme(crlfNoDefs, identity).text, canonical({ eol: '\r\n' }), 'definitions appended to a CRLF README use CRLF');

	const lf = canonical();
	t.doesNotMatch(fixReadme(obsoleteText, identity).text, /\r/, 'an LF README is fixed with LF line endings');
	t.equal(fixReadme(lf, identity).text, lf, 'a canonical LF README is unchanged');

	const mixed = fixture('mixed line endings', canonical().replace('\n', '\r\n'));
	t.equal(fixReadme(mixed, identity, only('heading')).text, canonical(), 'a README with mixed line endings is written with LF');
	t.end();
});

test('readme: a missing final newline', (t) => {
	const noFinal = fixture('canonical, no final newline', canonical().slice(0, -1));
	t.deepEqual(drift(noFinal, identity), [], 'a canonical README without a final newline has no drift');
	t.equal(fixReadme(noFinal, identity).text, noFinal, 'fixing it does not add a final newline');

	const headingDrift = fixture('heading drift, no final newline', canonical().slice(0, -1).replace('# foo ', '# bar '));
	t.equal(fixReadme(headingDrift, identity).text, canonical().slice(0, -1), 'fixing the heading keeps the missing final newline');

	const missingDefs = fixture('missing definitions, no final newline', [...header(), '', 'A description of foo.'].join('\n'));
	t.equal(fixReadme(missingDefs, identity).text, canonical(), 'appending definitions ends the file with a newline');

	const crlfNoFinal = fixture('CRLF, no final newline', canonical({ eol: '\r\n' }).slice(0, -2));
	t.deepEqual(drift(crlfNoFinal, identity), [], 'a canonical CRLF README without a final newline has no drift');
	t.equal(fixReadme(crlfNoFinal, identity).text, crlfNoFinal, 'and fixing it changes nothing');
	t.end();
});

test('readme: the first definition of a label is the one that counts', (t) => {
	const duplicateAfter = fixture('wrong duplicate after the right one', canonical({ defs: [...definitionLines(), '[codecov-url]: https://example.com/wrong'] }));
	t.deepEqual(drift(duplicateAfter, identity), [], 'a wrong duplicate after the right definition is not drift, since it has no effect');

	const wrongFirst = fixture('wrong one before the right duplicate', canonical({ defs: ['[codecov-url]: https://example.com/wrong', ...definitionLines()] }));
	t.deepEqual(drift(wrongFirst, identity), ['links'], 'a wrong definition before a right duplicate is link drift');
	const fixed = fixReadme(wrongFirst, identity).text;
	t.equal(fixed, canonical({ defs: ['[codecov-url]: https://app.codecov.io/gh/ljharb/foo/', ...definitionLines()] }), 'fixing it rewrites the first, in place');
	t.deepEqual(drift(fixed, identity), [], 'and then there is no drift');
	t.end();
});

test('readme: labels are matched case-insensitively', (t) => {
	const upper = fixture('uppercase label', canonical().replace('[package-url]:', '[Package-URL]:'));
	t.deepEqual(drift(upper, identity), ['links'], 'a definition whose label differs in case is written differently, so it is link drift');
	const fixed = fixReadme(upper, identity).text;
	t.equal(fixed, canonical(), 'fixing it rewrites that definition in place, rather than adding another');
	t.equal(definitionCount(fixed, 'package-url'), 1, 'there is exactly one `package-url` definition');

	const obsoleteUpper = fixture('uppercase obsolete label', canonical({ defs: [...definitionLines(), '[deps-svg]: https://david-dm.org/ljharb/foo.svg', '[deps-url]: https://david-dm.org/ljharb/foo'] })
		.replace(`${standardBadges[3]}\n`, `${standardBadges[3]}\n[![dependency status][DEPS-SVG]][Deps-Url]\n`));
	t.deepEqual(drift(obsoleteUpper, identity), ['badges', 'links'], 'an obsolete badge referencing its definitions in another case is found');
	t.equal(fixReadme(obsoleteUpper, identity).text, canonical(), 'fixing it removes the badge and its definitions');

	const spaced = fixture('label with spaces', canonical({ defs: [...definitionLines(), '[my   Badge]: https://example.com/b.svg'] })
		.replace(`${standardBadges[3]}\n`, `${standardBadges[3]}\n[![x][My Badge]](https://example.com)\n`));
	t.deepEqual(drift(spaced, identity), [], 'an extra badge whose label matches its definition only after normalizing whitespace and case is kept');
	t.end();
});

test('readme: a backtick fence opener can’t have a backtick in its info string', (t) => {
	const codeSpan = fixture('backtick in a fence opener’s info string', canonical({ body: ['A description of foo.', '', '```js `not a fence`', '# not a title either, but not code'] }));
	t.deepEqual(drift(codeSpan, identity), [], 'a line like a backtick fence opener but with a backtick in its info string opens no fence, so the definitions after it are seen, and there’s no drift');
	t.deepEqual(fixReadme(codeSpan, identity), { text: codeSpan, skipped: [] }, 'fixing it changes nothing');
	t.equal(fixReadme(fixReadme(codeSpan, identity).text, identity).text, codeSpan, 'and is idempotent');

	const inlineFence = fixture('a whole code span that looks like a fence', canonical({ body: ['A description of foo.', '', '``` `x` ```'] }));
	t.deepEqual(drift(inlineFence, identity), [], 'a line that’s a code span made of backticks is not a fence');
	t.equal(fixReadme(inlineFence, identity).text, inlineFence, 'fixing it changes nothing');

	const tilde = fixture('backtick in a tilde fence opener’s info string', canonical({ body: ['A description of foo.', '', '~~~js `x`', '[codecov-url]: https://example.com/wrong', '~~~'] }));
	t.deepEqual(drift(tilde, identity), [], 'a tilde fence opener can have a backtick in its info string, and is still a fence, hiding the definition in it');
	t.equal(fixReadme(tilde, identity).text, tilde, 'fixing it changes nothing');

	const missing = fixture('backtick info string, missing a definition', canonical({ body: ['A description of foo.', '', '```js `x`'], defs: definitionLines().slice(0, -1) }));
	t.deepEqual(drift(missing, identity), ['links'], 'a missing definition after it is only link drift');
	t.equal(fixReadme(missing, identity).text, canonical({ body: ['A description of foo.', '', '```js `x`'] }), 'which is added after the last definition, not before it as though a fence were left open');
	t.end();
});

test('readme: a leading byte order mark is kept, and ignored for finding the title', (t) => {
	const bom = '\uFEFF';
	const text = fixture('BOM, canonical', `${bom}${canonical()}`);
	t.deepEqual(drift(text, identity), [], 'a canonical README after a BOM has no drift: its title is found');
	t.deepEqual(fixReadme(text, identity), { text, skipped: [] }, 'fixing it changes nothing, keeping the BOM');

	const crlf = fixture('BOM, CRLF canonical', `${bom}${canonical({ eol: '\r\n' })}`);
	t.deepEqual(drift(crlf, identity), [], 'nor after a BOM with CRLF line endings');
	t.equal(fixReadme(crlf, identity).text, crlf, 'fixing it changes nothing');

	const drifted = fixture('BOM, drifted heading', `${bom}${canonical().replace('# foo ', '# bar ')}`);
	t.deepEqual(drift(drifted, identity), ['heading'], 'a drifted title after a BOM is found, and is only heading drift');
	const fixed = fixReadme(drifted, identity).text;
	t.equal(fixed, `${bom}${canonical()}`, 'fixing it replaces the title in place, keeping the BOM first');
	t.equal(fixed.indexOf(bom), 0, 'one BOM, at the start');
	t.equal(fixed.lastIndexOf(bom), 0, 'and only one');
	t.equal(fixReadme(fixed, identity).text, fixed, 'and is idempotent');

	const noHeading = fixture('BOM, no heading', `${bom}A description of foo.\n`);
	t.equal(fixReadme(noHeading, identity, only('heading')).text, `${bom}${headingFor('foo')}\n\nA description of foo.\n`, 'a heading inserted at the top goes after the BOM');
	t.equal(fixReadme(noHeading, identity).text, `${bom}${canonical()}`, 'as does the whole header');
	t.end();
});

test('readme: a setext title is the heading, and is always heading drift', (t) => {
	const setextOf = (/** @type {string} */ title, /** @type {string} */ underline = '===') => canonical().replace(`${headingFor('foo')}\n`, `${title}\n${underline}\n`);
	const exact = fixture('setext title with the right text', setextOf('foo <sup>[![Version Badge][npm-version-svg]][package-url]</sup>'));
	t.deepEqual(drift(exact, identity), ['heading'], 'a setext title, even with exactly the right text, is heading drift, and only that');
	t.deepEqual(fixReadme(exact, identity), { text: canonical(), skipped: [] }, 'fixing it replaces both its lines with the ATX heading');
	t.equal(fixReadme(exact, identity, only('heading')).text, canonical(), 'as does fixing only the heading');

	const plain = fixture('plain setext title', setextOf('foo', '=========='));
	t.deepEqual(drift(plain, identity), ['heading'], 'a plain setext title is only heading drift: the badges under it are found');
	t.equal(fixReadme(plain, identity).text, canonical(), 'fixing it gives the canonical README');

	const indented = fixture('setext title, indented underline with trailing spaces', setextOf('foo', '   =  '));
	t.deepEqual(drift(indented, identity), ['heading'], 'an underline indented up to three spaces, with trailing spaces, is still one');
	t.equal(fixReadme(indented, identity).text, canonical(), 'fixing it gives the canonical README');

	const level2 = fixture('setext level-two title', 'foo\n---\n\nA description of foo.\n');
	t.equal(fixReadme(level2, identity, only('heading')).text, `${headingFor('foo')}\n\nfoo\n---\n\nA description of foo.\n`, 'a setext level-two heading is not the title, so one is inserted above it, leaving it alone');
	t.end();
});

test('readme: the title is only a level-one heading as the first content line', (t) => {
	const priority = fixture('`#1 priority` first', '#1 priority\n\nA description of foo.\n');
	t.deepEqual(drift(priority, identity), ['heading', 'badges', 'links'], '`#1 priority` is not a title, so there is no heading');
	t.equal(fixReadme(priority, identity, only('heading')).text, `${headingFor('foo')}\n\n#1 priority\n\nA description of foo.\n`, 'fixing the heading inserts one at the top, leaving that line untouched');
	t.ok(fixReadme(priority, identity).text.includes('\n#1 priority\n'), 'as does fixing everything');

	const scopedNoSpace = fixture('`#@scope/name` first', `#@scope/name\n\n${canonical({ id: scoped }).split('\n').slice(2).join('\n')}`, scoped);
	t.deepEqual(drift(scopedNoSpace, scoped), ['heading'], '`#@scope/name`, with no space, is the title, and only it drifts');
	t.equal(fixReadme(scopedNoSpace, scoped).text, canonical({ id: scoped }), 'fixing it replaces it');

	const tab = fixture('title after a tab', canonical().replace('# foo ', '#\tfoo '));
	t.deepEqual(drift(tab, identity), ['heading'], '`#` then a tab is the title');
	t.equal(fixReadme(tab, identity).text, canonical(), 'fixing it replaces it');

	const api = fixture('level-one section further down, no title', 'A description of foo.\n\n# API\n\nIts API.\n');
	t.deepEqual(drift(api, identity), ['heading', 'badges', 'links'], 'with no title at the top, a level-one heading further down is a section’s, not the title');
	const apiHeading = fixReadme(api, identity, only('heading')).text;
	t.equal(apiHeading, `${headingFor('foo')}\n\n${api}`, 'fixing the heading inserts one at the top, leaving the section’s alone');
	const apiFixed = fixReadme(api, identity).text;
	t.ok(apiFixed.includes('\nA description of foo.\n\n# API\n\nIts API.\n'), 'as does fixing everything');
	t.equal(fixReadme(apiFixed, identity).text, apiFixed, 'and fixing that again changes nothing');
	t.deepEqual(drift(apiFixed, identity), [], 'leaving no drift');

	const subFirst = fixture('level-two heading first, level-one later', '## Intro\n\n# foo\n\nA description of foo.\n');
	t.equal(fixReadme(subFirst, identity, only('heading')).text, `${headingFor('foo')}\n\n${subFirst}`, 'a level-one heading after a level-two first line is not the title either');
	t.end();
});

test('readme: HTML comments and HTML blocks before the title are skipped', (t) => {
	const multiline = ['<!--', '# commented-out title', '-->'];
	const comment = fixture('multi-line HTML comment before the title', `${multiline.join('\n')}\n${canonical()}`);
	t.deepEqual(drift(comment, identity), [], 'a canonical README after a multi-line HTML comment (with a heading in it) has no drift');
	t.equal(fixReadme(comment, identity).text, comment, 'fixing it changes nothing');

	const commentDrifted = fixture('multi-line HTML comment before a drifted title', `${multiline.join('\n')}\n${canonical().replace('# foo ', '# bar ')}`);
	t.deepEqual(drift(commentDrifted, identity), ['heading'], 'the title after it is found, and only it drifts');
	t.equal(fixReadme(commentDrifted, identity).text, comment, 'fixing it replaces the title, not the commented-out one');

	const oneLine = fixture('one-line HTML comment, then a blank line, before the title', `<!-- generated -->\n\n${canonical().replace('# foo ', '# bar ')}`);
	t.deepEqual(drift(oneLine, identity), ['heading'], 'a one-line comment is skipped');
	t.equal(fixReadme(oneLine, identity).text, `<!-- generated -->\n\n${canonical()}`, 'and kept');

	const block = ['<div align="center">', '  <img src="logo.png">', '</div>', '', '<p>more</p>', '', '<!-- x -->'];
	const html = fixture('HTML blocks, then a comment, before the title', `${block.join('\n')}\n${canonical().replace('# foo ', '# bar ')}`);
	t.deepEqual(drift(html, identity), ['heading'], 'HTML blocks, each ended by a blank line, and a comment, are skipped');
	t.equal(fixReadme(html, identity).text, `${block.join('\n')}\n${canonical()}`, 'and kept, with the title fixed after them');

	const unended = fixture('HTML block running into a level-one heading', `<div>\n${canonical()}`);
	t.equal(
		fixReadme(unended, identity, only('heading')).text,
		`${headingFor('foo')}\n\n${unended}`,
		'a level-one heading inside an HTML block (not yet ended by a blank line) is not the title, so one is inserted at the top',
	);

	const textFirst = fixture('prose before the title, after a comment', '<!-- x -->\nSome prose.\n\n# foo\n\nA description of foo.\n');
	t.equal(fixReadme(textFirst, identity, only('heading')).text, `${headingFor('foo')}\n\n${textFirst}`, 'prose after a comment is the first content line, so a level-one heading after it is not the title');
	t.end();
});

test('readme: extra badges on the title line are kept, under it, first among the extras', (t) => {
	const x = '[![x](https://example.com/x.svg)](https://example.com/x)';
	const y = '[![y](https://example.com/y.svg)](https://example.com/y)';
	const onTitle = canonical({ extra: [y] }).replace(headingFor('foo'), `${headingFor('foo')} ${x}`);
	t.deepEqual(drift(onTitle, identity), ['heading'], 'an extra badge on the title line is heading drift, which only fixing the heading moves');
	t.deepEqual(drift(fixReadme(onTitle, identity, only('heading')).text, identity), ['badges'], 'once moved under the heading, ahead of the standard badges, it’s badge drift');
	t.equal(fixReadme(onTitle, identity).text, canonical({ extra: [x, y] }), 'fixing it moves it under the heading, before the other extra badges');

	const headingOnly = `# foo ${x} [![deps](https://david-dm.org/ljharb/foo.svg)](https://david-dm.org/ljharb/foo)\n\nA description of foo.\n`;
	t.equal(
		fixReadme(headingOnly, identity, only('heading')).text,
		`${headingFor('foo')}\n\n${x}\n\nA description of foo.\n`,
		'fixing only the heading keeps the extra badge, on its own line under it, but not the obsolete one',
	);
	t.equal(fixReadme(headingOnly, identity).text, canonical({ extra: [x] }), 'fixing everything keeps it as an extra badge');

	[onTitle, headingOnly].forEach((text, i) => {
		const name = i === 0 ? 'with a version badge' : 'plain';
		const once = fixReadme(text, identity).text;
		t.equal(fixReadme(once, identity).text, once, `${name}: fixing everything is idempotent`);
		t.deepEqual(drift(once, identity), [], `${name}: and leaves no drift`);
		['heading', 'links'].forEach((c) => {
			const partial = fixReadme(text, identity, only(/** @type {Category} */ (c))).text;
			t.equal(fixReadme(partial, identity, only(/** @type {Category} */ (c))).text, partial, `${name}: fixing only \`${c}\` is idempotent`);
		});
		const staged = fixReadme(fixReadme(text, identity, only('heading')).text, identity, only('badges')).text;
		t.equal((staged.match(/\[!\[x\]/g) ?? []).length, 1, `${name}: fixing the heading, then the badges, keeps it once`);
	});
	t.end();
});

// a known bug, reported: `/fix badges` alone copies an extra badge on the title line under the heading but leaves it on the title line too, so each such fix adds another copy
test('readme: fixing only the badges of a README with an extra badge on its title line is idempotent', (t) => {
	const x = '[![x](https://example.com/x.svg)](https://example.com/x)';
	const text = `# foo ${x}\n\nA description of foo.\n`;
	const once = fixReadme(text, identity, only('badges')).text;
	t.equal(fixReadme(once, identity, only('badges')).text, once, 'fixing only the badges twice is the same as once');
	t.notOk(drift(once, identity).includes('badges'), 'and leaves no badge drift');
	const staged = fixReadme(once, identity, only('heading')).text;
	t.equal((staged.match(/\[!\[x\]/g) ?? []).length, 1, 'fixing the badges, then the heading, keeps it once');
	t.end();
});

test('readme: a collapsed-reference badge’s label is its alt text', (t) => {
	const collapsed = fixture('collapsed-reference obsolete badge', canonical({ defs: [...definitionLines(), '[deps]: https://david-dm.org/ljharb/foo.svg', '[deps-url]: https://david-dm.org/ljharb/foo'] })
		.replace(`${standardBadges[3]}\n`, `${standardBadges[3]}\n[![deps][]][deps-url]\n`));
	t.deepEqual(drift(collapsed, identity), ['badges', 'links'], 'an obsolete badge whose image is a collapsed reference is told by its alt text’s definition');
	const fixed = fixReadme(collapsed, identity).text;
	t.equal(fixed, canonical(), 'fixing it removes the badge, and its image’s definition (labeled by its alt text) with its link’s');
	t.equal(definitionCount(fixed, 'deps'), 0, 'the `[deps]` definition is gone');

	const staged = fixReadme(collapsed, identity, only('heading', 'badges')).text;
	t.deepEqual(drift(staged, identity), ['links'], 'fixing the badges first leaves its definitions as link drift');
	t.equal(fixReadme(staged, identity, only('links')).text, canonical(), 'which fixing the links then removes');
	t.end();
});

test('readme: a definition’s title on the next line is part of it', (t) => {
	const wanted = fixture('wanted definition with a title on the next line', canonical().replace('[license-url]: LICENSE\n', '[license-url]: LICENSE\n  "the license"\n'));
	t.deepEqual(drift(wanted, identity), ['links'], 'a wanted definition with a title on the next line is link drift');
	t.equal(fixReadme(wanted, identity).text, canonical(), 'fixing it removes the title, so the definition is as it should be');

	['\t\'single\'', '   (parens)'].forEach((title) => {
		const other = fixture(`wanted definition with a ${title.trim()} title on the next line`, canonical().replace('[codecov-url]: https://app.codecov.io/gh/ljharb/foo/\n', `[codecov-url]: https://app.codecov.io/gh/ljharb/foo/\n${title}\n`));
		t.deepEqual(drift(other, identity), ['links'], `\`${title.trim()}\` on the next line is its title, and link drift`);
		t.equal(fixReadme(other, identity).text, canonical(), 'fixing it removes it');
	});

	const obsolete = fixture('obsolete definition with a title on the next line', canonical({ defs: [...definitionLines(), '[deps-svg]: https://david-dm.org/ljharb/foo.svg', '  "dependencies"', '[cii-url]: https://example.com/cii'], body: ['A description of foo, [cii][cii-url].'] }));
	t.deepEqual(drift(obsolete, identity), ['links'], 'an unused badge definition with a title is link drift');
	t.equal(
		fixReadme(obsolete, identity).text,
		canonical({ defs: [...definitionLines(), '[cii-url]: https://example.com/cii'], body: ['A description of foo, [cii][cii-url].'] }),
		'fixing it removes the definition along with its title',
	);

	const defs = definitionLines();
	const titledLast = fixture('missing definitions after a kept one with a title on the next line', canonical({ defs: [...defs.slice(0, -2), '[cii-url]: https://example.com/cii', '  "CII"'], body: ['A description of foo, [cii][cii-url].'] }));
	t.deepEqual(drift(titledLast, identity), ['links'], 'missing definitions are link drift');
	t.equal(
		fixReadme(titledLast, identity).text,
		canonical({ defs: [...defs.slice(0, -2), '[cii-url]: https://example.com/cii', '  "CII"', ...defs.slice(-2)], body: ['A description of foo, [cii][cii-url].'] }),
		'fixing it adds them after the last kept definition’s title, not between it and its title',
	);

	const notTitle = fixture('title-like line after a definition that has a title of its own', canonical({ defs: [...defs, '[cii-url]: https://example.com/cii "CII"', '  "not a title"'], body: ['A description of foo, [cii][cii-url].'] }));
	t.deepEqual(drift(notTitle, identity), [], 'a quoted line after a definition that already has a title is not its title');
	t.equal(fixReadme(notTitle, identity).text, notTitle, 'and fixing it changes nothing');
	t.end();
});

test('readme: a badge’s unused leftover definitions are removed whenever the links are fixed', (t) => {
	const leftovers = [
		'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
		'[deps-url]: https://david-dm.org/ljharb/foo',
		'[dev-deps-url]: https://david-dm.org/ljharb/foo#info=devDependencies',
		'[testling-url]: https://ci.testling.com/ljharb/foo',
		'[travis-url]: https://travis-ci.org/ljharb/foo',
		'[npm-url]: https://npmjs.org/package/foo',
		'[npmjs-url]: https://www.npmjs.com/package/foo',
		'[stat-url]: https://npm-stat.com/charts.html?package=foo&from=2015',
		'[cov-url]: https://app.codecov.io/gh/ljharb/foo',
		'[ci-url]: https://github.com/ljharb/foo/actions/',
		'[gittip-image]: https://img.shields.io/gittip/ljharb.svg',
	];
	const kept = ['[other]: https://example.com', '[repo]: https://github.com/ljharb/foo', '[workflow]: https://github.com/ljharb/foo/actions/workflows/node.yml'];
	const body = ['A description of foo, [elsewhere][other], [the repo][repo], [a workflow][workflow].'];
	const text = fixture('a badge’s leftover definitions', canonical({ body, defs: [...definitionLines(), ...leftovers, ...kept] }));
	t.deepEqual(drift(text, identity), ['links'], 'a canonical header with leftover definitions of badges nothing uses is only link drift');
	categories.forEach((c) => {
		const once = fixReadme(text, identity, only(c)).text;
		t.equal(once, c === 'links' ? canonical({ body, defs: [...definitionLines(), ...kept] }) : text, `fixing only \`${c}\` ${c === 'links' ? 'removes them, keeping definitions that aren’t a badge’s' : 'changes nothing'}`);
		t.equal(fixReadme(once, identity, only(c)).text, once, `and fixing only \`${c}\` again changes nothing`);
	});

	const referenced = fixture('a badge’s leftover definition still referenced', canonical({ body: ['A description of foo, [on npm][npm-url].'], defs: [...definitionLines(), '[npm-url]: https://npmjs.org/package/foo', '[deps-url]: https://david-dm.org/ljharb/foo'] }));
	t.equal(
		fixReadme(referenced, identity, only('links')).text,
		canonical({ body: ['A description of foo, [on npm][npm-url].'], defs: [...definitionLines(), '[npm-url]: https://npmjs.org/package/foo'] }),
		'one still referenced is kept',
	);
	t.end();
});

test('readme: fixing the heading and badges, and then, separately, the links, removes the old badges’ definitions', (t) => {
	const text = fixture('david-dm badges, fixed in stages', [
		'# foo',
		'',
		'[![dependency status][deps-svg]][deps-url]',
		'[![dev dependency status][dev-deps-svg]][dev-deps-url]',
		'[![License][license-image]][license-url]',
		'',
		'A description of foo.',
		'',
		...definitionLines(),
		'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
		'[deps-url]: https://david-dm.org/ljharb/foo',
		'[dev-deps-svg]: https://david-dm.org/ljharb/foo/dev-status.svg',
		'[dev-deps-url]: https://david-dm.org/ljharb/foo#info=devDependencies',
	].join('\n').concat('\n'));
	t.deepEqual(drift(text, identity), ['heading', 'badges', 'links'], 'every category drifts');

	const first = fixReadme(text, identity, only('heading', 'badges'));
	t.deepEqual(first.skipped, [], 'the first step skips nothing');
	t.equal(first.text, `${canonical().trimEnd()}\n${[
		'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
		'[deps-url]: https://david-dm.org/ljharb/foo',
		'[dev-deps-svg]: https://david-dm.org/ljharb/foo/dev-status.svg',
		'[dev-deps-url]: https://david-dm.org/ljharb/foo#info=devDependencies',
	].join('\n')}\n`, 'the first step fixes the header, leaving the david-dm definitions');
	t.deepEqual(drift(first.text, identity), ['links'], 'between the steps, those leftover definitions are link drift');

	const second = fixReadme(first.text, identity, only('links'));
	t.deepEqual(second, { text: canonical(), skipped: [] }, 'the second step, which no longer sees the old badges, still removes them');
	t.deepEqual(drift(second.text, identity), [], 'leaving no drift');
	t.equal(fixReadme(second.text, identity).text, second.text, 'and fixing it again changes nothing');
	t.equal(fixReadme(text, identity).text, second.text, 'the same as fixing everything at once');
	t.end();
});

test('readme: when every definition is removed and the missing ones added, there is exactly one blank line before them', (t) => {
	const obsoleteOnly = [
		'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
		'[deps-url]: https://david-dm.org/ljharb/foo',
	];
	const text = fixture('only obsolete definitions, with blank lines around them', `${[...header(), '', 'A description of foo.', '', '', ...obsoleteOnly, '', ''].join('\n')}\n`);
	t.deepEqual(drift(text, identity), ['links'], 'only the links drift');
	t.equal(fixReadme(text, identity).text, canonical(), 'fixing everything leaves exactly one blank line before the added definitions');
	t.equal(fixReadme(text, identity, only('links')).text, canonical(), 'as does fixing only the links');

	const tight = fixture('only obsolete definitions, right after the prose', `${[...header(), '', 'A description of foo.', ...obsoleteOnly].join('\n')}\n`);
	t.equal(fixReadme(tight, identity).text, canonical(), 'even with no blank line before them to begin with');

	const crlf = fixture('only obsolete definitions, CRLF', `${[...header(), '', 'A description of foo.', '', '', ...obsoleteOnly, ''].join('\r\n')}\r\n`);
	t.equal(fixReadme(crlf, identity).text, canonical({ eol: '\r\n' }), 'and with CRLF line endings');
	t.end();
});

test('readme: missing definitions go before a fence left open at the end, idempotently', (t) => {
	const tail = ['```', 'some code', '[package-url]: https://example.com/wrong'];
	const text = fixture('unclosed fence at the end, no definitions', `${[...header(), '', 'A description of foo.', '', ...tail].join('\n')}\n`);
	t.deepEqual(drift(text, identity), ['links'], 'the definitions are missing: the one in the open fence doesn’t count');
	const fixed = fixReadme(text, identity).text;
	t.equal(fixed, `${[...header(), '', 'A description of foo.', '', ...definitionLines(), '', ...tail].join('\n')}\n`, 'fixing it adds them before the open fence, which would otherwise hide them, after one blank line and before another');
	t.equal(fixReadme(fixed, identity).text, fixed, 'fixing it again changes nothing');
	t.deepEqual(drift(fixed, identity), [], 'leaving no drift');
	t.equal(fixReadme(text, identity, only('links')).text, fixed, 'fixing only the links does the same');

	const obsolete = fixture('unclosed fence at the end, only an obsolete definition', `${[...header(), '', 'A description of foo.', '', '[deps-svg]: https://david-dm.org/ljharb/foo.svg', '', ...tail].join('\n')}\n`);
	const fixedObsolete = fixReadme(obsolete, identity).text;
	t.equal(fixedObsolete, fixed, 'with no definitions kept, the missing ones still go before the open fence');
	t.equal(fixReadme(fixedObsolete, identity).text, fixedObsolete, 'idempotently');

	const kept = fixture('unclosed fence at the end, a definition kept before it', `${[...header(), '', 'A description of foo.', '', '[package-url]: https://npmjs.org/package/foo', '', ...tail].join('\n')}\n`);
	const fixedKept = fixReadme(kept, identity).text;
	t.equal(fixedKept, fixed, 'with a definition kept before it, the missing ones follow that one');
	t.end();
});

// a README with every category drifted: an old heading, david-dm badges, and a wrong definition
const allDrifted = [
	'# foo',
	'',
	'[![dependency status][deps-svg]][deps-url]',
	'[![License][license-image]][license-url]',
	'',
	'A description of foo.',
	'',
	'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
	'[deps-url]: https://david-dm.org/ljharb/foo',
	'[license-image]: https://img.shields.io/npm/l/foo.svg',
	'[license-url]: LICENSE.md',
].join('\n').concat('\n');

test('readme: fixing only some categories fixes only those', (t) => {
	fixture('all drifted', allDrifted);
	t.deepEqual(drift(allDrifted, identity), ['heading', 'badges', 'links'], 'every category drifts');

	const heading = fixReadme(allDrifted, identity, only('heading'));
	t.deepEqual(heading, { text: allDrifted.replace('# foo\n', `${headingFor('foo')}\n`), skipped: [] }, 'fixing only the heading changes only the heading line');
	t.deepEqual(drift(heading.text, identity), ['badges', 'links'], 'leaving the badges and links drifted');

	const badges = fixReadme(allDrifted, identity, only('badges'));
	t.equal(badges.text, [
		'# foo',
		'',
		...standardBadges,
		'',
		npmBadge,
		'',
		'A description of foo.',
		'',
		'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
		'[deps-url]: https://david-dm.org/ljharb/foo',
		'[license-image]: https://img.shields.io/npm/l/foo.svg',
		'[license-url]: LICENSE.md',
	].join('\n').concat('\n'), 'fixing only the badges changes only the badges, leaving the definitions alone');
	t.deepEqual(drift(badges.text, identity), ['heading', 'links'], 'leaving the heading and links drifted');

	const links = fixReadme(allDrifted, identity, only('links'));
	t.equal(links.text, [
		'# foo',
		'',
		'[![dependency status][deps-svg]][deps-url]',
		'[![License][license-image]][license-url]',
		'',
		'A description of foo.',
		'',
		'[deps-svg]: https://david-dm.org/ljharb/foo.svg',
		'[deps-url]: https://david-dm.org/ljharb/foo',
		'[license-image]: https://img.shields.io/npm/l/foo.svg',
		'[license-url]: LICENSE',
		...definitionLines().filter((line) => !line.startsWith('[license-')),
	].join('\n').concat('\n'), 'fixing only the links fixes and adds definitions, but keeps the ones the unfixed badges still use');
	// the definitions only the obsolete badges use are link drift until those badges are fixed, since that's when they become unused: so the links still drift
	t.deepEqual(drift(links.text, identity), ['heading', 'badges', 'links'], 'leaving the heading and badges drifted, and the links too, for the definitions the obsolete badges still use');

	const headingAndBadges = fixReadme(allDrifted, identity, only('heading', 'badges'));
	t.deepEqual(drift(headingAndBadges.text, identity), ['links'], 'fixing the heading and badges leaves only the links drifted, including the now-unused definitions');
	t.equal(fixReadme(headingAndBadges.text, identity, only('links')).text, canonical({ defs: [
		'[license-image]: https://img.shields.io/npm/l/foo.svg',
		'[license-url]: LICENSE',
		...definitionLines().filter((line) => !line.startsWith('[license-')),
	] }), 'and fixing the links after that removes the definitions the old badges used');

	const everything = fixReadme(allDrifted, identity);
	t.equal(everything.text, fixReadme(allDrifted, identity, only('heading', 'badges', 'links')).text, 'fixing every category by name is the same as fixing everything');
	t.equal(fixReadme(allDrifted, identity, new Set()).text, everything.text, 'an empty set of categories means every category');
	t.deepEqual(drift(everything.text, identity), [], 'fixing everything leaves no drift');
	t.end();
});

// realistic READMEs, in the forms these packages' READMEs have taken over the years, written out whole
const realistic = [
	{
		name: 'old ljharb style with a testling matrix and numbered references',
		id: { name: 'object.assign', repository: 'ljharb/object.assign', branch: 'main' },
		text: `#object.assign <sup>[![Version Badge][npm-version-svg]][npm-url]</sup>

[![Build Status][travis-svg]][travis-url]
[![dependency status][deps-svg]][deps-url]
[![dev dependency status][dev-deps-svg]][dev-deps-url]
[![License][license-image]][license-url]
[![Downloads][downloads-image]][downloads-url]

[![npm badge][npm-badge-png]][npm-url]

[![browser support][testling-png]][testling-url]

An Object.assign shim. Invoke its "shim" method to shim Object.assign if it is unavailable.

## Example

\`\`\`js
var assign = require('object.assign').getPolyfill();
// [npm-url]: not a definition
\`\`\`

## Tests
Simply clone the repo, \`npm install\`, and run \`npm test\`

[npm-url]: https://npmjs.org/package/object.assign
[npm-version-svg]: http://versionbadg.es/ljharb/object.assign.svg
[travis-svg]: https://travis-ci.org/ljharb/object.assign.svg
[travis-url]: https://travis-ci.org/ljharb/object.assign
[deps-svg]: https://david-dm.org/ljharb/object.assign.svg?theme=shields.io
[deps-url]: https://david-dm.org/ljharb/object.assign
[dev-deps-svg]: https://david-dm.org/ljharb/object.assign/dev-status.svg?theme=shields.io
[dev-deps-url]: https://david-dm.org/ljharb/object.assign#info=devDependencies
[testling-png]: https://ci.testling.com/ljharb/object.assign.png
[testling-url]: https://ci.testling.com/ljharb/object.assign
[npm-badge-png]: https://nodei.co/npm/object.assign.png?downloads=true&stars=true
[license-image]: http://img.shields.io/npm/l/object.assign.svg
[license-url]: LICENSE
[downloads-image]: http://img.shields.io/npm/dm/object.assign.svg
[downloads-url]: http://npm-stat.com/charts.html?package=object.assign
`,
	},
	{
		name: 'a scoped package with GitHub Actions workflow badges inline and a CII badge',
		id: { name: '@ljharb/through', repository: 'ljharb/through', branch: 'main' },
		text: `<!-- a comment before anything -->
# @ljharb/through

[![github actions](https://github.com/ljharb/through/actions/workflows/node-pretest.yml/badge.svg)](https://github.com/ljharb/through/actions)
[![coverage](https://codecov.io/gh/ljharb/through/branch/main/graphs/badge.svg)](https://app.codecov.io/gh/ljharb/through/)
[![CII Best Practices](https://bestpractices.coreinfrastructure.org/projects/1234/badge)](https://bestpractices.coreinfrastructure.org/projects/1234)

Easy way to create a \`Stream\` that is both \`readable\` and \`writable\`.

~~~js
# not a heading
~~~
`,
	},
	{
		name: 'a CRLF README with no final newline and a gittip badge',
		id: { name: 'is-callable', repository: 'inspect-js/is-callable', branch: 'main' },
		text: [
			'# is-callable <sup>[![Version Badge][2]][1]</sup>',
			'',
			'[![github actions][actions-image]][actions-url]',
			'[![coverage][codecov-image]][codecov-url]',
			'[![dependency status][5]][6]',
			'[![dev dependency status][7]][8]',
			'[![License][license-image]][license-url]',
			'[![Downloads][downloads-image]][downloads-url]',
			'[![gittip][gittip-image]][gittip-url]',
			'',
			'[![npm badge][11]][1]',
			'',
			'Is this JS value callable? Works with Functions and GeneratorFunctions, despite ES6 @@toStringTag.',
			'',
			'[1]: https://npmjs.org/package/is-callable',
			'[2]: https://versionbadg.es/inspect-js/is-callable.svg',
			'[5]: https://david-dm.org/inspect-js/is-callable.svg',
			'[6]: https://david-dm.org/inspect-js/is-callable',
			'[7]: https://david-dm.org/inspect-js/is-callable/dev-status.svg',
			'[8]: https://david-dm.org/inspect-js/is-callable#info=devDependencies',
			'[11]: https://nodei.co/npm/is-callable.png?downloads=true&stars=true',
			'[license-image]: https://img.shields.io/npm/l/is-callable.svg',
			'[license-url]: LICENSE',
			'[downloads-image]: https://img.shields.io/npm/dm/is-callable.svg',
			'[downloads-url]: https://npm-stat.com/charts.html?package=is-callable',
			'[codecov-image]: https://codecov.io/gh/inspect-js/is-callable/branch/main/graphs/badge.svg',
			'[codecov-url]: https://app.codecov.io/gh/inspect-js/is-callable/',
			'[actions-image]: https://img.shields.io/endpoint?url=https://github-actions-badge-u3jn4tfpocch.runkit.sh/inspect-js/is-callable',
			'[actions-url]: https://github.com/inspect-js/is-callable/actions',
			'[gittip-image]: https://img.shields.io/gittip/ljharb.svg',
			'[gittip-url]: https://www.gittip.com/ljharb/',
		].join('\r\n'),
	},
	{
		name: 'a README with no header at all, just prose and a code block',
		id: { name: 'has-symbols', repository: 'inspect-js/has-symbols', branch: 'main' },
		text: `Determine if the JS environment has Symbol support. Supports spec, or shams.

\`\`\`js
# comment-ish line
[![fake][a]][b]
\`\`\`

See [the spec][spec] for details.

[spec]: https://tc39.es/ecma262/
`,
	},
	{
		name: 'a README whose badges and heading are right but whose definitions are scattered and partly duplicated',
		id: { name: 'qs', repository: 'ljharb/qs', branch: 'main' },
		text: `# qs <sup>[![Version Badge][npm-version-svg]][package-url]</sup>

[![github actions][actions-image]][actions-url]
[![coverage][codecov-image]][codecov-url]
[![License][license-image]][license-url]
[![Downloads][downloads-image]][downloads-url]
[![CII Best Practices](https://bestpractices.coreinfrastructure.org/projects/9058/badge)](https://bestpractices.coreinfrastructure.org/projects/9058)

[![npm badge][npm-badge-png]][package-url]

A querystring parsing and stringifying library with some added security.

[package-url]: https://npmjs.org/package/qs
[npm-version-svg]: https://versionbadg.es/ljharb/qs.svg

## Usage

Some usage.

[npm-badge-png]: https://nodei.co/npm/qs.png?downloads=true&stars=true
[license-image]: https://img.shields.io/npm/l/qs.svg
[license-url]: LICENSE
[package-url]: https://example.com/a-shadowed-duplicate
[downloads-image]: https://img.shields.io/npm/dm/qs.svg
`,
	},
	{
		name: 'a README with a heading but nothing else',
		id: { name: 'side-channel', repository: 'ljharb/side-channel', branch: 'main' },
		text: '# side-channel',
	},
	{
		name: 'a README with blank lines everywhere around the badges',
		id: identity,
		text: `

# foo


[![github actions][actions-image]][actions-url]

[![coverage][codecov-image]][codecov-url]


[![npm badge][npm-badge-png]][package-url]



A description of foo.



`,
	},
];

test('readme: fixing realistic READMEs is idempotent, and leaves no drift', (t) => {
	realistic.forEach(({ name, id, text }) => {
		const once = fixReadme(text, id);
		t.deepEqual(once.skipped, [], `${name}: nothing is skipped`);
		t.deepEqual(drift(once.text, id), [], `${name}: once fixed, there is no drift`);
		t.equal(fixReadme(once.text, id).text, once.text, `${name}: fixing it again changes nothing`);
		t.ok(once.text.startsWith(headingFor(id.name)) || once.text.includes(`\n${headingFor(id.name)}`), `${name}: the fixed README has the heading`);
		definitionLines(id).forEach((line) => {
			t.ok(once.text.includes(line), `${name}: the fixed README has \`${line}\``);
		});
		if (text.includes('\r\n')) {
			t.doesNotMatch(once.text, /(?<!\r)\n/, `${name}: a CRLF README stays CRLF`);
		} else {
			t.doesNotMatch(once.text, /\r/, `${name}: an LF README stays LF`);
		}
		t.doesNotMatch(once.text, /david-dm|travis-ci|testling|gittip/, `${name}: nothing of the obsolete services remains`);

		categories.forEach((c) => {
			const partial = fixReadme(text, id, only(c));
			t.equal(fixReadme(partial.text, id, only(c)).text, partial.text, `${name}: fixing only \`${c}\` twice is the same as once`);
			if (c !== 'links' && partial.skipped.length === 0) {
				// fixing only the links can leave link drift: the definitions only obsolete badges use, which stay until those badges are fixed
				t.notOk(drift(partial.text, id).includes(c), `${name}: fixing only \`${c}\` leaves no \`${c}\` drift`);
			}
		});
	});
	t.end();
});

test('readme: the realistic READMEs’ fixes keep what they should', (t) => {
	const [oldStyle, scopedInline, crlf, prose, scattered] = realistic;

	const oldFixed = fixReadme(oldStyle.text, oldStyle.id).text;
	t.ok(oldFixed.includes('var assign = require(\'object.assign\').getPolyfill();\n// [npm-url]: not a definition\n'), 'the code block is untouched');
	t.ok(oldFixed.includes('## Tests\nSimply clone the repo'), 'the prose is untouched');
	t.equal(definitionCount(oldFixed, 'npm-url'), 0, 'the old `npm-url` definition, used only by the old heading and npm badge, is removed');
	t.equal(definitionCount(oldFixed, 'testling-png'), 0, 'the testling definition is removed');

	const scopedFixed = fixReadme(scopedInline.text, scopedInline.id).text;
	t.ok(scopedFixed.startsWith('<!-- a comment before anything -->\n# @ljharb/through <sup>'), 'the comment before the heading is kept, and the heading fixed');
	t.ok(scopedFixed.includes(`${standardBadges[3]}\n[![CII Best Practices](https://bestpractices.coreinfrastructure.org/projects/1234/badge)](https://bestpractices.coreinfrastructure.org/projects/1234)\n\n${npmBadge}\n`), 'the CII badge is kept, after the standard ones');
	t.doesNotMatch(scopedFixed, /node-pretest\.yml/, 'the inline workflow badge is replaced');

	const crlfFixed = fixReadme(crlf.text, crlf.id).text;
	t.ok(crlfFixed.endsWith('[actions-url]: https://github.com/inspect-js/is-callable/actions\r\n[package-url]: https://npmjs.org/package/is-callable\r\n[npm-version-svg]: https://versionbadg.es/inspect-js/is-callable.svg\r\n[npm-badge-png]: https://nodei.co/npm/is-callable.png?downloads=true&stars=true\r\n'), 'the missing definitions are appended after the last kept one, with CRLF, ending the file with a newline');
	t.ok(crlfFixed.includes('[actions-image]: https://img.shields.io/github/check-suites/inspect-js/is-callable/main\r\n'), 'the old actions-image definition is rewritten in place');

	const proseFixed = fixReadme(prose.text, prose.id).text;
	t.ok(proseFixed.startsWith(`${headingFor('has-symbols')}\n\n${standardBadges[0]}`), 'the heading and badges are inserted at the top');
	t.ok(proseFixed.includes('```js\n# comment-ish line\n[![fake][a]][b]\n```\n'), 'the code block is untouched');
	t.ok(proseFixed.includes('[spec]: https://tc39.es/ecma262/\n[package-url]:'), 'the missing definitions are appended after the existing one');

	const scatteredFixed = fixReadme(scattered.text, scattered.id).text;
	t.deepEqual(drift(scattered.text, scattered.id), ['links'], 'only the links of the scattered README drift');
	t.ok(scatteredFixed.includes('[package-url]: https://example.com/a-shadowed-duplicate'), 'the shadowed duplicate, which has no effect, is left alone');
	t.ok(scatteredFixed.includes('[downloads-image]: https://img.shields.io/npm/dm/qs.svg\n[downloads-url]: https://npm-stat.com/charts.html?package=qs\n'), 'the missing definitions follow the last one');
	t.end();
});

test('readme: fixing every fixture is idempotent', (t) => {
	t.ok(fixtures.size > 30, 'there are many fixtures');
	fixtures.forEach(({ text, id }, name) => {
		const once = fixReadme(text, id);
		t.equal(fixReadme(once.text, id).text, once.text, `${name}: fixing the fixed README changes nothing`);
		t.deepEqual(drift(once.text, id), [], `${name}: the fixed README has no drift`);
		categories.forEach((c) => {
			const partial = fixReadme(text, id, only(c)).text;
			t.equal(fixReadme(partial, id, only(c)).text, partial, `${name}: fixing only \`${c}\` is idempotent`);
		});
	});
	t.end();
});
