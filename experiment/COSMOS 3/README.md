# Cosmos 3：进度、调研与交接

本目录包含不同目标型号和不同证据阶段。先读 [HANDOFF.md](HANDOFF.md)，避免把文献研究、基础算子验证和完整模型推理合并成一个“已跑通”结论。

| 材料 | 目标与用途 | 证据范围 |
| --- | --- | --- |
| [schedule_01](schedule_01.md) | 原有 Cosmos 部署的第一份阶段快照 | 保留当时状态，后续不回写 |
| [schedule_02](schedule_02.md) | Cosmos3-Nano-Sim-Auto，原粒题五 | 已记录执行侧的基础运算、数据往返和方形因果注意力测试报告；完整 rolling/视频未验收 |
| [Cosmos3-Edge 调研包](research/cosmos3_edge_npu_20261114/README.md) | 新增 Edge 4B 的源码/配置研究、算子缺口和资源估算 | 尚未进行 NPU 编译、模型推理或真机测试；估算脚本可离线复算 |
| [DeepSeek Harness 方案章节](../../docs/harness/README.md) | Agent 到 NPU 的桥梁、用户场景、反馈学习和方案取舍 | 设计讨论；不代表插件或应用已经实现 |

Edge 调研提出 FFN/mRoPE 子图路线作为工程建议，不自动更改团队既有整模型目标或参赛合同。Nano 与 Edge 的参数、权重、工作流和测试结论分别记录。

本次公开整理不包含原研究包的 `sources/` 第三方缓存，原图、论文与源码通过 [来源索引](research/cosmos3_edge_npu_20261114/SOURCE_REFERENCES.md)访问。
