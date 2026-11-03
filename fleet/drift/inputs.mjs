import { readFileSync } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import { isMap, parseDocument } from 'yaml';

import {
	endingsOf,
	indentOf,
	isBlank,
	isString,
	read,
} from './calls.mjs';

/**
 * The inputs a repository's workflow file passes (in a job's `with:`) to a reusable workflow of this repo's (see `./calls.mjs` for how they're read), and what this repo's reusable workflows declare.
 * Each call is a job's, and jobs are unique in a workflow file, so what one passes is matched by its job: a file that calls the same reusable workflow from several jobs has each call's inputs kept apart.
 * A call in one file is the call in another of the job with the same id that calls the same reusable workflow; failing that (eg, a job that's been renamed), the one other call of that workflow, when each file has exactly one such call left. Any other is ambiguous, and what it passes is never moved to a call that might not be its counterpart.
 */

/** @typedef {import('./calls.mjs').Call} Call */
/** @typedef {import('./calls.mjs').Parsed} Parsed */
/** @typedef {Map<string, { file: string, inputs: Map<string, string[]> }>} Inputs */
/** @typedef {{ moved: Inputs, ambiguous: Inputs }} Moved */

const workflowsDir = path.join(import.meta.dirname, '..', '..', '.github', 'workflows');

/** @type {Map<string, Set<string>>} */
const declared = new Map();

/**
 * The inputs this repo's reusable workflow `file` declares under `on.workflow_call.inputs`: none, if there's no such workflow.
 * @type {(file: string) => Set<string>}
 */
export function declaredInputs(file) {
	let inputs = declared.get(file);
	if (!inputs) {
		let text = '';
		try {
			text = readFileSync(path.join(workflowsDir, path.basename(file)), 'utf8');
		} catch {}
		const found = parseDocument(text).getIn([
			'on', 'workflow_call', 'inputs',
		], true);
		inputs = new Set(isMap(found) ? found.items.map(({ key }) => key).filter(isString).map(({ value }) => value) : []);
		declared.set(file, inputs);
	}
	return inputs;
}

/**
 * `actual`, without the inputs it passes to this repo's reusable workflows that they declare, but that `template` doesn't pass them, and whose values are scalars (or empty): those are a repository's own choices (eg, `skip-engines: true`), not drift. Any other input still is (one whose value is a mapping or a sequence, too).
 * Comments are a repository's own too: each such input goes with its comments (trailing, or on lines of their own), and any other comment on a line of its own in a `with:` goes as well.
 * A `with:` left with nothing in it goes too (one with only comments in it, too); an empty one stays, since nothing was removed from it.
 * When what's left isn't YAML that's understood (eg, an alias of an anchor in an input that went), nothing goes.
 * @type {(actual: string, template: string) => string}
 */
export function stripKnownInputs(actual, template) {
	/** @type {Map<string, Set<string>>} */
	const templated = new Map();
	for (const call of read(template)?.calls ?? []) {
		templated.set(call.file, new Set([...templated.get(call.file) ?? [], ...call.with?.inputs.keys() ?? []]));
	}
	const parsed = read(actual);
	if (!parsed) {
		return actual;
	}
	/** @type {Set<number>} */
	const dropped = new Set();
	for (const call of parsed.calls) {
		const known = declaredInputs(call.file);
		const own = templated.get(call.file) ?? new Set();
		if (call.with?.understood) {
			const removable = [...call.with.inputs].filter(([key, { scalar }]) => scalar && known.has(key) && !own.has(key));
			for (const [, { start, end }] of removable) {
				for (let i = start; i < end; i += 1) {
					dropped.add(i);
				}
			}
			for (const j of call.with.comments) {
				dropped.add(j);
			}
			if (removable.length === call.with.inputs.size && removable.length + call.with.comments.length > 0) {
				dropped.add(call.with.line);
			}
		}
	}
	const stripped = parsed.lines.filter((_, i) => !dropped.has(i)).join('\n');
	return read(stripped) ? endingsOf(stripped, actual) : actual;
}

/**
 * What `text` passes to reusable workflows of this repo's (see `inputsOf`), and the jobs whose `with:` isn't understood: those pass nothing that's known. `null` when `text` isn't understood at all.
 * @type {(text: string) => { inputs: Inputs, unread: Map<string, string> } | null}
 */
function passed(text) {
	const parsed = read(text);
	if (!parsed) {
		return null;
	}
	/** @type {Inputs} */
	const inputs = new Map();
	/** @type {Map<string, string>} */
	const unread = new Map();
	for (const call of parsed.calls) {
		const understood = !call.with || call.with.understood;
		inputs.set(call.job, { file: call.file, inputs: new Map(understood ? [...call.with?.inputs ?? []].map(([key, { start, end }]) => [key, parsed.lines.slice(start, end)]) : []) });
		if (!understood) {
			unread.set(call.job, call.file);
		}
	}
	return { inputs, unread };
}

/**
 * The inputs `text` passes to reusable workflows of this repo's, by the job that calls one: the workflow's file name, and each input as its lines (with its comments); a job that calls one without a `with:`, or with one that isn't understood, passes none.
 * @type {(text: string) => Inputs}
 */
export function inputsOf(text) {
	return passed(text)?.inputs ?? new Map();
}

/**
 * Each of `from`'s calls' counterpart in `to` (see above): its job in `to`, or `null` when it has none; and when that's because it's ambiguous, the jobs in `to` it might be.
 * @type {(from: Inputs, to: Inputs) => Map<string, { job: string | null, candidates: string[] }>}
 */
function counterparts(from, to) {
	const same = new Set([...from].filter(([job, { file }]) => to.get(job)?.file === file).map(([job]) => job));
	/** @type {(of: Inputs, file: string) => string[]} */
	const others = (of, file) => [...of].filter(([job, call]) => call.file === file && !same.has(job)).map(([job]) => job);
	return new Map([...from].map(([job, { file }]) => {
		if (same.has(job)) {
			return [job, { job, candidates: [] }];
		}
		const candidates = others(to, file);
		return [job, others(from, file).length === 1 && candidates.length === 1 ? { job: candidates[0], candidates: [] } : { job: null, candidates }];
	}));
}

/**
 * The inputs `from` passes that `to` doesn't, in each call's counterpart in `to` (by its job there): those `moved`; and those of a call whose counterpart is ambiguous that none of the calls it might be passes, which can't be: `ambiguous` (by its job in `from`).
 * @type {(from: Inputs, to: Inputs) => Moved}
 */
function move(from, to) {
	const where = counterparts(from, to);
	/** @type {Moved} */
	const result = { moved: new Map(), ambiguous: new Map() };
	for (const [job, { file, inputs }] of from) {
		const { job: target, candidates } = /** @type {{ job: string | null, candidates: string[] }} */ (where.get(job)); // eslint-disable-line no-extra-parens
		const passing = target === null ? candidates : [target];
		const missing = new Map([...inputs].filter(([key]) => !passing.some((c) => to.get(c)?.inputs.has(key))));
		if (missing.size > 0 && passing.length > 0) {
			(target === null ? result.ambiguous : result.moved).set(target ?? job, { file, inputs: missing });
		}
	}
	return result;
}

/**
 * The inputs `before` passes that `after` no longer does, in each call that `after` still has (by its job in `after`), and those of any call whose counterpart in `after` is ambiguous (by its job in `before`): see `move`.
 * @type {(before: string, after: string) => { removed: Inputs, ambiguous: Inputs }}
 */
export function removedInputs(before, after) {
	const { moved, ambiguous } = move(inputsOf(before), inputsOf(after));
	return { removed: moved, ambiguous };
}

/**
 * Why `ambiguous` (see `move`) can't be put anywhere, for a person.
 * @type {(ambiguous: Inputs) => string}
 */
export function ambiguity(ambiguous) {
	return [...ambiguous].map(([job, { file, inputs }]) => `job “${job}” passes ${[...inputs.keys()].join(', ')} to ${file}, but no job with that id calls it now, and which other call of it should get them is ambiguous`).join('; ');
}

/**
 * Of `inputs` (by job), those that `text` doesn't pass, in that job, to the same reusable workflow.
 * @type {(text: string, inputs: Inputs) => Inputs}
 */
export function notPassed(text, inputs) {
	const now = inputsOf(text);
	/** @type {Inputs} */
	const missing = new Map();
	for (const [job, { file, inputs: wanted }] of inputs) {
		const call = now.get(job);
		const left = new Map([...wanted].filter(([key]) => call?.file !== file || !call.inputs.has(key)));
		if (left.size > 0) {
			missing.set(job, { file, inputs: left });
		}
	}
	return missing;
}

/**
 * Why `missing` (see `notPassed`) couldn't be put back, for a person.
 * @type {(missing: Inputs) => string}
 */
export function unwritten(missing) {
	return [...missing].map(([job, { file, inputs }]) => `job “${job}” should pass ${[...inputs.keys()].join(', ')} to ${file}, but they can’t be added to it: it doesn’t call it, or its “with:”, or the file, isn’t YAML the App understands`).join('; ');
}

// shifted as a whole, so an input's lines (and its comments) keep their indentation relative to it: its first line that isn't a comment, its key's, goes at `indent`
/** @type {(lines: string[], indent: number) => string[]} */
function reindent(lines, indent) {
	const shift = indent - indentOf(String(lines.find((line) => !isBlank(line))));
	return lines.map((line) => (line.trim() === '' ? line : `${' '.repeat(Math.max(0, indentOf(line) + shift))}${line.replace(/^ +/, '')}`));
}

/**
 * Why `lines` aren't input `key`'s lines, as `addInputs` would add them, if they aren't: each must be one line (with no line break in it); any before its key's are blank or comments; every one after its key's is blank, a comment, or indented more than its key, so that none of them can be a key of anything else; and, on their own, they must be YAML the parser finds no error or warning in, of exactly that one key, `key`.
 * @type {(key: string, lines: string[]) => string | null}
 */
function malformed(key, lines) {
	if (lines.some((line) => (/[\r\n]/).test(line))) {
		return 'a line has a line break in it';
	}
	const at = lines.findIndex((line) => !isBlank(line));
	if (at < 0) {
		return 'there’s no key';
	}
	const indent = indentOf(lines[at]);
	if (!lines.slice(at + 1).every((line) => isBlank(line) || indentOf(line) > indent)) {
		return 'a line after its key isn’t blank, a comment, or indented more than its key';
	}
	const alone = parseDocument(reindent(lines, 0).join('\n'), { uniqueKeys: true });
	const map = alone.contents;
	return alone.errors.length === 0 && alone.warnings.length === 0 && isMap(map) && map.items.length === 1 && isString(map.items[0].key) && map.items[0].key.value === key ? null : 'its lines aren’t YAML of only that input';
}

/**
 * Why `after` isn't exactly `before` with `added` (each job's new inputs, by name) put in each job's `with:`, if it isn't: each such `with:` must have exactly the inputs it had, and those (and no other key); and the whole document, as its values (with every alias resolved where it is), without them (and without a `with:` that's new), must be exactly what `before`'s is.
 * @type {(before: Parsed, after: Parsed, added: Map<string, string[]>) => string | null}
 */
function changedOtherwise(before, after, added) {
	const without = /** @type {Map<unknown, unknown>} */ (after.doc.toJS({ mapAsMap: true })); // eslint-disable-line no-extra-parens
	// there's a call in it, so its `jobs` is a mapping
	const jobs = /** @type {Map<unknown, unknown>} */ (without.get('jobs')); // eslint-disable-line no-extra-parens
	for (const [job, keys] of added) {
		const had = /** @type {Call} */ (before.calls.find((call) => call.job === job)); // eslint-disable-line no-extra-parens
		const found = [...jobs].filter(([id]) => String(id) === job).map(([, value]) => value);
		const map = found.length === 1 && found[0] instanceof Map ? found[0] : null;
		const inputs = map?.get('with');
		const expected = new Set([...had.with?.inputs.keys() ?? [], ...keys]);
		if (!(inputs instanceof Map) || inputs.size !== expected.size || ![...inputs.keys()].every((key) => expected.has(key))) {
			return `job “${job}”’s \`with:\` wouldn’t have exactly the inputs it has, and those added`;
		}
		keys.forEach((key) => inputs.delete(key));
		if (!had.with) {
			/** @type {Map<unknown, unknown>} */ (map).delete('with'); // eslint-disable-line no-extra-parens
		} else if (inputs.size === 0 && had.with.inputs.size === 0) {
			/** @type {Map<unknown, unknown>} */ (map).set('with', null); // eslint-disable-line no-extra-parens
		}
	}
	return isDeepStrictEqual(without, before.doc.toJS({ mapAsMap: true })) ? null : 'adding them would change more of the file than those inputs';
}

/**
 * `text`, passing each of `inputs` it doesn't already pass, in the job it's for, when that job calls the same reusable workflow, exactly as given (re-indented): into its `with:` (after what the parser says is its last input), or a new one right after its `uses:`; with `text`'s line endings.
 * Only a `with:` that's understood (see above) is added to, and only an input whose lines are one input's (see `malformed`). Unless, afterwards, the file is still understood, every one of them is passed, in the job it's for (see `notPassed`), and nothing else in it has changed (see `changedOtherwise`), `text` is left as it is, and `why` says why.
 * @type {(text: string, inputs: Inputs) => { text: string, why: string | null }}
 */
export function addInputs(text, inputs) {
	const parsed = read(text);
	if (!parsed) {
		return { text, why: unwritten(inputs) };
	}
	const lines = [...parsed.lines];
	/** @type {Map<string, string[]>} */
	const added = new Map();
	// from the last call up, so that each insertion leaves the earlier calls' line numbers alone
	for (const call of [...parsed.calls].reverse()) {
		const passing = inputs.get(call.job);
		const wanted = [...passing?.file === call.file ? passing.inputs : []].filter(([key]) => !call.with?.inputs.has(key));
		if (wanted.length > 0 && call.with?.understood !== false) {
			for (const [key, value] of wanted) {
				const why = malformed(key, value);
				if (why) {
					return { text, why: `job “${call.job}”’s ${key} can’t be added to ${call.file}: ${why}` };
				}
			}
			const lined = wanted.flatMap(([, value]) => reindent(value, call.with?.indent ?? call.indent + 2));
			if (call.with) {
				lines.splice(call.with.end, 0, ...lined);
			} else {
				lines.splice(call.after, 0, `${' '.repeat(call.indent)}with:`, ...lined);
			}
			added.set(call.job, [...added.get(call.job) ?? [], ...wanted.map(([key]) => key)]);
		}
	}
	const result = lines.join('\n');
	const missing = notPassed(result, inputs);
	if (missing.size > 0) {
		return { text, why: unwritten(missing) };
	}
	if (added.size === 0) {
		return { text, why: null };
	}
	const why = changedOtherwise(parsed, /** @type {Parsed} */ (read(result)), added); // eslint-disable-line no-extra-parens
	return why ? { text, why } : { text: endingsOf(result, text), why: null };
}

/**
 * `rendered`, keeping the inputs named in `keep` that `current` passes, in each call's counterpart (see above): so that rewriting a file from its template keeps a repository's own values for them (and their comments).
 * When they can't all be kept (a call that passes one has no single counterpart; `current`, or a call's `with:` in it, isn't understood, so what it passes isn't known; or they can't be added to `rendered`), `why` says so, and `text` is just `rendered`.
 * @type {(rendered: string, current: string | null | undefined, keep: string[] | undefined) => { text: string, why: string | null }}
 */
export function keepInputs(rendered, current, keep) {
	if (!keep || keep.length === 0 || typeof current !== 'string') {
		return { text: rendered, why: null };
	}
	const found = passed(current);
	/** @type {(why: string) => { text: string, why: string }} */
	const refuse = (why) => ({ text: rendered, why: `the kept inputs can’t all be kept: ${why}` });
	if (!found) {
		return refuse('the file isn’t YAML the App understands, so what it passes isn’t known');
	}
	if (found.unread.size > 0) {
		return refuse([...found.unread].map(([job, file]) => `job “${job}”’s \`with:\` for ${file} isn’t one the App understands, so what it passes isn’t known`).join('; '));
	}
	const kept = new Set(keep);
	const { moved, ambiguous } = move(new Map([...found.inputs].map(([job, { file, inputs }]) => [job, { file, inputs: new Map([...inputs].filter(([key]) => kept.has(key))) }])), inputsOf(rendered));
	if (ambiguous.size > 0) {
		return refuse(ambiguity(ambiguous));
	}
	const { text, why } = addInputs(rendered, moved);
	return why ? refuse(why) : { text, why: null };
}

/**
 * The reusable workflows of this repo's that `text` calls, by their file names.
 * @type {(text: string) => Set<string>}
 */
export function calledWorkflows(text) {
	return new Set((read(text)?.calls ?? []).map((call) => call.file));
}
