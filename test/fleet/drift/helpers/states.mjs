import { readFileSync } from 'fs';
import path from 'path';

/** @typedef {import('../../../../fleet/lib/app.mjs').RepoState} RepoState */

const templateDir = path.join(import.meta.dirname, '..', '..', '..', '..', 'fleet', 'drift', 'templates');

/** @type {(name: string) => string} */
export function template(name) {
	return readFileSync(path.join(templateDir, name), 'utf8');
}

/** @type {(text: string, values: Record<string, string>) => string} */
export function fill(text, values) {
	return text.replace(/\{\{(?<name>\w+)\}\}/g, (_, name) => values[name]);
}

/** @type {(values?: Partial<Record<'label' | 'range' | 'type' | 'command', string>>) => string} */
export function nodeWorkflow(values = {}) {
	return fill(template('node.yml'), {
		label: '>= 4',
		range: '>= 4',
		type: 'minors',
		command: 'npm run tests-only',
		...values,
	});
}

/** @type {() => { name: string, text: string }[]} */
export function standardWorkflows() {
	return ['rebase.yml', 'node-pretest.yml', 'require-allow-edits.yml'].map((name) => ({ name, text: template(name) }));
}

// a cast rather than an annotation, so fields added to RepoState later needn't be listed here
/** @type {(overrides?: Partial<RepoState>) => RepoState} */
export function repoState(overrides = {}) {
	return /** @type {RepoState} */ ({ // eslint-disable-line no-extra-parens
		owner: 'ljharb',
		name: 'repo',
		repository: 'ljharb/repo',
		installationId: 1,
		private: false,
		archived: false,
		defaultBranch: 'main',
		config: { workflows: {} },
		configError: null,
		stateError: null,
		packageJson: null,
		workflows: standardWorkflows(),
		...overrides,
	});
}
