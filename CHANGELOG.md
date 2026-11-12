# Changelog

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
