// what a package's README should start with, and how a README differs from that: its heading, the badges under it, and the link reference definitions those use. Pure, so that checking a README and fixing it (in a clone) agree exactly.

/** @typedef {'heading' | 'badges' | 'links'} Category */
/** @typedef {{ name: string, repository: string, branch: string }} Identity */
/** @typedef {{ why: string }} Skip */
/** @typedef {{ text: string, skipped: Skip[] }} Fixed */
/**
 * What kind of badge one is, from the URL of its image:
 * - `version`, `ci`, `coverage`, `license`, `downloads`, `npm`: one of the standard badges (`version` belongs in the heading, not under it)
 * - `obsolete`: a service that's gone (eg, david-dm, testling, gittip), whose badge is only ever removed
 * - `extra`: anything else, which is kept, after the standard badges
 * @typedef {'version' | 'ci' | 'coverage' | 'license' | 'downloads' | 'npm' | 'obsolete' | 'extra'} Kind
 */

/** @type {readonly Category[]} */
export const categories = Object.freeze([
	'heading', 'badges', 'links',
]);

/** @type {(word: string) => word is Category} */
export function isCategory(word) {
	return categories.some((c) => c === word);
}

export const readmePath = 'README.md';

/**
 * The link reference definitions a README's heading and badges use, in the order they're added when missing.
 * @type {(identity: Identity) => [label: string, url: string][]}
 */
export function definitions({
	name,
	repository,
	branch,
}) {
	return [
		['package-url', `https://npmjs.org/package/${name}`],
		['npm-version-svg', `https://versionbadg.es/${repository}.svg`],
		['npm-badge-png', `https://nodei.co/npm/${name}.png?downloads=true&stars=true`],
		['license-image', `https://img.shields.io/npm/l/${name}.svg`],
		['license-url', 'LICENSE'],
		['downloads-image', `https://img.shields.io/npm/dm/${name}.svg`],
		['downloads-url', `https://npm-stat.com/charts.html?package=${name}`],
		['codecov-image', `https://codecov.io/gh/${repository}/branch/${branch}/graphs/badge.svg`],
		['codecov-url', `https://app.codecov.io/gh/${repository}/`],
		['actions-image', `https://img.shields.io/github/check-suites/${repository}/${branch}`],
		['actions-url', `https://github.com/${repository}/actions`],
	];
}

/** @type {(name: string) => string} */
export function headingFor(name) {
	return `# ${name} <sup>[![Version Badge][npm-version-svg]][package-url]</sup>`;
}

// the standard badges under the heading, in order; extra badges follow them, then a blank line, then `npmBadge`
export const standardBadges = Object.freeze([
	'[![github actions][actions-image]][actions-url]',
	'[![coverage][codecov-image]][codecov-url]',
	'[![License][license-image]][license-url]',
	'[![Downloads][downloads-image]][downloads-url]',
]);

export const npmBadge = '[![npm badge][npm-badge-png]][package-url]';

// a reference (`[label]`) or an inline destination (`(url)`)
const target = String.raw`(?:\[[^\]\n]*\]|\([^)\n]*\))`;
// an image's reference may be a shortcut one (`![alt]`), with no target of its own
const badgePattern = new RegExp(String.raw`\[!\[[^\]\n]*\]${target}?\]${target}`, 'g');
const badgeLine = new RegExp(String.raw`^\s*(?:\[!\[[^\]\n]*\]${target}?\]${target}\s*)+$`);
const definitionPattern = /^ {0,3}\[(?<label>[^\]\n]+)\]:[ \t]*(?<url>\S*)(?<rest>.*)$/;
// a definition's title, on the line after it
const titlePattern = /^[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/;
// as CommonMark has it, a backtick fence's info string can't have a backtick (that line is an inline code span instead)
const fencePattern = /^ {0,3}(?<fence>`{3,}(?=[^`]*$)|~{3,})/;
// a level-one ATX heading; GitHub needs a space after the `#`, but a README's title written without one (`#name`, or `#@scope/name`) is still meant as its heading
const atxTitle = /^ {0,3}#(?:[ \t]|(?=[A-Za-z@]))/;
const setextUnderline = /^ {0,3}=+[ \t]*$/;
const htmlStart = /^ {0,3}</;
const bom = '\uFEFF';

/** @type {(label: string) => string} */
function normalizeLabel(label) {
	return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** @type {(s: string) => string} */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which lines are inside a fenced code block (fences included), where nothing is a heading, a badge, or a definition; and where the one that's never closed (which runs to the end) starts, or `-1`.
 * @type {(lines: string[]) => { inFence: boolean[], unclosed: number }}
 */
function fenced(lines) {
	/** @type {{ fence: string, at: number } | null} */
	let open = null;
	const inFence = lines.map((line, at) => {
		const match = fencePattern.exec(line)?.groups?.fence;
		if (open === null) {
			if (match) {
				open = { fence: match, at };
				return true;
			}
			return false;
		}
		if (match && match[0] === open.fence[0] && match.length >= open.fence.length && line.trim() === match) {
			open = null;
		}
		return true;
	});
	const left = /** @type {{ fence: string, at: number } | null} */ (open); // eslint-disable-line no-extra-parens
	return { inFence, unclosed: left ? left.at : -1 };
}

/**
 * Where the README's title is: the first line of its content, past blank lines and any HTML blocks before it (eg, a banner image), when that's a level-one heading, ATX (one line) or setext (two); otherwise there's none (`-1`), rather than taking a heading further down, which is a section's.
 * @type {(lines: string[], inFence: boolean[]) => { heading: number, headingEnd: number }}
 */
function findTitle(lines, inFence) {
	// an HTML comment ends with its `-->`; any other HTML block, with a blank line
	/** @type {'comment' | 'html' | null} */
	let inHtml = null;
	const first = lines.findIndex((line) => {
		if (inHtml === 'comment') {
			inHtml = line.includes('-->') ? null : inHtml;
			return false;
		}
		if (line.trim() === '') {
			inHtml = null;
			return false;
		}
		if (inHtml === null && htmlStart.test(line)) {
			const comment = (/^ {0,3}<!--/).test(line);
			inHtml = comment ? 'comment' : 'html';
			if (comment && line.includes('-->', line.indexOf('<!--') + 4)) {
				inHtml = null;
			}
			return false;
		}
		return inHtml === null;
	});
	if (first < 0 || inFence[first]) {
		return { heading: -1, headingEnd: -1 };
	}
	if (atxTitle.test(lines[first])) {
		return { heading: first, headingEnd: first };
	}
	if (first + 1 < lines.length && !badgeLine.test(lines[first]) && setextUnderline.test(lines[first + 1])) {
		return { heading: first, headingEnd: first + 1 };
	}
	return { heading: -1, headingEnd: -1 };
}

/**
 * The index just past the badges under the heading, which ends at `headingEnd`: the lines right after it that are blank, or only badges, up to (not including) the blank lines before whatever comes next.
 * @type {(lines: string[], inFence: boolean[], headingEnd: number) => number}
 */
function blockEndAfter(lines, inFence, headingEnd) {
	const after = lines.slice(headingEnd + 1);
	const stop = after.findIndex((line, i) => inFence[headingEnd + 1 + i] || (line.trim() !== '' && !badgeLine.test(line)));
	const block = stop < 0 ? after : after.slice(0, stop);
	const lastBadge = block.findLastIndex((line) => badgeLine.test(line));
	return headingEnd + 2 + lastBadge;
}

/** @typedef {{ index: number, label: string, url: string, rest: string }} Definition */

/**
 * The README, as lines, with what this module reads of it. `definitionLines` are every definition's line, with its label; `titled` are the definitions whose title is on the next line, which is part of them.
 * @typedef {{
 *   lines: string[],
 *   eol: string,
 *   bom: boolean,
 *   finalNewline: boolean,
 *   inFence: boolean[],
 *   unclosed: number,
 *   heading: number,
 *   headingEnd: number,
 *   blockEnd: number,
 *   definitions: Map<string, Definition>,
 *   definitionLines: Map<number, string>,
 *   titled: Set<number>,
 * }} Parsed
 */

/** @type {(text: string) => Parsed} */
function parse(text) {
	const hasBOM = text.startsWith(bom);
	const body = hasBOM ? text.slice(bom.length) : text;
	// a file whose every line ends with `\r\n` keeps them; any other is written with `\n`s
	const eol = (/\r\n/).test(body) && !(/(?<!\r)\n/).test(body) ? '\r\n' : '\n';
	const finalNewline = body.endsWith('\n');
	const lines = body.split(/\r?\n/);
	if (finalNewline) {
		lines.pop();
	}
	const { inFence, unclosed } = fenced(lines);
	const { heading, headingEnd } = findTitle(lines, inFence);
	/** @type {Map<string, Definition>} */
	const defs = new Map();
	/** @type {Map<number, string>} */
	const definitionLines = new Map();
	/** @type {Set<number>} */
	const titled = new Set();
	lines.forEach((line, index) => {
		const groups = inFence[index] || titled.has(index - 1) ? null : definitionPattern.exec(line)?.groups;
		if (groups) {
			const label = normalizeLabel(groups.label);
			definitionLines.set(index, label);
			if (groups.rest.trim() === '' && index + 1 < lines.length && !inFence[index + 1] && titlePattern.test(lines[index + 1])) {
				titled.add(index);
			}
			// as Markdown does, the first definition of a label is the one that counts
			if (!defs.has(label)) {
				defs.set(label, {
					index,
					label,
					url: groups.url.replace(/^<(?<url>.*)>$/, '$<url>'),
					rest: groups.rest,
				});
			}
		}
	});
	return {
		lines,
		eol,
		bom: hasBOM,
		finalNewline,
		inFence,
		unclosed,
		heading,
		headingEnd,
		blockEnd: heading < 0 ? -1 : blockEndAfter(lines, inFence, headingEnd),
		definitions: defs,
		definitionLines,
		titled,
	};
}

/** @type {(url: string) => Kind} */
export function kindOf(url) {
	if ((/^https?:\/\/(?:www\.)?(?:versionbadg\.es|badge\.fury\.io)\//i).test(url)) {
		return 'version';
	}
	if ((/^https?:\/\/(?:img\.shields\.io\/github\/(?:check-runs|check-suites|actions|workflow)\/|(?:api\.)?travis-ci\.(?:org|com)\/|github\.com\/[^/]+\/[^/]+\/(?:actions\/)?workflows\/[^?#]*badge\.svg)/i).test(url)) {
		return 'ci';
	}
	if ((/^https?:\/\/(?:[\w-]+\.)?(?:codecov\.io|coveralls\.io)\//i).test(url)) {
		return 'coverage';
	}
	if ((/^https?:\/\/(?:(?:[\w-]+\.)?(?:david-dm\.org|testling\.com|gittip\.com|gratipay\.com)\/|img\.shields\.io\/(?:gittip|gratipay)\/)/i).test(url)) {
		return 'obsolete';
	}
	if ((/^https?:\/\/img\.shields\.io\/npm\/l\//i).test(url)) {
		return 'license';
	}
	if ((/^https?:\/\/img\.shields\.io\/npm\/d[mtwy]\//i).test(url)) {
		return 'downloads';
	}
	if ((/^https?:\/\/(?:www\.)?nodei\.co\/npm\//i).test(url)) {
		return 'npm';
	}
	return 'extra';
}

/**
 * Whether `url` is one a badge (of any kind but `extra`), or where one links to (eg, a package's page on npm), would have: an unused definition of one is a badge's leftover, which fixing the links removes.
 * @type {(url: string) => boolean}
 */
function isBadgeURL(url) {
	return kindOf(url) !== 'extra' || (/^https?:\/\/(?:www\.)?(?:npmjs\.(?:org|com)\/package\/|npm-stat\.com\/|app\.codecov\.io\/|github\.com\/[^/]+\/[^/]+\/actions\/?$)/i).test(url);
}

// what a badge whose image has no URL (its reference has no definition) is, by its image's reference label, as these READMEs have long named them
/** @type {ReadonlyMap<string, Kind>} */
const labelKinds = new Map([
	['npm-version-svg', 'version'],
	['npm-version-png', 'version'],
	['actions-image', 'ci'],
	['travis-svg', 'ci'],
	['travis-image', 'ci'],
	['codecov-image', 'coverage'],
	['coveralls-image', 'coverage'],
	['deps-svg', 'obsolete'],
	['dev-deps-svg', 'obsolete'],
	['david-image', 'obsolete'],
	['testling-png', 'obsolete'],
	['gittip-image', 'obsolete'],
	['license-image', 'license'],
	['downloads-image', 'downloads'],
	['npm-badge-png', 'npm'],
]);

const standardKinds = new Map([...standardBadges, npmBadge].map((badge, i) => [
	badge, /** @type {Kind[]} */ ([
		'ci', 'coverage', 'license', 'downloads', 'npm',
	])[i],
]));

/**
 * A badge's two parts: its image's alt text and reference (or inline destination), and its link's reference (or destination).
 * @type {(badge: string) => { alt: string, image: string, link: string }}
 */
function badgeParts(badge) {
	// `badge` is always what `badgePattern` matched, so this, the same pattern anchored, always matches it
	const [
		[
			,
			alt,
			image = '',
			link,
		],
	] = badge.matchAll(/^\[!\[(?<alt>[^\]\n]*)\](?<image>\[[^\]\n]*\]|\([^)\n]*\))?\](?<link>\[[^\]\n]*\]|\([^)\n]*\))$/g);
	return {
		alt, image, link,
	};
}

/**
 * What kind of badge `badge` is (see `Kind`): a standard one, written exactly as it should be, is that, whatever its definitions are; any other, by the URL of its image (its inline destination, or its reference's definition, where a collapsed or shortcut reference's label is its alt text), or, when that has none, by its reference's label (see `labelKinds`).
 * @type {(badge: string, defs: Map<string, Definition>) => Kind}
 */
function badgeKind(badge, defs) {
	const standard = standardKinds.get(badge);
	if (standard) {
		return standard;
	}
	const { alt, image } = badgeParts(badge);
	if (image.startsWith('(')) {
		return kindOf(image.slice(1, -1).trim().split(/\s+/)[0].replace(/^<(?<url>.*)>$/, '$<url>'));
	}
	const label = normalizeLabel(image.slice(1, -1) || alt);
	const url = defs.get(label)?.url;
	return url ? kindOf(url) : labelKinds.get(label) ?? 'extra';
}

/**
 * Of `lines`, each one's extra badges (see `Kind`), in order, as they're written: with `whole`, a line of nothing but extra badges is kept as it is.
 * @type {(lines: string[], defs: Map<string, Definition>, whole: boolean) => string[]}
 */
function extrasIn(lines, defs, whole) {
	return lines.flatMap((line) => {
		const badges = line.match(badgePattern) ?? [];
		const kept = badges.filter((badge) => badgeKind(badge, defs) === 'extra');
		if (kept.length === 0) {
			return [];
		}
		return whole && kept.length === badges.length ? [line.trim()] : [kept.join(' ')];
	});
}

/**
 * The badge lines to keep under the heading besides the standard ones (see `extrasIn`). Those on the title's own line are only moved under it when the heading is fixed (see `withHeading`), so that fixing only the badges never copies them.
 * @type {(parsed: Parsed) => string[]}
 */
function extras({
	lines,
	headingEnd,
	blockEnd,
	definitions: defs,
}) {
	return extrasIn(lines.slice(headingEnd + 1, blockEnd), defs, true);
}

/** @type {(parsed: Parsed) => string[]} */
function expectedBlock(parsed) {
	return [
		'',
		...standardBadges,
		...extras(parsed),
		'',
		npmBadge,
	];
}

/** @type {(a: string[], b: string[]) => boolean} */
function sameLines(a, b) {
	return a.length === b.length && a.every((line, i) => line.trimEnd() === b[i]);
}

/**
 * Whether `label` is referenced anywhere in `lines` but definitions (and fenced code): as `[label]`, which a full, collapsed, or shortcut reference all have. Matching text that isn't a reference only ever keeps a definition.
 * @type {(lines: string[], skip: (index: number) => boolean, label: string) => boolean}
 */
function referenced(lines, skip, label) {
	const pattern = new RegExp(String.raw`\[\s*${escapeRegExp(label).replace(/ /g, String.raw`\s+`)}\s*\]`, 'i');
	return lines.some((line, i) => !skip(i) && pattern.test(line));
}

/**
 * The labels of the definitions the heading and the badges under it use, as `parsed` has them: the ones that fixing them can leave unused. A collapsed or shortcut reference's label is its text (for an image, its alt text).
 * @type {(parsed: Parsed) => Set<string>}
 */
function headerLabels({
	lines,
	heading,
	blockEnd,
}) {
	if (heading < 0) {
		return new Set();
	}
	return new Set(lines.slice(heading, blockEnd).flatMap((line) => Array.from(line.matchAll(/\]\[(?<label>[^\]\n]*)\]/g), ([, label]) => label).concat((line.match(badgePattern) ?? []).flatMap((badge) => {
		const { alt, image } = badgeParts(badge);
		return image === '[]' || image === '' ? [alt] : [];
	}))).map(normalizeLabel).filter(Boolean));
}

/**
 * Of `parsed`, the definitions that are wrong (`replace`: a line to rewrite), missing (`add`), and the lines of those nothing uses any more that the original heading and badges used, or that are a badge's (see `isBadgeURL`) (`remove`), against `identity`'s.
 * @type {(parsed: Parsed, identity: Identity, used: Set<string>) => { replace: Map<number, string>, add: string[], remove: Set<number> }}
 */
function definitionChanges(parsed, identity, used) {
	/** @type {Map<number, string>} */
	const replace = new Map();
	/** @type {string[]} */
	const add = [];
	/** @type {Set<number>} */
	const remove = new Set();
	const wanted = definitions(identity);
	wanted.forEach(([label, url]) => {
		const line = `[${label}]: ${url}`;
		const found = parsed.definitions.get(label);
		if (!found) {
			add.push(line);
		} else if (parsed.lines[found.index].trimEnd() !== line) {
			replace.set(found.index, line);
		}
		// its title, on the next line, is part of what's replaced
		if (found && parsed.titled.has(found.index)) {
			remove.add(found.index + 1);
		}
	});
	const kept = new Set(wanted.map(([label]) => label));
	/** @type {(i: number) => boolean} */
	const skip = (i) => parsed.definitionLines.has(i) || parsed.titled.has(i - 1) || parsed.inFence[i];
	const unused = new Set(Array.from(parsed.definitions.values()).filter((d) => isBadgeURL(d.url)).map((d) => d.label).concat(Array.from(used)));
	unused.forEach((label) => {
		if (parsed.definitions.has(label) && !kept.has(label) && !referenced(parsed.lines, skip, label)) {
			// every definition of it, not just the first, with its title
			parsed.definitionLines.forEach((defined, i) => {
				if (defined === label) {
					remove.add(i);
					if (parsed.titled.has(i)) {
						remove.add(i + 1);
					}
				}
			});
		}
	});
	return {
		replace,
		add,
		remove,
	};
}

/** @type {(parsed: Pick<Parsed, 'lines' | 'eol' | 'bom' | 'finalNewline'>) => string} */
function serialize({
	lines,
	eol,
	bom: hasBOM,
	finalNewline,
}) {
	return `${hasBOM ? bom : ''}${lines.join(eol)}${finalNewline ? eol : ''}`;
}

/**
 * `parsed`, with its title replaced by the expected heading (or, when it has none, with that heading first); extra badges on the title's own line are kept, on a line of their own after it, for the badges to keep.
 * @type {(parsed: Parsed, identity: Identity) => Parsed}
 */
function withHeading(parsed, identity) {
	const heading = headingFor(identity.name);
	const lines = parsed.lines.slice();
	if (parsed.heading < 0) {
		// a title goes first, even before anything else at the top (eg, a banner image): there's no telling what that is
		lines.unshift(heading, ...lines.length > 0 && lines[0].trim() !== '' ? [''] : []);
	} else {
		const kept = extrasIn(lines.slice(parsed.heading, parsed.headingEnd + 1), parsed.definitions, false);
		lines.splice(parsed.heading, parsed.headingEnd - parsed.heading + 1, heading, ...kept.length > 0 ? ['', ...kept] : []);
	}
	return parse(serialize({ ...parsed, lines }));
}

/**
 * Whether what comes after the badges under the heading starts right after them, with no blank line between: Markdown then renders it as part of their paragraph.
 * @type {(parsed: Pick<Parsed, 'lines' | 'blockEnd'>) => boolean}
 */
function runsOn({ lines, blockEnd }) {
	return blockEnd < lines.length && lines[blockEnd].trim() !== '';
}

/** @type {(parsed: Parsed) => Parsed} */
function withBadges(parsed) {
	const lines = parsed.lines.slice();
	const after = lines.slice(parsed.blockEnd);
	lines.splice(parsed.headingEnd + 1, lines.length, ...expectedBlock(parsed), ...runsOn(parsed) ? [''] : [], ...after);
	return parse(serialize({ ...parsed, lines }));
}

/** @type {(lines: string[]) => void} */
function trimEnd(lines) {
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
		lines.pop();
	}
}

/**
 * `parsed`, with its definitions fixed (see `definitionChanges`): a missing one is added after the last one that's kept (and its title); or, when there's none, at the end, after a blank line, but before a fenced code block that's never closed, which would otherwise hide it.
 * @type {(parsed: Parsed, identity: Identity, used: Set<string>) => Parsed}
 */
function withLinks(parsed, identity, used) {
	const {
		replace,
		add,
		remove,
	} = definitionChanges(parsed, identity, used);
	const last = Math.max(-1, ...Array.from(parsed.definitionLines.keys()).filter((i) => !remove.has(i)));
	const insertAfter = parsed.titled.has(last) ? last + 1 : last;
	/** @type {string[]} */
	const lines = [];
	/** @type {() => void} */
	const append = () => {
		trimEnd(lines);
		lines.push(...lines.length > 0 ? [''] : [], ...add);
	};
	parsed.lines.forEach((line, i) => {
		if (add.length > 0 && last < 0 && i === parsed.unclosed) {
			append();
			lines.push('');
		}
		if (!remove.has(i)) {
			lines.push(replace.get(i) ?? line);
		}
		if (add.length > 0 && i === insertAfter) {
			lines.push(...add);
		}
	});
	if (add.length > 0 && last < 0 && parsed.unclosed < 0) {
		append();
	}
	return {
		...parsed,
		lines,
		finalNewline: parsed.finalNewline || add.length > 0,
	};
}

/**
 * `text`, with what's in `only` (every category, when it's unspecified) made to match `identity`'s, and what couldn't be (`skipped`).
 * Each step works on what the one before it left: so the definitions that the heading and badges used before (and that nothing uses after) are removed only when those were fixed too; but a badge's leftover definition nothing uses is removed whenever the links are fixed.
 * @type {(text: string, identity: Identity, only?: Set<Category>) => Fixed}
 */
export function fixReadme(text, identity, only) {
	/** @type {(category: Category) => boolean} */
	const wants = (category) => !only || only.size === 0 || only.has(category);
	/** @type {Skip[]} */
	const skipped = [];
	const original = parse(text);
	let parsed = wants('heading') ? withHeading(original, identity) : original;
	if (wants('badges')) {
		if (parsed.heading < 0) {
			skipped.push({ why: 'there’s no heading to put the badges under' });
		} else {
			parsed = withBadges(parsed);
		}
	}
	if (wants('links')) {
		parsed = withLinks(parsed, identity, headerLabels(original));
	}
	return { text: serialize(parsed), skipped };
}

/**
 * Which of a README's heading, badges, and links differ from `identity`'s (see `fixReadme`), in `categories`' order.
 * @type {(text: string, identity: Identity) => Category[]}
 */
export function drift(text, identity) {
	const parsed = parse(text);
	/** @type {Category[]} */
	const found = [];
	if (parsed.heading < 0 || parsed.headingEnd !== parsed.heading || parsed.lines[parsed.heading].trimEnd() !== headingFor(identity.name)) {
		found.push('heading');
	}
	if (parsed.heading < 0 || !sameLines(parsed.lines.slice(parsed.headingEnd + 1, parsed.blockEnd), expectedBlock(parsed)) || runsOn(parsed)) {
		found.push('badges');
	}
	// the definitions the heading and badges use only once those are fixed, which is when what they no longer use can be told
	const settled = parse(fixReadme(text, identity, new Set(['heading', 'badges'])).text);
	const {
		replace,
		add,
		remove,
	} = definitionChanges(settled, identity, headerLabels(parsed));
	if (replace.size + add.length + remove.size > 0) {
		found.push('links');
	}
	return found;
}
