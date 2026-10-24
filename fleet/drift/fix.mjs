import semver from 'semver';

import { allVersions } from '../../node/matrix/versions.mjs';
import {
	guessValues,
	loadTemplate,
	nodeEngines,
	nodeType,
	normalize,
	placeholders,
	render,
	templateFor,
} from './check.mjs';
import { expectedShards, shardDecade } from './shards.mjs';

/** @typedef {import('../lib/app.mjs').RepoState} RepoState */
/** @typedef {import('./check.mjs').Result} Result */
/** @typedef {'missing' | 'drifted' | 'unexpected'} Category */
/** @typedef {{ path: string, content: string, reason: Category | 'range' }} Write */
/** @typedef {{ path: string, reason: 'unexpected' }} Delete */
/** @typedef {{ path: string, why: string }} Skip */
/** @typedef {{ writes: Write[], deletes: Delete[], skipped: Skip[] }} Plan */
/** @typedef {{ files?: Set<string>, categories?: Set<Category> }} Filters */
/**
 * @typedef {{
 *   files: Map<string, string | null>,
 *   defaults: (name: string) => Promise<Record<string, string> | string>,
 *   plan: Plan,
 *   ignored: Set<string>,
 * }} Context
 */
// `own` is whether `range` and `label` are the current file's
/** @typedef {{ name: string } & ({ template: string, values: Record<string, string>, own: boolean } | { why: string })} Resolved */

const workflowsDir = '.github/workflows';

/** @type {(name: string) => string} */
function workflowPath(name) {
	return `${workflowsDir}/${name}`;
}

/** @type {(a: { path: string }, b: { path: string }) => number} */
function byPath(a, b) {
	return a.path < b.path ? -1 : Number(a.path > b.path);
}

/** @type {(lower: number, upper: number | null) => { range: string, label: string }} */
function bounds(lower, upper) {
	if (upper === null) {
		return { range: `>= ${lower}`, label: `>= ${lower}` };
	}
	return lower > 0
		? { range: `>= ${lower} < ${upper}`, label: `${lower} - ${upper}` }
		: { range: `< ${upper}`, label: `< ${upper}` };
}

// a node test file written from scratch gets the values implied by its place among the files `engines.node` needs; when there are none to derive, the reason why
/** @type {(packageJson: string | null, files: Context['files']) => Context['defaults']} */
function nodeDefaults(packageJson, files) {
	const { range: engines } = nodeEngines(packageJson);
	const type = nodeType(files);
	return async (name) => {
		if (!engines) {
			return 'there is no valid `engines.node` in `package.json` to derive its node version range from';
		}
		// the same arguments `checkRepo` used, so this is its cached result, and the released versions are already fetched
		const expected = await expectedShards(engines, type);
		const index = expected.indexOf(name);
		if (index < 0) {
			return `\`engines.node\` (\`${engines}\`) doesn’t need it, so its node version range is unknown`;
		}
		const common = {
			type,
			command: 'npm run tests-only',
		};
		const decade = shardDecade(name);
		if (decade === null) {
			return {
				...common, range: engines, label: engines,
			};
		}
		let lower = decade * 10;
		// the first file starts where `engines.node` does, when that's later than its decade does
		if (index === 0) {
			const majors = (await allVersions()).filter((v) => semver.satisfies(v, engines)).map((v) => semver.major(v));
			lower = Math.max(lower, Math.min(...majors));
		}
		return { ...common, ...bounds(lower, index === expected.length - 1 ? null : (decade + 1) * 10) };
	};
}

// the template for `name`, with the values recovered from its current file (if `recovered`), and defaults for any it lacks
/** @type {(context: Context, name: string, recovered: boolean) => Promise<Resolved>} */
async function resolve({ files, defaults }, name, recovered) {
	const template = loadTemplate(/** @type {string} */ (templateFor(name))); // eslint-disable-line no-extra-parens
	const guessed = recovered ? guessValues(template, normalize(/** @type {string} */ (files.get(name)))) : {}; // eslint-disable-line no-extra-parens
	// a blank value is no value: a blank `range` would be closed to `< N`, which tests every version below N
	const values = Object.fromEntries(Object.entries(guessed).filter(([, v]) => v.trim()));
	const unknown = placeholders(template).filter((p) => !Object.hasOwn(values, p));
	if (unknown.length === 0) {
		return {
			name, template, values, own: true,
		};
	}
	// only the node template has placeholders, so only a node test file gets here
	const fallback = await defaults(name);
	if (typeof fallback === 'string') {
		return { name, why: recovered ? `${unknown.map((p) => `\`{{${p}}}\``).join(', ')} could not be recovered from the current file, and ${fallback}` : fallback };
	}
	// a label describes its range, so when either is unknown, both are the defaults, rather than a pair that disagree
	const own = !['range', 'label'].some((p) => unknown.includes(p));
	return {
		name,
		template,
		values: own ? { ...fallback, ...values } : {
			...fallback, ...values, range: fallback.range, label: fallback.label,
		},
		own,
	};
}

/** @type {(plan: Plan, resolved: Resolved, reason: Write['reason']) => void} */
function add(plan, resolved, reason) {
	const path = workflowPath(resolved.name);
	if ('why' in resolved) {
		plan.skipped.push({ path, why: resolved.why });
	} else {
		plan.writes.push({
			path, content: render(resolved.template, resolved.values), reason,
		});
	}
}

/** @type {(range: string) => boolean} */
function isOpenEnded(range) {
	return new semver.Range(range).set.some((set) => !set.some((c) => c.operator.startsWith('<')));
}

// only the open-ended alternatives of a `||` range are closed, so that `^8 || >= 10` becomes `^8 || >= 10 < 20`
/** @type {(range: string, upper: number) => string} */
function closeRange(range, upper) {
	return range.split('||').map((part) => part.trim()).map((part) => (isOpenEnded(part) ? `${part} < ${upper}` : part)).join(' || ');
}

/** @type {(label: string, upper: number) => string} */
function closeLabel(label, upper) {
	const from = label.match(/^>=\s*(?<from>\S+)$/)?.groups?.from;
	return from ? `${from} - ${upper}` : `${label} < ${upper}`;
}

/**
 * An added shard's open-ended predecessor would overlap it, and stay over GitHub's matrix limit, so it's closed where the added one starts.
 * Returns the predecessors it planned (or skipped), so they aren't also rewritten as drifted.
 * @type {(context: Context, present: string[], added: Set<string>) => Promise<Set<string>>}
 */
async function closeRanges(context, present, added) {
	const shards = [...new Set([...present, ...added])]
		.flatMap((name) => {
			const decade = shardDecade(name);
			return decade === null ? [] : [{ name, decade }];
		})
		.sort((a, b) => a.decade - b.decade);
	/** @type {Set<string>} */
	const handled = new Set();
	for (const [i, { name }] of shards.entries()) {
		const next = shards[i + 1];
		if (!added.has(name) && next && added.has(next.name)) {
			const unknown = `so whether it overlaps the added \`${next.name}\` is unknown`;
			/** @type {Resolved} */
			let resolved;
			if (context.ignored.has(name)) {
				resolved = { name, why: `it’s ignored by \`ljharb-actions.json\`, so it’s left as it is, though it may overlap the added \`${next.name}\`` };
			} else if (typeof context.files.get(name) === 'string') {
				resolved = await resolve(context, name, true); // eslint-disable-line no-await-in-loop
			} else {
				resolved = { name, why: `it could not be read, ${unknown}` };
			}
			// a file whose own range is unknown gets the one its place among the expected files implies, which ends where the added one starts
			if ('why' in resolved || !resolved.own) {
				add(context.plan, resolved, 'range');
				handled.add(name);
			} else if (!semver.validRange(resolved.values.range)) {
				add(context.plan, { name, why: `its range, \`${resolved.values.range}\`, is not a valid semver range, ${unknown}` }, 'range');
				handled.add(name);
			} else if (isOpenEnded(resolved.values.range)) {
				const upper = next.decade * 10;
				add(context.plan, {
					name,
					template: resolved.template,
					values: {
						...resolved.values,
						range: closeRange(resolved.values.range, upper),
						label: closeLabel(resolved.values.label, upper),
					},
					own: true,
				}, 'range');
				handled.add(name);
			}
		}
	}
	return handled;
}

/**
 * The changes that would make one repository's workflow files match the templates, limited to `filters.files` (workflow file names) and `filters.categories`; an empty or absent filter limits nothing.
 * A range rewrite goes with the added shard that needs it, so it's limited only by what limits that shard.
 * Only the templates are read: the released node versions are the ones `checkRepo(state)` already fetched.
 * @type {(state: RepoState, result: Result | null, filters?: Filters) => Promise<Plan>}
 */
export async function planFixes(state, result, { files: names, categories } = {}) {
	/** @type {Plan} */
	const plan = {
		writes: [], deletes: [], skipped: [],
	};
	if (!result) {
		return plan;
	}
	/** @type {(category: Category) => (name: string) => boolean} */
	const wanted = (category) => (name) => (!names?.size || names.has(name)) && (!categories?.size || categories.has(category));
	const files = new Map((state.workflows ?? []).map((f) => [f.name, f.text]));
	/** @type {Context} */
	const context = {
		files,
		defaults: nodeDefaults(state.packageJson, files),
		plan,
		ignored: new Set(Object.entries(state.config.workflows || {}).filter(([, v]) => !v).map(([k]) => k)),
	};

	for (const name of result.unexpected.filter(wanted('unexpected'))) {
		plan.deletes.push({ path: workflowPath(name), reason: 'unexpected' });
	}

	/** @type {Set<string>} */
	const added = new Set();
	for (const name of result.missing.filter(wanted('missing'))) {
		const resolved = templateFor(name)
			? await resolve(context, name, false) // eslint-disable-line no-await-in-loop
			: { name, why: 'there is no template for it' };
		add(plan, resolved, 'missing');
		if (!('why' in resolved)) {
			added.add(name);
		}
	}

	// an unexpected file is never a predecessor, even when the filters keep it from being deleted
	const handled = await closeRanges(context, [...files.keys()].filter((name) => !result.unexpected.includes(name)), added);

	for (const { name } of result.drifted.filter((d) => wanted('drifted')(d.name) && !handled.has(d.name))) {
		add(plan, await resolve(context, name, true), 'drifted'); // eslint-disable-line no-await-in-loop
	}

	plan.writes.sort(byPath);
	plan.deletes.sort(byPath);
	plan.skipped.sort(byPath);
	return plan;
}
