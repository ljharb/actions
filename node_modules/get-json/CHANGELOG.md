# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.1.0](https://github.com/ljharb/get-json/compare/v1.0.2...v1.1.0) - 2024-06-16

### Commits

- [Refactor] replace `phin` with a simplified inlined version [`c649fb5`](https://github.com/ljharb/get-json/commit/c649fb5da34e916343351e1e2b37b1aa14babc2e)
- [Refactor] reject earlier when the URL is not a string [`f2d9797`](https://github.com/ljharb/get-json/commit/f2d9797be414aed423add8fa1380b604466d2130)
- [meta] delete npmignore file [`acb9430`](https://github.com/ljharb/get-json/commit/acb9430fb169868383c4246ee4097ffaa2938fe2)
- [Dev Deps] update `tape` [`240fc6e`](https://github.com/ljharb/get-json/commit/240fc6ea74cae93c8e8b280f6b2e8530001ebe2f)

## [v1.0.2](https://github.com/ljharb/get-json/compare/v1.0.1...v1.0.2) - 2024-06-14

### Merged

- Revert "Project status: Deprecated" [`#6`](https://github.com/ljharb/get-json/pull/6)
- Project status: Deprecated [`#6`](https://github.com/ljharb/get-json/pull/6)

### Commits

- [eslint] add eslint [`cd85915`](https://github.com/ljharb/get-json/commit/cd859151d7026dc7285d90e06f294bbd6611a779)
- [Tests] migrate from travis to GHA [`06132a7`](https://github.com/ljharb/get-json/commit/06132a7b63f42de48fc6273fa829ada1d55af7e8)
- [meta] add `auto-changelog` [`057c3d7`](https://github.com/ljharb/get-json/commit/057c3d75bd80d5384a925d23db2cebdb36eca9b0)
- [meta] use `npmignore` [`51e1da6`](https://github.com/ljharb/get-json/commit/51e1da64ca8d087a27c8e22cd94c667a6c2122d4)
- [meta] clean up package.json [`ad75a77`](https://github.com/ljharb/get-json/commit/ad75a779f297a74965b3c3c808531ebabcf12a20)
- [Fix] ensure browser fallback returns a Promise [`6664a6b`](https://github.com/ljharb/get-json/commit/6664a6b2cb8b2cd298a2c05e0c9f111379e6330c)
- [meta] add missing LICENSE file; use correct SPDX license identifier [`c67a81a`](https://github.com/ljharb/get-json/commit/c67a81a7c100fc5fad5be7e0cfed7b2fc92f9a33)
- [Deps] update `jsonp`, `phin` [`e0b383e`](https://github.com/ljharb/get-json/commit/e0b383edb4cf900cbf4b40f8f95339cc043dd68e)
- [Refactor] use `browser` field instead of runtime `is-node` detection [`acfa556`](https://github.com/ljharb/get-json/commit/acfa5562e2beda9a22ea2b89f6e44463e18eacc3)
- Only apps should have lockfiles [`b78e799`](https://github.com/ljharb/get-json/commit/b78e799f8a5d63a2e146491ac5c56f2b6c7732b0)
- [Tests] switch from `prova` to `tape` [`686dea6`](https://github.com/ljharb/get-json/commit/686dea661861144e0728221297bc8ba0e72fd714)
- [Tests] move tests into test dir [`895e2de`](https://github.com/ljharb/get-json/commit/895e2de2a75369648b01d60900d63eaa9545a3b0)
- [meta] add missing `engines.node` [`e0b27f1`](https://github.com/ljharb/get-json/commit/e0b27f1c71508b148464892200b6b2db5c034a87)
- [meta] update repo [`b802bf5`](https://github.com/ljharb/get-json/commit/b802bf5d14fc847807366714d38afc6495b012cc)
- [meta] ignore &lt; high audit warnings [`5156dd2`](https://github.com/ljharb/get-json/commit/5156dd28e89cbd2daadd059b385d0147d5a91560)

## [v1.0.1](https://github.com/ljharb/get-json/compare/v1.0.0...v1.0.1) - 2018-10-07

### Merged

- remove node-noop [`#4`](https://github.com/ljharb/get-json/pull/4)
- Promise support [`#3`](https://github.com/ljharb/get-json/pull/3)

### Commits

- add travis [`233ebc2`](https://github.com/ljharb/get-json/commit/233ebc24400cd3cef18dcc39145ab00c3957216b)
- add promise support [`32de12e`](https://github.com/ljharb/get-json/commit/32de12ed3eb87ae4f593a7841bb26ab6d0418616)
- bug callback [`0dc6089`](https://github.com/ljharb/get-json/commit/0dc60899dd19ca33431b2133cf3128d51a543075)
- fix node 4 [`df29a40`](https://github.com/ljharb/get-json/commit/df29a409802e53218eb7ae5d56934b3fea13db63)
- prova not work in node 4 [`ce88e7c`](https://github.com/ljharb/get-json/commit/ce88e7cb7720e9ece7640e057f034096b5698a67)

## [v1.0.0](https://github.com/ljharb/get-json/compare/v0.0.3...v1.0.0) - 2017-08-17

### Merged

- Use phin instead of Request [`#2`](https://github.com/ljharb/get-json/pull/2)

### Commits

- Merged upstream [`7a7c9aa`](https://github.com/ljharb/get-json/commit/7a7c9aadf5ed8a9d1aa1a6b342b08c64e39398dc)
- Bumped version, fixed tests [`7c5fb45`](https://github.com/ljharb/get-json/commit/7c5fb4554a618ff19e00e1a2a8a124d5321bd734)
- Returned tests to original [`6a5099a`](https://github.com/ljharb/get-json/commit/6a5099abb7d2a97cae08643931c0ab65414e1ce1)
- Repaired tests [`7bc5ec3`](https://github.com/ljharb/get-json/commit/7bc5ec3a9ee5fe4ed3d9c9d8e2a66d8a1b943777)
- Request --&gt; phin [`74baa29`](https://github.com/ljharb/get-json/commit/74baa290d495d52d39d215f1fef1fa74f3c797dd)
- add travis config [`142460c`](https://github.com/ljharb/get-json/commit/142460c9c4f866f798fe25c766f0affd3d87507d)
- Unbumped version [`91004f6`](https://github.com/ljharb/get-json/commit/91004f68aebbbb1d72c79e48642c0fb35b37c689)

## v0.0.3 - 2016-04-18

### Commits

- add JSONP fallback [`d3e1059`](https://github.com/ljharb/get-json/commit/d3e1059c769da1c852cb30e9444bd5b543dd604e)
- first commit [`e7eb512`](https://github.com/ljharb/get-json/commit/e7eb512b494971939a6441c452aa667d0afec4c9)
- set repo to zeke's fork following #unpublishgate [`d8e330c`](https://github.com/ljharb/get-json/commit/d8e330cf0e421fb39a3a99c4e718eb32ce2f95bb)
- Create .travis.yml [`0b939cd`](https://github.com/ljharb/get-json/commit/0b939cdc364154726b252d7752f8642397a171e3)
- set repo to zeke's fork following #unpublishgate [`336837b`](https://github.com/ljharb/get-json/commit/336837ba800e5b64c12ce0e3af7801e336cb6d0e)
