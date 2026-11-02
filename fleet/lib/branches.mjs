// the branches the fleet App's bot opens PRs from: the one source of truth for their names, since `/merge` merges only PRs from these
export const fixBranch = 'fleet/workflows';
export const relockBranch = 'actions-lock/relock';

/** @type {readonly string[]} */
export const botBranches = Object.freeze([fixBranch, relockBranch]);
