## [0.22.1](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.22.0...v0.22.1) (2026-10-27)


### Bug Fixes

* bugs from full code review (proxy, engines, launch args, config safety) ([#2](https://github.com/deda-ca/llama-cpp-config-gui/issues/2)) ([8df1a96](https://github.com/deda-ca/llama-cpp-config-gui/commit/8df1a96048c28d4d8c45cf1391b0e99f2dce8fc3))

# [0.22.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.21.0...v0.22.0) (2026-10-26)


### Features

* **proxy:** translate image generations to native sd.cpp jobs (docs/proxy-server.md 4.3.2) ([d27ec68](https://github.com/deda-ca/llama-cpp-config-gui/commit/d27ec680967d050f4a8661e4c190dcc8b27e004a))

# [0.21.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.20.0...v0.21.0) (2026-10-25)


### Features

* **sd:** add the SdConfig block and wire it through the engine store ([846c0e7](https://github.com/deda-ca/llama-cpp-config-gui/commit/846c0e789dd2b715cc433ddce10b542c8e350711))
* **sd:** add the stable-diffusion.cpp engine driver ([7de0837](https://github.com/deda-ca/llama-cpp-config-gui/commit/7de08370086ee8a864dc967e4140d70035f3a058))
* **sd:** editor UI, list wiring and card catalog (docs/stable-diffusion.md 3.8) ([b4bb523](https://github.com/deda-ca/llama-cpp-config-gui/commit/b4bb5233c39e625638f9a19dbb16e900d93576b8))
* **sd:** generate the stable-diffusion.cpp parameter catalogs ([4eed294](https://github.com/deda-ca/llama-cpp-config-gui/commit/4eed29494753a0b845e5ad7302bf72e887afd8c3))
* **sd:** launch path validates model-dir and selected card ([f8a34eb](https://github.com/deda-ca/llama-cpp-config-gui/commit/f8a34ebb3507a288cf47ea499939135f6df2bfca))
* **sd:** map sd model cards to load requests and the argv fallback ([d2fa807](https://github.com/deda-ca/llama-cpp-config-gui/commit/d2fa8070744eff7a0e767d1558206f05741b9d58))
* **sd:** mirror sd instances into the proxy and add image-edit + timeouts ([1bffd13](https://github.com/deda-ca/llama-cpp-config-gui/commit/1bffd131e2490a865bd8530dc41f5557bf35fdbc))
* **sd:** model-management proxy and startup load ([a8b6794](https://github.com/deda-ca/llama-cpp-config-gui/commit/a8b67941db1b6d32a80a928cf9d49e550fe8f11a))

# [0.20.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.19.0...v0.20.0) (2026-10-24)


### Features

* **models:** create cards straight into the editor ([2500e32](https://github.com/deda-ca/llama-cpp-config-gui/commit/2500e32b3097cc588cbd57a2385520d7120b3136))

# [0.19.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.18.0...v0.19.0) (2026-10-24)


### Features

* **audio:** parallel-jobs toggle gating per-model slots ([44b83d7](https://github.com/deda-ca/llama-cpp-config-gui/commit/44b83d7ed8a97c2f39fe7e9b4af49f838afec979))
* **models:** column list with favorites, drop launch/env/log UI ([3e93bbf](https://github.com/deda-ca/llama-cpp-config-gui/commit/3e93bbf7ef7c24996e4e71cbb602e7c5df7ec13f))

# [0.18.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.17.0...v0.18.0) (2026-10-23)


### Features

* **proxy:** auto-register audio engine instances as proxy backends ([09a83c8](https://github.com/deda-ca/llama-cpp-config-gui/commit/09a83c8962f7b28ecb1abcc95c888aa063034d86))

# [0.17.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.16.0...v0.17.0) (2026-10-23)


### Features

* **audio:** single executable path field with audiocpp_server version probe ([95c93b2](https://github.com/deda-ca/llama-cpp-config-gui/commit/95c93b2849a9cf7284f3c7482b86ec644f1942be))

# [0.16.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.15.0...v0.16.0) (2026-10-23)


### Features

* **audio:** llama.cpp-style editor layout with per-instance env vars ([accb508](https://github.com/deda-ca/llama-cpp-config-gui/commit/accb5089eb6e2df02744880c1a06c747920eb015))

# [0.15.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.14.1...v0.15.0) (2026-10-23)


### Features

* **engines:** audio.cpp engine with typed model configs and generated JSON ([850fb71](https://github.com/deda-ca/llama-cpp-config-gui/commit/850fb71cd6fcf8b379a14446f76ef9d4aeaed4d4))

## [0.14.1](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.14.0...v0.14.1) (2026-10-23)


### Bug Fixes

* **engines:** keep numeric param values as strings so they persist ([0393167](https://github.com/deda-ca/llama-cpp-config-gui/commit/0393167b6790443c0d52dd38011bb3c793c515a8))
* **engines:** re-derive the instance id on rename so launch files follow ([e155a47](https://github.com/deda-ca/llama-cpp-config-gui/commit/e155a470f5611592b3fa05e322bbcb1f636fbe02))

# [0.14.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.13.0...v0.14.0) (2026-10-23)


### Features

* **engines:** select router models per instance in the engine dialog ([96c7fa9](https://github.com/deda-ca/llama-cpp-config-gui/commit/96c7fa91cd2dda3ff1a8ce71ea67197bccf022fd))

# [0.13.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.12.0...v0.13.0) (2026-10-22)


### Features

* strata engine kind with self-contained config, JSON import/export, autoLaunch and create-on-save ([f485b4c](https://github.com/deda-ca/llama-cpp-config-gui/commit/f485b4c19a8d449dfa0e62f6590e8cbd3fb4d51e))

# [0.12.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.11.0...v0.12.0) (2026-10-22)


### Features

* strata engine kind with a per-kind parameter catalog ([3812a73](https://github.com/deda-ca/llama-cpp-config-gui/commit/3812a73dd339eaaf40b6cae16ff0b6a2344d230c))

# [0.11.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.10.0...v0.11.0) (2026-10-22)


### Features

* generic engine spawner (phase 3.5) - templates, notes, command preview, catalog-driven params, no hidden launch args ([bc116fa](https://github.com/deda-ca/llama-cpp-config-gui/commit/bc116faeb29ed44ce54caa30528e80ca1f9e230c))

# [0.10.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.9.0...v0.10.0) (2026-10-22)


### Features

* engine builds list in Environment dialog with per-definition validation ([11bd546](https://github.com/deda-ca/llama-cpp-config-gui/commit/11bd5463bf737778b8a81a8ddd85be7a3ca3d791))
* LLM Engines phase 1 — multi-instance engine manager, engines API, and Engines tab ([ff60464](https://github.com/deda-ca/llama-cpp-config-gui/commit/ff60464ac0adc1016c4c4f6b4c0ba93547d1cadb))

# [0.9.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.8.0...v0.9.0) (2026-10-21)


### Features

* usage tab, GitHub self-update with restart, and usage status settings ([70359cc](https://github.com/deda-ca/llama-cpp-config-gui/commit/70359cc4e94c764b2a8deffc334fd0641855bd9f))

# [0.8.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.7.0...v0.8.0) (2026-10-21)


### Features

* compact proxy usage panel in left column replacing model status ([8da5842](https://github.com/deda-ca/llama-cpp-config-gui/commit/8da5842c75a9f298bfdeb50ef9562d7d7ace70f9))

# [0.7.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.6.0...v0.7.0) (2026-10-21)


### Features

* proxy model alias mapping, duplicate upstreams, and new backend kinds ([2c1cb81](https://github.com/deda-ca/llama-cpp-config-gui/commit/2c1cb81d0fc153b2273b90de733e9b1a8329eb4f))

# [0.6.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.5.0...v0.6.0) (2026-10-15)


### Features

* show current PCIe link per GPU and drag-to-reorder GPU cards ([1cf679d](https://github.com/deda-ca/llama-cpp-config-gui/commit/1cf679db1a8d7b1bd571f0f98532f900acf7f5b6))

# [0.5.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.4.0...v0.5.0) (2026-10-14)


### Features

* proxy usage cached tokens and per-model pricing with cost estimates ([03dce9c](https://github.com/deda-ca/llama-cpp-config-gui/commit/03dce9cf836a8db26117c7d2c26d65cd893d67e6))

# [0.4.0](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.3.2...v0.4.0) (2026-10-14)


### Features

* OpenAI-compatible proxy server with model routing, usage tracking, and Proxy tab GUI ([f3ca673](https://github.com/deda-ca/llama-cpp-config-gui/commit/f3ca67399529be69e46df633bbdc500d04f989eb))

## [0.3.2](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.3.1...v0.3.2) (2026-10-05)


### Bug Fixes

* correct ZIP path in release upload step [skip ci] ([37f0463](https://github.com/deda-ca/llama-cpp-config-gui/commit/37f046370759890cdead2f05e3205eef456d43ae))
* export unchecked toggles as key = off instead of comments and group params by category in INI preview/export ([deca568](https://github.com/deda-ca/llama-cpp-config-gui/commit/deca568d125821e0e5125b49410851b3ad0acc32))

## [0.3.1](https://github.com/deda-ca/llama-cpp-config-gui/compare/v0.3.0...v0.3.1) (2026-10-02)


### Bug Fixes

* repair release workflow (Node 24, pipefail, credentials) and update docs ([23860ae](https://github.com/deda-ca/llama-cpp-config-gui/commit/23860ae706a27684dabe5e2808314a778dce6b14))
