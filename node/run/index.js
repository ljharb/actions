'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const { spawnSync } = require('child_process');
const path = require('path');
const semver = require('semver');

const { status } = spawnSync('node', [require.resolve('setup-node-nvm')]);

if (status !== 0) {
  process.exitCode = status;
  return;
}

const cacheKey = core.getInput('cache-node-modules-key');

async function main() {
  let cacheHit = false;
  if (cacheKey) {
    process.env.INPUT_KEY = cacheKey;
    core.getInput('key', { required: true }); // assert
    process.env.INPUT_PATH = 'node_modules';
    core.getInput('path', { required: true }); // assert

    const { write } = process.stdout;
    process.stdout.write = function (arg) {
      if (typeof arg === 'string') {
        if (arg.startsWith('::save-state name=')) {
          const [name, value] = arg.slice('::save-state name='.length).split('::');
          core.info(`hijacking core.saveState output: ${name.split(',')}=${value}`)
          name.split(',').forEach((x) => {
            process.env[`STATE_${x}`] = value;
          });
        } else if (arg.startsWith('::set-output name=cache-hit::')) {
          core.info(`hijacking core.setOutput output: ${arg}`)
          cacheHit = arg === '::set-output name=cache-hit::true';
        }
      }
      return write.apply(process.stdout, arguments);
    };

    await require('cache/dist/restore').default();
  }

  const cmd = core.getInput('command');
  const shellCmd = core.getInput('shell-command');
  if (cmd && shellCmd) {
    throw new TypeError('`command` and `shell-command` are mutually exclusive');
  } else if (!cmd && !shellCmd) {
    throw new TypeError('One of `command` or `shell-command` must be provided');
  }

  const { status } = spawnSync('bash', [
    path.join(__dirname, 'command.sh'),
    core.getInput('node-version', { required: true }),
    shellCmd || `npm run "${cmd}"`,
    core.getInput('before_install'),
    String(cacheHit),
    core.getInput('after_install'),
    String(core.getInput('skip-ls-check')) === 'true',
    String(core.getInput('skip-install')) === 'true',
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  process.exitCode = status;

  core.info(`got status code ${status}`);

  if (status !== 0) {
    throw status;
  }

  if (cacheKey) {
    await require('cache/dist/save').default();
  }
}
main().catch((error) => {
  if (error) {
    console.error(error);
  }
  if (!process.exitCode) { process.exitCode = 1; }
});
