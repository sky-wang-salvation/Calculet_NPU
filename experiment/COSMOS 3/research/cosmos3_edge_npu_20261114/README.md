# Cosmos3-Edge → 原粒 Calculet NPU 移植调研

调研日期：2026-11-14（Asia/Shanghai）。

**先看 [详细调研报告](调研报告.md)**。结论：模型是 Cosmos3-Edge（4B）；硬件容量不足并非已经确定的阻碍，当前主要风险是模型语义、视觉/多行计算、图接入、权重布局和真机执行链。比赛优先实现真实 Edge 子图的 NPU 适配，完整视频生成另设阶段门槛。

配套材料：

- [算子与支持差距表](operator_support.csv)：每一项需要什么证据。
- [资源估算脚本](estimate_resources.py)与[计算结果](resource_estimates.json)：配置驱动，只是容量/复杂度估算。
- [来源与版本清单](evidence_manifest.json)：比赛资料、公开文档、配置和上游代码的研究快照版本及哈希。
- [官方架构图](https://raw.githubusercontent.com/NVIDIA/cosmos/540106233a1a834f00fddd368dd6e3e818575696/docs/assets/cosmos3-model-architecture.png)。

本次没有安装 Calculet SDK，没有下载整套模型权重，没有执行 NPU kernel，没有取得 NPU 性能或兼容性结果。公开源码仅用于阅读。`sources/` 是本地核查缓存，其中 SDK 文档的再分发许可尚未核实，不应直接将整个资料目录公开上传。

原调研包保持不变；公开版位于本仓库 Cosmos 3 的 research 子目录。既有 schedule 进度快照独立保留。

## 阅读与交接

- [Cosmos 3 总入口](../../README.md)
- [交接文档：模型范围、证据状态与下一步](../../HANDOFF.md)
- [第三方来源索引](SOURCE_REFERENCES.md)：仅提供原始链接和缓存哈希，不附第三方源码、架构图或论文副本。
- [资源估算输入](estimator_inputs.json)：从原配置提取的必要数值，与完整上游配置分开。
- [公开版校验记录](validation_report.json)
- [DeepSeek Harness 方案章节](../../../../docs/harness/README.md)

## 无第三方缓存时复算

```bash
python3 estimate_resources.py
```

脚本仅使用 Python 标准库和同目录 `estimator_inputs.json`，从任意工作目录执行都读取脚本所在目录；覆盖同目录 `resource_estimates.json` 并打印估算结果。它不联网、不安装 SDK、不加载模型，也不访问 NPU。

公开版脚本与原包相比只调整配置输入位置，公式未变；复算 JSON 与原包结果逐字段一致。单个张量大小与 FLOPs 都不是实测峰值内存、延迟或性能承诺。

本调研**尚未进行 NPU 编译、模型推理或真机测试**。该边界只描述此研究包，不否定其他 schedule 中独立报告的设备实验。
