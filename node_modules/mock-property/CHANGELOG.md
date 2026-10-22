# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.1.2](https://github.com/ljharb/mock-property/compare/v1.1.1...v1.1.2) - 2026-06-19

### Commits

- [types] export helper types [`4a50226`](https://github.com/ljharb/mock-property/commit/4a502269423e4496c5881467c2fd650cb910cce2)
- [types] allow mocking a property on any object, keyed to the property type [`09dd9cd`](https://github.com/ljharb/mock-property/commit/09dd9cdcade5cf5dbe61a122067ef099b6ea4a5a)
- [Robustness] use `es-errors` [`dbc7f6a`](https://github.com/ljharb/mock-property/commit/dbc7f6afe7123698cab6fa291227e0d6bcfe7435)

## [v1.1.1](https://github.com/ljharb/mock-property/compare/v1.1.0...v1.1.1) - 2026-06-19

### Commits

- [types] some cleanup [`9fee08c`](https://github.com/ljharb/mock-property/commit/9fee08c13017911c3d7d27396608a24fdb8f657d)
- [actions] update workflows [`ce6fe01`](https://github.com/ljharb/mock-property/commit/ce6fe01b7ed547941cca3d3640f052148862f887)
- [Fix] avoid a crash with a non-own inherited property [`44d670f`](https://github.com/ljharb/mock-property/commit/44d670f401e13d9d3c1041bd40cdc59010145eda)
- [Dev Deps] update `@arethetypeswrong/cli`, `@ljharb/eslint-config`, `@ljharb/tsconfig`, `@types/isarray`, `auto-changelog`, `es-value-fixtures`, `eslint`, `for-each`, `has-symbols`, `npmignore`, `tape` [`ceb91d4`](https://github.com/ljharb/mock-property/commit/ceb91d4bbccc43a636fc3b4d947f2bc780047276)
- [Deps] update `gopd`, `hasown`, `object-inspect` [`1db4729`](https://github.com/ljharb/mock-property/commit/1db47297fa392531d446acf7b45de0272ff467cd)
- [Dev Deps] update `@types/node` [`f20af9c`](https://github.com/ljharb/mock-property/commit/f20af9cb4e59250d70f34724ba97b3a91b29988a)
- [meta] fix run-script quote escaping [`9b1c082`](https://github.com/ljharb/mock-property/commit/9b1c08251690dadb6aecf44f33eec4222eb9be5e)
- [readme] replace runkit CI badge with shields.io check-runs badge [`e9f8b10`](https://github.com/ljharb/mock-property/commit/e9f8b106499390e00defedebc9c68a09f7647adb)
- [Dev Deps] update `@arethetypeswrong/cli` [`c8f6ee4`](https://github.com/ljharb/mock-property/commit/c8f6ee4a0f1ca8e426789b6614ed983f82e66089)

## [v1.1.0](https://github.com/ljharb/mock-property/compare/v1.0.3...v1.1.0) - 2024-08-06

### Commits

- [Tests] refactor tests for easier testing of multiple properties [`605c32e`](https://github.com/ljharb/mock-property/commit/605c32e8bc3c53320fe9c5eb7fd3836c55607443)
- [New] add types [`848be58`](https://github.com/ljharb/mock-property/commit/848be58428a8d17d46d083c8978138c432b7dfeb)
- [Fix] properly stringify Symbol properties [`369d824`](https://github.com/ljharb/mock-property/commit/369d8247d1dd840390a1f6bfe6afa239023b0e37)
- [Fix] avoid a crash when mocking a nonexistent data property as non-enumerable sans a value [`9994626`](https://github.com/ljharb/mock-property/commit/99946267704fd87f9044372ce016b48f4edb8081)
- [Dev Deps] update `@ljharb/eslint-config`, `aud`,` npmignore`, `object-inspect`, `tape` [`ebfaf9a`](https://github.com/ljharb/mock-property/commit/ebfaf9a2c3882fb1adcbd68df418c134cd39e85e)
- [Dev Deps] ensure tape’s mock-property is ourself, for testing [`2deaf72`](https://github.com/ljharb/mock-property/commit/2deaf72e8cb486b6044f9fb3a142f321107e7939)
- [Deps] update `define-data-property`, `has-property-descriptors`, `hasown` [`e9f503d`](https://github.com/ljharb/mock-property/commit/e9f503dd782f2d6c8531f4020a9a275badcb6d0c)
- [Tests] switch from `aud` to `npm audit` [`f5e6ce2`](https://github.com/ljharb/mock-property/commit/f5e6ce2b80d978aa7b6f8af38446ee67c1ae44ce)
- [meta] add `sideEffects` flag [`2089940`](https://github.com/ljharb/mock-property/commit/2089940cb0717102275bbac85708e9bf74d732e0)

## [v1.0.3](https://github.com/ljharb/mock-property/compare/v1.0.2...v1.0.3) - 2023-10-20

### Commits

- [Refactor] use `hasown` instead of `has` [`da0d497`](https://github.com/ljharb/mock-property/commit/da0d497e819a060b75c94027bf92cddc52777540)
- [Dev Deps] update `object-inspect`, `tape` [`0b14b22`](https://github.com/ljharb/mock-property/commit/0b14b22346754bbf2e700c49863597ff3836dc14)
- [Deps] update `define-data-property` [`538289b`](https://github.com/ljharb/mock-property/commit/538289b8ab7b8f4d06dfa7be01532819157925b9)

## [v1.0.2](https://github.com/ljharb/mock-property/compare/v1.0.1...v1.0.2) - 2023-10-11

## [v1.0.1](https://github.com/ljharb/mock-property/compare/v1.0.0...v1.0.1) - 2023-10-11

### Commits

- [meta] use `npmignore` to autogenerate an npmignore file [`46993e4`](https://github.com/ljharb/mock-property/commit/46993e4f1c0943e66f64fe1a94b05f433f4f434f)
- [Refactor] use `define-data-property` for data properties [`04e7859`](https://github.com/ljharb/mock-property/commit/04e7859e26f39806b90d1ff070d0935e210cb9aa)
- [patch] replace spaces with tabs [`be261ab`](https://github.com/ljharb/mock-property/commit/be261abea438ee1f3dca9c8721add88c11658cd9)
- [meta] fix auto-changelog config [`39eca6c`](https://github.com/ljharb/mock-property/commit/39eca6c3e483074c60b13e4dd657a62cdb836a70)
- [Fix] on restore, properly delete previously nonexistent properties in ES3 engines [`0378863`](https://github.com/ljharb/mock-property/commit/0378863cf9541f965a7822b1ed92660afdd7720d)
- [Fix] use `gopd` to handle IE &lt; 9 [`f4a7461`](https://github.com/ljharb/mock-property/commit/f4a746146154196261caac342f4afb59bde1508d)
- [actions] update rebase action [`fea7b9c`](https://github.com/ljharb/mock-property/commit/fea7b9c53cff3bcf6011ed565a76139a1f088052)
- [Dev Deps] update `@ljharb/eslint-config`, `aud`, `object-inspect`, `tape` [`3a5c6f5`](https://github.com/ljharb/mock-property/commit/3a5c6f564125e4af28c35d6213bb588c0c695194)
- [Fix] throw validation errors before SyntaxErrors [`34c9995`](https://github.com/ljharb/mock-property/commit/34c99958fb36c5970ac14344acb34c4294b1a5ea)
- [Dev Deps] update `@ljharb/eslint-config`, `aud`, `tape` [`cb46e3d`](https://github.com/ljharb/mock-property/commit/cb46e3de91cb4b40e6428e9028a832d2b67e64e3)
- [Dev Deps] update `es-value-fixtures`, `object-inspect`, `tape` [`bc66f0d`](https://github.com/ljharb/mock-property/commit/bc66f0d2d7d6b12c3b4112b99c38c1ae58572304)
- [Fix] in ES3 engines, do not attempt to change enumerability of array lengths [`cea6cd6`](https://github.com/ljharb/mock-property/commit/cea6cd6ed18b0f6b569735e398f2d767d3b0f4a0)
- [Dev Deps] update `tape` [`e44b744`](https://github.com/ljharb/mock-property/commit/e44b744399b785254f86d4c9f2b97d43ae38fb03)
- [Tests] skip tests that require ES5 in ES3 [`baa63d8`](https://github.com/ljharb/mock-property/commit/baa63d89ab326d257c6ee59491afb8fdd9e3c84e)
- [Deps] update `functions-have-names` [`dd791a7`](https://github.com/ljharb/mock-property/commit/dd791a7f934cf63a52d634da184a57e25341e2a0)
- [meta] correct FUNDING.yml [`5e2ca17`](https://github.com/ljharb/mock-property/commit/5e2ca17d71d1959c6e2c67a453b5d4528199ea36)

## v1.0.0 - 2022-04-16

### Commits

- Initial implementation, tests, readme [`dc1a5ff`](https://github.com/ljharb/mock-property/commit/dc1a5ff66da575e7714529854f4608cb91c01729)
- Initial commit [`8a8282a`](https://github.com/ljharb/mock-property/commit/8a8282ab7fe07083d497e991dac582ebc362ea30)
- npm init [`28c438a`](https://github.com/ljharb/mock-property/commit/28c438a5352c9b3a9a983cb9dfd9b1f37e04cc52)
- Only apps should have lockfiles [`6316905`](https://github.com/ljharb/mock-property/commit/6316905ca992763cabf7fa9269aa25db36cd928e)
