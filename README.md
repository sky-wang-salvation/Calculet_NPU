# Calculet_NPU

原粒 NPU 开发者生态挑战的赛题资料与技术调研，帮助团队理解五个选题的实际技术目标，并制定可复现的工程方案。

**[进入完整调研 →](docs/research/README.md)**

调研部分的基线日期为 **2026-11-13（北京时间）**，区分材料事实、公开文档事实、分析推断和待验证事项；当日尚未进行 SDK 安装、编译或 NPU 真机测试。后续插件发行状态见下节，模型实验状态以各自 schedule 为准，不能把安装验证当作实测性能结论。

## DSH-SN4CK：可直接安装的 DSH 插件

**DSH-SN4CK**（npm 包名 `dsh-sn4ck`，版本 `0.2.0`）将受控 Calculet NPU 后端的生成、部署计划、异步作业和证据查询暴露为九项 DeepSeek Harness 原生工具。采用官方 Cordis Bundle，不修改宿主 Agent 循环，也不需要消费者编译 TypeScript。

### Quick Start：从 GitHub Release 安装

前提：Node `>=24.9.0 <25`，已有官方 DSH 及其可用的 pnpm 插件安装器。本轮验证宿主为 `@deepseek-ai/dsh@0.2.2-rc.3`；peer 依赖按要求声明为 `*`，不代表所有其他宿主版本均已验证。

[下载 v0.2.0 Release](https://github.com/sky-wang-salvation/Calculet_NPU/releases/tag/v0.2.0)，或直接安装预编译归档：

```bash
dsh plugin --profile web add https://github.com/sky-wang-salvation/Calculet_NPU/releases/download/v0.2.0/dsh-sn4ck-0.2.0.tgz --ignore-scripts
```

```bash
dsh --profile web --dump-config
```

预期包含 `# == dsh-sn4ck`、`id: sn4ck` 和 `name: dsh-sn4ck`。`web` 是目标 profile 示例；使用其他 profile 时替换名称。安装到一个 profile 不会自动修改其他 profile。已有 Desktop profile 的管理应遵守官方“先初始化、完全退出再修改”的要求。

也可下载 `.tgz`、`.sha256`、`.manifest.json`，校验摘要后在归档所在目录本地安装：

```bash
dsh plugin --profile web add ./dsh-sn4ck-0.2.0.tgz --ignore-scripts
```

`.tgz` 是 npm 可安装的 gzip tar 归档，Release 另提供相同字节的 `.tar.gz` 别名。不要使用 GitHub 自动生成的源码 zip 代替插件资产；本仓库是多目录工程，根目录不是插件包，因此 `github:sky-wang-salvation/Calculet_NPU#v0.2.0` 不是本版支持的安装入口。

### npm 安装状态

本轮只发布 GitHub Release，**没有执行 npm publish**。以下命令仅在团队另行获准并完成对应 npm 版本发布后才可使用，不是当前可用的下载入口：

```bash
dsh plugin --profile web add dsh-sn4ck@0.2.0 --ignore-scripts
```

### 配置、能力与安全边界

- [插件功能、配置 Schema 与使用示例](harness/plugins/npu-bridge/README.md)
- [从新环境安装、升级旧包和隔离验收](harness/docs/plugin-installation.md)
- [开发、构建与测试](harness/README.md)

安装完成时默认 `backendURL` 为空，`npu_status` 明确返回未接入；没有真实适配器的服务返回 `blocked / ADAPTER_NOT_CONFIGURED`。这不是安装失败，也不是已完成真机部署。插件不会下载 SDK/权重、抢占共享设备或把 simulation 图片计为 NPU 成绩。

MIT 仅适用于本项目原创插件及随包原创通用运行时代码，详见 [LICENSE](harness/plugins/npu-bridge/LICENSE) 和 [许可范围说明](harness/plugins/npu-bridge/NOTICE.md)。赛题资料、厂商文档、第三方依赖、SDK、权重和私有交接材料不因此被重新许可。

## 五题的技术主线

| 选题 | 主要解决什么 | 深入阅读 |
| --- | --- | --- |
| 融合算子 | 减少中间读写与调度开销，让图采用高效实现 | [题一](docs/research/04-track1-fusion.md) |
| 选择与采样 | 补齐生成循环中的选择、概率过滤与抽样 | [题二](docs/research/05-track2-sampling.md) |
| 模型特性适配 | 保持位置编码、mask、归一化等模型语义 | [题三](docs/research/06-track3-adaptation.md) |
| 本地检索与重排 | 用质量和端到端指标验证应用价值 | [题四](docs/research/07-track4-retrieval.md) |
| 开放题 | 新模型、视觉/多模态、前端桥接和开发工具 | [题五](docs/research/08-track5-open.md) |

## 优先阅读

- [SDK 现状](docs/research/03-sdk.md)：Rust、CalVX、docc、dort；原有模板与真实缺口；公开页面和 PDF 的路线差异。
- [硬件核查](docs/research/02-hardware.md)：TOPS 口径、主机与设备内存、树莓派 PCIe、单/双芯粒比较。
- [选题决策](docs/research/09-selection.md)：按团队能力和已验证基线收敛目标。
- [验收方法](docs/research/10-evaluation.md)：正确性、计时边界、随机性测试、NPU 贡献与能耗。
- [工程师确认清单](docs/research/11-questions.md)与[全部来源](docs/research/12-sources.md)。

## 原有赛题资料

- [赛题选择](赛题选择.md)
- [选手快速开始](Calculet%20NPU%20黑客松%20·%20选手快速开始.md)
- [BoHack 2026 赛道和赛题设置](BoHack%202026%20赛道和赛题设置/BoHack%202026%20赛道和赛题设置.md)
- [用户提供的原粒赛题 PDF](docs/assets/challenge.pdf)
- [附件清单与 SHA-256](docs/assets/manifest.json)

## 可直接填写的模板

- [选题卡](templates/project-proposal.md)
- [实验报告](templates/experiment-report.md)
- [性能结果表头](templates/benchmark-results.csv)

调研引用公开 SDK 文档，但不镜像 SDK 源码或二进制。链接到 GPU/通用框架的资料用于学习算法与验证方法，不代表这些框架已支持原粒 NPU。现场规则、接口、模型和工具链版本以比赛确认的组合为准。

## 2026-11-14 新增：Cosmos 研究与 Harness 方案

- [Cosmos 3 总入口](experiment/COSMOS%203/README.md)与[交接文档](experiment/COSMOS%203/HANDOFF.md)：区分 Nano 部署记录和 Edge 研究。
- [Cosmos3-Edge 调研包](experiment/COSMOS%203/research/cosmos3_edge_npu_20261114/README.md)：报告、算子表、可独立复算的资源估算、来源与版本记录。
- [DeepSeek Harness 方案章节](harness/README.md)与[讨论和取舍](harness/docs/discussion-and-decisions.md)：需求、候选场景、已否定方向、当前结论与待办。
- [DSH-SN4CK 插件](harness/plugins/npu-bridge/README.md)与[发行安装说明](harness/docs/plugin-installation.md)：九项原生工具，提供预编译 Release 归档和可复核的安装证据；真实 NPU 服务及适配器授权另行配置。
- [用户场景与 NPU 价值图](docs/research/13-scenarios-and-value.md)：从用户任务对应问题、方案、核心计算与验收。

新增研究包尚未进行 NPU 编译、模型推理或真机测试；资源估算是公式计算。其他实验的状态以各自 schedule 快照为准。Harness 新增插件基础实现与本机验证，没有完成 NPU 推理或自进化验收。
