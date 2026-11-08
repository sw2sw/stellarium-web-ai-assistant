THIRD-PARTY COMPONENTS AND LICENCES
===================================

This file lists every third-party component that ships inside this delivery,
with the licence we believe applies and how confident we are about it. Where we
have not verified a licence, the row says so instead of guessing.

The project's own code is licensed AGPL-3.0-or-later; see LICENSE.

1. ENGINE AND WEB HOST
----------------------
Component : Stellarium Web Engine (including apps/web-frontend and apps/test-skydata)
Upstream  : https://github.com/Stellarium/stellarium-web-engine
Pinned at : 1162c9ef73cc94f4762dfbfd24c637190119ea93 (2026-10-20)
Licence   : AGPL-3.0 (file LICENSE-AGPL-3.0.txt in the upstream repository).
            Upstream also offers a separate commercial licence.
Status    : VERIFIED - licence file present in the pinned checkout.
Source    : https://github.com/Stellarium/stellarium-web-engine/tree/1162c9ef73cc94f4762dfbfd24c637190119ea93

STATUS OF THIS CANDIDATE PACKAGE (added 2026-10-31)
---------------------------------------------------
The candidate handoff is NOT a complete corresponding-source delivery yet.
The release asset named "project-source" carries this project's source, the
pinned commit, the three patches and the build recipe, but NOT the upstream tree
itself (`apps/web-frontend`, `src`, `apps/test-skydata`). Section 1 and the
"OFFERING SOURCE" section below say what was believed when the delivery was
assembled; where they say the delivery already contains the full source, read
that as the intent, not as the current state of this candidate. The machine
readable statement is `source_scope: {"complete": false, ...}` in
`RELEASE-MANIFEST.json`, and the gap is item 1 in `release/SOURCE-ACCESS.md`.

Because this delivery contains a build of an AGPL-3.0 work, distributing it
requires offering the complete corresponding source. The pinned commit above
plus the three patches in source/upstream/patches/ describes how to rebuild it;
the upstream tree still has to be supplied (or its availability stated, with a
legal sign-off) before the runtime asset is distributed.

2. FRONT-END LIBRARIES (bundled into dist/js/*.js by the upstream build)
-----------------------------------------------------------------------
These are resolved by apps/web-frontend/yarn.lock and were not modified by this
project, apart from the single `vue` version-range line described in
docs/UPSTREAM-BUILD.md.

Component          Version     Licence        Status
-----------------  ----------  -------------  ----------------------------------
Vue                2.6.12      MIT            VERIFIED (package metadata)
Vue Router         3.x         MIT            VERIFIED (package metadata)
Vuex               3.x         MIT            VERIFIED (package metadata)
vue-i18n           8.x         MIT            VERIFIED (package metadata)
Vuetify            2.6.x       MIT            VERIFIED (package metadata)
Roboto (font)      2.x         Apache-2.0     VERIFIED (font metadata)

The full dependency tree is pinned in the upstream yarn.lock; a per-package
licence dump has NOT been produced for this delivery. Run
`yarn licenses list` in apps/web-frontend before any public release.

3. DATA SHIPPED IN dist/skydata
-------------------------------
Component : apps/test-skydata (stars, dso, skycultures, landscapes, surveys,
            CometEls.txt, mpcorb.dat, tle_satellite.jsonl.gz)
Licence   : covered by the repository's AGPL-3.0 as part of the same tree.
Status    : PARTIALLY VERIFIED - no separate per-dataset licence or attribution
            file exists in the pinned checkout. Some of these files are almost
            certainly derived from third-party catalogues (star catalogues,
            orbital elements, satellite TLEs) whose original attribution terms
            may still apply.

ACTION REQUIRED before any public release: identify the provenance of each
dataset under apps/test-skydata and record the original attribution. This
delivery uses them unchanged, only for local verification, and does not claim
they are free of third-party terms.

4. WHAT THIS PROJECT ADDS
-------------------------
All files under source/ (loader, assistant, installer, tests, tools, docs) are
original work, licensed AGPL-3.0-or-later. They contain no copied upstream code
except where the comments cite an upstream file for reference.

This includes source/upstream/patches/0002-web-frontend-zh-locale.patch: the
Chinese GUI strings in its src/locales/zh.json are our own translation of the
key set in the upstream en.json, not a copy of any third-party translation
catalogue.

5. NOT INCLUDED
---------------
- No model provider SDK or API key.
- No analytics, telemetry or crash reporting.
- No third-party fonts beyond the ones the upstream build already bundles.

OFFERING SOURCE
---------------
This delivery is a build of an AGPL-3.0 work. Anyone redistributing
delivery/packages/integrated-web/dist must also make available:

  - the pinned upstream commit 1162c9ef73cc94f4762dfbfd24c637190119ea93,
  - the patches in source/upstream/patches/ (0001 vue2, 0002 zh locale, 0003 local fonts),
  - the build recipe in source/docs/UPSTREAM-BUILD.md.

The project source package contains the last two and points at the first. That
is not the same as handing over the upstream source, so: this candidate package
alone does NOT satisfy the requirement. Before distributing the runtime asset,
either ship a source archive cut from the pinned commit as a second asset, or
state the offer in writing (commit + patches + build recipe) and have it
reviewed. See the STATUS section at the top and HANDOFF.md item 1.

If the directory is split up, the source must be offered separately.

NOT VERIFIED
------------
This file records what was checked on 2026-10-30. It is not a legal opinion.
Before publishing the project on a public repository:
  - produce a full dependency licence dump,
  - resolve the skydata provenance question in section 3,
  - have the combination reviewed, since AGPL-3.0 obligations extend to the
    combined work.
