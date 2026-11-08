# Third-party components and source scope

The project's own code is licensed under AGPL-3.0-or-later; see [LICENSE](LICENSE) and [NOTICE](NOTICE). This document describes the upstream host and related dependencies. It is not a complete dependency licence audit or a legal opinion.

## Repository scope

This repository contains the assistant, adapter, optional AI service, installer, tests, documentation and host patches. It does **not** contain the complete upstream source tree, a complete host runtime, or all third-party datasets and dependencies listed below.

The project-source archive is not a complete corresponding-source delivery. Its `source_scope.complete` value remains `false`; see [source access and outstanding materials](release/SOURCE-ACCESS.md).

## Stellarium Web Engine and host

- Upstream: https://github.com/Stellarium/stellarium-web-engine
- Pinned commit: `1162c9ef73cc94f4762dfbfd24c637190119ea93`
- Licence: AGPL-3.0, under the upstream `LICENSE-AGPL-3.0.txt`; upstream also offers a separate commercial licence.
- Relevant components: the engine, `apps/web-frontend` and `apps/test-skydata`.
- Local changes: three patches under `source/upstream/patches/`, covering the Vue version range, Chinese interface/language hook and local-font template.
- Build recipe: [UPSTREAM-BUILD.md](source/docs/UPSTREAM-BUILD.md).

A pinned commit and links do not by themselves supply the entire corresponding source or ensure that it matches a particular runtime build.

## Host front-end dependencies

The host build uses these component families; exact resolved versions and licence files must be checked against the dependency tree used for the specific build.

| Component | Version family | Reported licence |
|---|---|---|
| Vue | 2.6.12 | MIT |
| Vue Router | 3.x | MIT |
| Vuex | 3.x | MIT |
| vue-i18n | 8.x | MIT |
| Vuetify | 2.6.x | MIT |
| Roboto | 2.x | Apache-2.0 |

A complete per-package licence inventory is not included. Obtain the matching front-end dependency lock, inspect installed package licence files, and generate a dependency licence listing before distributing a combined host runtime. The repository does not include that complete lock material.

## Star, sky-culture and other data

`apps/test-skydata` contains star and deep-sky catalogues, sky cultures, landscapes, surveys and orbital data. The upstream repository licence does not establish that every dataset is free of separate attribution or use conditions.

Dataset-by-dataset provenance and attribution remain unresolved. Check original catalogue, imagery and orbital-data terms before redistributing those materials, and retain required credits. The project does not claim a completed data-licence audit.

## Project additions

The assistant, adapter, installer, optional AI service and related project code use AGPL-3.0-or-later. Host patches necessarily include upstream context; preserve the upstream notices and licence terms. The Chinese interface strings in `0002-web-frontend-zh-locale.patch` are project translations of the upstream key set, not a third-party translation catalogue.

No model-provider SDK, provider key, production identity store or quota ledger is included in this source repository. Model services and their processing terms are configured separately.

## Corresponding-source obligations

When redistributing a combined runtime or providing network access to modified AGPL-covered software, assess the applicable corresponding-source requirements for the actual deployment. Required materials can include the matching upstream tree, project modifications, patches, build scripts, dependency locks and relevant data/build inputs.

Private repository access alone does not ensure that all website users can obtain matching source. The missing materials and user-access route must be resolved rather than treating the project-source archive as complete. See [SOURCE-ACCESS.md](release/SOURCE-ACCESS.md).
