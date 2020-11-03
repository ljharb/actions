'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const { spawnSync } = require('child_process');
const path = require('path');
const semver = require('semver');

const { status: nvmStatus } = spawnSync('node', [require.resolve('setup-node-nvm')]);

if (nvmStatus) {
  process.exitCode = nvmStatus;
  return;
}

const { status } = spawnSync('bash', [
  path.join(__dirname, 'command.sh'),
  core.getInput('node-version'),
  core.getInput('command'),
], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

process.exitCode = status;