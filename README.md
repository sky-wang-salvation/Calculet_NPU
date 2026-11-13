# Calculet_NPU

原粒 NPU 开发者生态挑战的赛题资料与技术调研，帮助团队理解五个选题的实际技术目标，并制定可复现的工程方案。

**[进入完整调研 →](docs/research/README.md)**

本次调研日期为 **2026-11-13（北京时间）**。内容区分材料事实、公开文档事实、分析推断和待验证事项；尚未进行 SDK 安装、编译或 NPU 真机测试，不包含实测性能结论。

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
