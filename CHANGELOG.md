# Changelog

## [0.6.5](https://github.com/escalay/yardhand/compare/v0.6.4...v0.6.5) (2026-11-25)


### Fixes

* **gateway:** take kit 1.33.0 ([#55](https://github.com/escalay/yardhand/issues/55)) ([ccbb585](https://github.com/escalay/yardhand/commit/ccbb585f0915d7782737d0c6ac0b67b359aeb018))

## [0.6.4](https://github.com/escalay/yardhand/compare/v0.6.3...v0.6.4) (2026-11-24)


### Features

* **clients:** bind each sign-in to the address it was made for ([#50](https://github.com/escalay/yardhand/issues/50)) ([864c4d2](https://github.com/escalay/yardhand/commit/864c4d2115fcf68b26cb2c047e135590f6e60691))
* **packs:** give the gateway and each pack an icon ([#51](https://github.com/escalay/yardhand/issues/51)) ([ae8b10f](https://github.com/escalay/yardhand/commit/ae8b10ffc5d34e4f11ad6528e96bb210dfd5ea5c))


### Fixes

* **clients:** know an OAuth client by its sign-in, not its name ([#48](https://github.com/escalay/yardhand/issues/48)) ([be13f72](https://github.com/escalay/yardhand/commit/be13f72ca46b8d98432044cd466302295d064043))

## [0.6.3](https://github.com/escalay/yardhand/compare/v0.6.2...v0.6.3) (2026-11-22)


### Fixes

* **clients:** point a pack address's 401 at its own resource metadata ([#44](https://github.com/escalay/yardhand/issues/44)) ([ed2e916](https://github.com/escalay/yardhand/commit/ed2e91645f035abbe600bea237f4e63ba1228ae6))

## [0.6.2](https://github.com/escalay/yardhand/compare/v0.6.1...v0.6.2) (2026-11-22)


### Fixes

* **session:** let the owner approve a sign-in with their own session ([#42](https://github.com/escalay/yardhand/issues/42)) ([baa227c](https://github.com/escalay/yardhand/commit/baa227cdc8e210e2a5dc2d40e0497b828d01fa95))

## [0.6.1](https://github.com/escalay/yardhand/compare/v0.6.0...v0.6.1) (2026-11-22)


### Fixes

* **builds:** what the first real builds got wrong ([#39](https://github.com/escalay/yardhand/issues/39)) ([2a73027](https://github.com/escalay/yardhand/commit/2a730275d5fb4d86c2dc4fbbd5080a3aeb8db02b))
* **catalog:** playbook arguments over REST, skill checks, vector retry ([#41](https://github.com/escalay/yardhand/issues/41)) ([292f5f1](https://github.com/escalay/yardhand/commit/292f5f13bcd6e294142b72e3b3c3cddfed334566))

## [0.6.0](https://github.com/escalay/yardhand/compare/v0.5.0...v0.6.0) (2026-11-22)


### Features

* **builds:** build and refresh a pack with AI, rehearsed and capped at $1 ([#37](https://github.com/escalay/yardhand/issues/37)) ([4164229](https://github.com/escalay/yardhand/commit/4164229f72f76a053958c4102451517350812158))
* **packs:** add variables and input modes to a pack's tools ([#31](https://github.com/escalay/yardhand/issues/31)) ([845dc08](https://github.com/escalay/yardhand/commit/845dc08c2f2567a7592f08ecb5b229c2f33b4a6b)), closes [#22](https://github.com/escalay/yardhand/issues/22)
* **packs:** extend keys, name the pack when access ends, rename packs ([#30](https://github.com/escalay/yardhand/issues/30)) ([6bdcc5f](https://github.com/escalay/yardhand/commit/6bdcc5fe2eb7124535b53629d3968f04f7af1cf9)), closes [#20](https://github.com/escalay/yardhand/issues/20)
* **packs:** fill a pack input with each person's own value ([#36](https://github.com/escalay/yardhand/issues/36)) ([3370d62](https://github.com/escalay/yardhand/commit/3370d62df03be8a2479eab2aacd1c9adf1638c8f))
* **packs:** playbooks and a skill written for a pack, served to its keys ([#34](https://github.com/escalay/yardhand/issues/34)) ([05ac508](https://github.com/escalay/yardhand/commit/05ac5087d963457feddc3c9769e79404afd8e1aa))
* **packs:** share a pack with one person, list its people, nudge before access ends ([#33](https://github.com/escalay/yardhand/issues/33)) ([0ffcba1](https://github.com/escalay/yardhand/commit/0ffcba1b8dbe2ed49fb24223c293794b859288d7))


### Fixes

* **clients:** refuse to extend a key whose packs are all gone ([#32](https://github.com/escalay/yardhand/issues/32)) ([48ca442](https://github.com/escalay/yardhand/commit/48ca442e68d2795dcf79150209a2e4be86e813e8)), closes [#20](https://github.com/escalay/yardhand/issues/20)


### Documentation

* **decisions:** rename the example pack in the sketches ([#28](https://github.com/escalay/yardhand/issues/28)) ([3d63549](https://github.com/escalay/yardhand/commit/3d63549cb1ec6eaa981d7173b4e60a495460307b))
* **release:** point Extend at People, which ships in 0.6.0 ([#38](https://github.com/escalay/yardhand/issues/38)) ([7b19273](https://github.com/escalay/yardhand/commit/7b19273b0ba702483695731a45160b4164f638ba))

## [0.5.0](https://github.com/escalay/yardhand/compare/v0.4.0...v0.5.0) (2026-11-21)


### Features

* **packs:** serve each pack at its own address ([#25](https://github.com/escalay/yardhand/issues/25)) ([72b5058](https://github.com/escalay/yardhand/commit/72b5058730bb70c24a60953e867eccf53777335e)), closes [#19](https://github.com/escalay/yardhand/issues/19)
* **search:** return only tools that clearly match ([#24](https://github.com/escalay/yardhand/issues/24)) ([dde2abb](https://github.com/escalay/yardhand/commit/dde2abbe319203e58daafda5841f0a80141752f5)), closes [#19](https://github.com/escalay/yardhand/issues/19)


### Fixes

* **search:** fit the bar to the size of the catalog ([#26](https://github.com/escalay/yardhand/issues/26)) ([a1641f1](https://github.com/escalay/yardhand/commit/a1641f1163dcf1a1a39072c5b813abde92cc6e9a)), closes [#19](https://github.com/escalay/yardhand/issues/19)


### Documentation

* decide packs as their own servers, with sharing and authoring ([#18](https://github.com/escalay/yardhand/issues/18)) ([7306c77](https://github.com/escalay/yardhand/commit/7306c77f6dc2cf114a1e91e763ba9eaa1021c5b5))

## [0.4.0](https://github.com/escalay/yardhand/compare/v0.3.1...v0.4.0) (2026-11-21)


### Features

* **connections:** connect servers that only sign in local apps ([#16](https://github.com/escalay/yardhand/issues/16)) ([bd0421b](https://github.com/escalay/yardhand/commit/bd0421b5ed8411128740b94c4535242a5d2e2d60))

## [0.3.1](https://github.com/escalay/yardhand/compare/v0.3.0...v0.3.1) (2026-11-12)


### Fixes

* **deploy:** make the chart install the release it is numbered as ([2722867](https://github.com/escalay/yardhand/commit/272286749226262c4342963989f4acd010cc7769))

## [0.3.0](https://github.com/escalay/yardhand/compare/v0.2.0...v0.3.0) (2026-11-11)


### Features

* **deploy:** add a Helm chart, released with the app ([cc251e0](https://github.com/escalay/yardhand/commit/cc251e009ac3db27f461dea9787a597b58f9b1ca))
* **deploy:** ship the updater beside the gateway in the compose file ([4f456b6](https://github.com/escalay/yardhand/commit/4f456b691b8109555c5714d2683bca01710e0ab6))
* **instance:** undo an update that never came up when the old version starts again ([f5a94a1](https://github.com/escalay/yardhand/commit/f5a94a1c3d466a52a4e59e76a2be3a2ddf845a56))
* **telemetry:** let the owner read the usage report over the API ([5e7091b](https://github.com/escalay/yardhand/commit/5e7091bea0903be2b7f58bdcfc42b3eefa610edc))
* **telemetry:** send an anonymous usage report once a day, unless switched off ([7b5d46f](https://github.com/escalay/yardhand/commit/7b5d46f64ecaa697e35420d40982c2beff0711c3))
* **telemetry:** show the usage report in Settings ([2ac08ec](https://github.com/escalay/yardhand/commit/2ac08ec56d4bcd9753217da7a83e4cc3fccc6ddf))
* **updates:** check for a newer version and ask an updater to install it ([1bdad75](https://github.com/escalay/yardhand/commit/1bdad75bebfaa859848a683dc19a861ccd8ace92))
* **web:** show updates in Settings and on the overview ([95a00a4](https://github.com/escalay/yardhand/commit/95a00a4fe5c96aa61848aa17285729b6d0dfce78))


### Fixes

* **telemetry:** count grouping as on when a local model needs no key ([2e1d3cb](https://github.com/escalay/yardhand/commit/2e1d3cbd6f97c3cdb5956d24f6ee460054629f20))
* **telemetry:** say how to switch it back on when it is off ([6b6050c](https://github.com/escalay/yardhand/commit/6b6050c2f873f2f731296fe52e990350fd6207f9))


### Documentation

* **agents:** point the telemetry row at the public doc only ([1e412ed](https://github.com/escalay/yardhand/commit/1e412ed5c04fbfaf0c1b7857389add28e821319e))
* explain updates, the updater and what it may do ([4798f0b](https://github.com/escalay/yardhand/commit/4798f0bd7223771ca72c311cd30344c862889dd1))
* explain usage telemetry ([78c3103](https://github.com/escalay/yardhand/commit/78c3103d638df88c3618b18342283c1f795166e0))
* Kubernetes, and what happens when an update never comes up ([2658810](https://github.com/escalay/yardhand/commit/2658810ff1663074833dd904f2be02c7c3aa14e5))
* say what the upgrade test covers ([1822b40](https://github.com/escalay/yardhand/commit/1822b40316f550ebf9372d5a9fdca6e24a7be1ad))
* **telemetry:** describe the collector as it runs now ([996fd79](https://github.com/escalay/yardhand/commit/996fd7986cc304ba71728128695de000c3195613))

## [0.2.0](https://github.com/escalay/yardhand/compare/v0.1.0...v0.2.0) (2026-11-11)


### Features

* **deploy:** start on a new server from one cloud-init file ([de1e414](https://github.com/escalay/yardhand/commit/de1e414d137db56e9cccc935926e60ea9405cc10))


### Documentation

* finish the neutral examples, and say how the kit copy is kept ([e83d2bb](https://github.com/escalay/yardhand/commit/e83d2bbb224807ad38688d83a17b5230b55e739b))
* **readme:** draw how it fits together as a diagram ([62e972c](https://github.com/escalay/yardhand/commit/62e972c5535aca10b36623086ef79ee750607d2b))

## 0.1.0 (2026-11-10)


### Features

* Yardhand, a self-hosted gateway for AI agents ([33fcd8d](https://github.com/escalay/yardhand/commit/33fcd8dde2c8358c76080dcdbb26df010357932c))
