# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v2.1.1](https://github.com/inspect-js/has-dynamic-import/compare/v2.1.0...v2.1.1) - 2024-12-15

### Commits

- [types] use shared config [`72a0c9f`](https://github.com/inspect-js/has-dynamic-import/commit/72a0c9fb0d00118e89d8bd6987110ffc2678c490)
- [actions] split out node 10-20, and 20+ [`080e3da`](https://github.com/inspect-js/has-dynamic-import/commit/080e3da701479b5c697ae7c0d29cf692e1f97a3d)
- [Dev Deps] update `@ljharb/eslint-config`, `@ljharb/tsconfig`, `@types/node`, `@types/tape`, `auto-changelog`, `tape` [`f110c4a`](https://github.com/inspect-js/has-dynamic-import/commit/f110c4a82f81d83f539418d7a91245f291a76bef)
- [Refactor] use `call-bound` directly [`bb5bbfe`](https://github.com/inspect-js/has-dynamic-import/commit/bb5bbfea197256392dad9d5be2a4bd8e928d547f)
- [Dev Deps] update `@types/node`, `@types/semver`, `tape`, `typescript` [`e9e8116`](https://github.com/inspect-js/has-dynamic-import/commit/e9e8116060fcc66420b1cf3168701f262d281961)
- [Deps] update `call-bind`, `get-intrinsic` [`fc96301`](https://github.com/inspect-js/has-dynamic-import/commit/fc963015bd1a247cd9b1d84e2375c7b0e294b2a7)
- [Deps] update `call-bind`, `get-intrinsic` [`2a24231`](https://github.com/inspect-js/has-dynamic-import/commit/2a24231bf0bdb3d30c67773706fe752c534430cb)
- [Tests] fix a spurious failure caused by a deprecation warning [`3458310`](https://github.com/inspect-js/has-dynamic-import/commit/3458310567322f1c8c00702e65be0589cfbb1c31)
- [Tests] replace `aud` with `npm audit` [`d6b1f10`](https://github.com/inspect-js/has-dynamic-import/commit/d6b1f102d3561d1473254bd05397cdfe9eae3fcf)
- [Dev Deps] add missing peer dep [`c8dbae1`](https://github.com/inspect-js/has-dynamic-import/commit/c8dbae19133531cc287f991c919bdb1af9255ee4)

## [v2.1.0](https://github.com/inspect-js/has-dynamic-import/compare/v2.0.1...v2.1.0) - 2024-01-12

### Commits

- [meta] use `npmignore` to autogenerate an npmignore file [`16fda28`](https://github.com/inspect-js/has-dynamic-import/commit/16fda2832e3ea59b72145a464740d93c6f9e4341)
- [New] add inline jsdoc types, for TS [`4d07733`](https://github.com/inspect-js/has-dynamic-import/commit/4d077337e2a5d6897f93363794916a29a440e017)
- [Dev Deps] update `eslint`, `@ljharb/eslint-config`, `aud`, `auto-changelog`, `tape` [`63fe5e3`](https://github.com/inspect-js/has-dynamic-import/commit/63fe5e33ddcc22783e226ca35fa792dfe373dd36)
- [actions] update rebase action to use reusable workflow [`5bc0894`](https://github.com/inspect-js/has-dynamic-import/commit/5bc0894224a711c4c7e6b68771d95984ccba513f)
- [Dev Deps] update `@ljharb/eslint-config`, `aud`, `npmignore`, `semver`, `tape` [`201283d`](https://github.com/inspect-js/has-dynamic-import/commit/201283de6b6314fa39254d241d4e3e975702ad39)
- [Deps] update `call-bind`, `get-intrinsic` [`4a5bed0`](https://github.com/inspect-js/has-dynamic-import/commit/4a5bed0c8a7c50ab7a0e9dab36f43f4b462dbe55)
- [meta] add missing `engines.node` [`b544707`](https://github.com/inspect-js/has-dynamic-import/commit/b544707aa19b50cd648df0b8721574c19bce0566)
- [Robustness] make promiselikes into null objects [`ffded66`](https://github.com/inspect-js/has-dynamic-import/commit/ffded665cfc52b0a10798a492b616cf2fd705507)
- [Deps] update `get-intrinsic` [`dc65726`](https://github.com/inspect-js/has-dynamic-import/commit/dc65726bd08f31de40220c680256464dd253eba9)
- [meta] add `sideEffects` flag [`512e0fd`](https://github.com/inspect-js/has-dynamic-import/commit/512e0fdd84b6c2846fe843597402f61793953b4d)

## [v2.0.1](https://github.com/inspect-js/has-dynamic-import/compare/v2.0.0...v2.0.1) - 2021-12-12

### Commits

- [actions] reuse common workflows [`308d8fb`](https://github.com/inspect-js/has-dynamic-import/commit/308d8fb4bc8e1330111da4df22be2c80b6e5f9f8)
- [Fix] ensure the fake promise resolves on nextTick [`dea0dbc`](https://github.com/inspect-js/has-dynamic-import/commit/dea0dbca11217c8d0b0ecbbee26b7e5ae649cef6)
- [Dev Deps] update `eslint`, `@ljharb/eslint-config`, `safe-publish-latest`, `tape` [`5e9431c`](https://github.com/inspect-js/has-dynamic-import/commit/5e9431cea8952bb65905beb1ec23c9f259c36247)
- [actions] update codecov uploader [`0b8d3f8`](https://github.com/inspect-js/has-dynamic-import/commit/0b8d3f87e7613976d353768fb45fad5a5ac3d7df)
- [Dev Deps] update `eslint`, `@ljharb/eslint-config`, `safe-publish-latest`, `tape` [`8fcdc05`](https://github.com/inspect-js/has-dynamic-import/commit/8fcdc055e32226fa8f76aea0ea0d13dff06e727b)

## [v2.0.0](https://github.com/inspect-js/has-dynamic-import/compare/v1.1.0...v2.0.0) - 2021-05-30

### Commits

- [Breaking] main entry point exports an `async function` and checks functionality; "syntax" entry point exports previous predicate [`dedeaac`](https://github.com/inspect-js/has-dynamic-import/commit/dedeaac1362eff8cf82485f22ed4e26ca79e8adf)

## [v1.1.0](https://github.com/inspect-js/has-dynamic-import/compare/v1.0.1...v1.1.0) - 2021-05-30

### Commits

- [New] add `syntax` entry point that matches current main entry point [`6a1ac52`](https://github.com/inspect-js/has-dynamic-import/commit/6a1ac5209ced527eea97e529b9b9de7752fa62b8)
- [Dev Deps] update `eslint`, `auto-changelog` [`c8c737f`](https://github.com/inspect-js/has-dynamic-import/commit/c8c737fc058eb96499e282bd4ed372490a2dcff9)

## [v1.0.1](https://github.com/inspect-js/has-dynamic-import/compare/v1.0.0...v1.0.1) - 2021-05-13

### Commits

- [Fix] typo [`efcfc6e`](https://github.com/inspect-js/has-dynamic-import/commit/efcfc6ea041db51d76f45002bd49513cf8252bea)

## v1.0.0 - 2021-05-13

### Commits

- Tests [`04e7d5a`](https://github.com/inspect-js/has-dynamic-import/commit/04e7d5a7e6bae48fc47b4c383f7d353ceab31ce3)
- Initial commit [`2346897`](https://github.com/inspect-js/has-dynamic-import/commit/234689702a12c0eb552693a3fcaa670278054703)
- [meta] do not publish github action workflow files [`f81487c`](https://github.com/inspect-js/has-dynamic-import/commit/f81487ce5c70407bff2aa15f7ebb291bb988de0f)
- Read me [`c5c096d`](https://github.com/inspect-js/has-dynamic-import/commit/c5c096deb76910954ead5c7b200ae55d66829d77)
- Implementation [`cb67ea6`](https://github.com/inspect-js/has-dynamic-import/commit/cb67ea6de3234bc19d5929315f3591b7599746c9)
- npm init [`9679f19`](https://github.com/inspect-js/has-dynamic-import/commit/9679f19a83dda19219c5f37c94673a937ace873b)
- [meta] add `auto-changelog` [`a8fcf19`](https://github.com/inspect-js/has-dynamic-import/commit/a8fcf19f0810f49f8c5152c7d8721cb8163c7c6d)
- Browser implementation. [`8c97791`](https://github.com/inspect-js/has-dynamic-import/commit/8c977914093b144a1d1f8e7cf1679f7e1b7b552b)
- [meta] create `FUNDING.yml`, add `funding` field [`89fbce7`](https://github.com/inspect-js/has-dynamic-import/commit/89fbce7387166451156dfb5ad4f591791346c349)
- [Tests] add `npm run lint` [`d9a308f`](https://github.com/inspect-js/has-dynamic-import/commit/d9a308f13ece4d5f89ebfbfa879ed6f19d5067e8)
- [meta] add `safe-publish-latest` [`eb01fff`](https://github.com/inspect-js/has-dynamic-import/commit/eb01fff88f3b2929e3c3b956ed5763d7495b913d)
- Only apps should have lockfiles [`d7f41ab`](https://github.com/inspect-js/has-dynamic-import/commit/d7f41ab00ae113fdd02a21287ddbf33602da5e93)
- [Tests] skip `nyc` on `io.js` `v3.0-3.2`, since it core dumps [`1778f5d`](https://github.com/inspect-js/has-dynamic-import/commit/1778f5d500855118e06adc9b5ccc12e382055218)
