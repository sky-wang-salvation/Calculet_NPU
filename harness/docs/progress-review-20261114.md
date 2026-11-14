# GitHub 进度审查：2026-11-14

审查对象：`sky-wang-salvation/Calculet_NPU` 的 `main`，提交 `f84c70e2c9319738a63d60823a0bf249b9a492bd`。仅根据远端提交和文档判断，不包括队员未提交的代码、本机测试或设备上的实时状态。

本次查询未发现开放的 Issues/PR 条目，任务进度主要由编号 schedule 文档承载；不能把没有 Issues 当作没有剩余工作。

**现有仓库证明了一些 NPU 基础链路与局部计算进展，但尚不能把任一完整生图/视频模型注册成 Harness 的可用能力。** 用户说明模型部署仍在本地测试，与此证据边界一致。

| 工作线 | 仓库证据 | 不能据此宣称 | 对插件的影响 |
| --- | --- | --- | --- |
| 图像迁移 | `SD3.5_Medium` 的三份编号快照；最新内容仍是 H3-Image 内存/可运行性核查 | SD3.5 已部署；H3 全流程出图 | 不预置可用模型；等待实际能力声明 |
| Cosmos Nano-Sim-Auto | schedule_02 记录 BF16 2 KiB 回传、六项原始探针通过；方形 causal attention 的适配探针有设备执行记录（84 次 launch、该探针无 CPU fallback） | 完整 rolling/video 已生成；所有子图没有 CPU 回退 | 仅为接入准备，不能开放完整视频生成 |
| Cosmos3-Edge 4B | 独立研究包、算子缺口和资源估算脚本 | 已编译、已推理、已真机验证 | 保留为研究候选；和 Nano 分开 |
| DeepSeek Harness | 此前提交是方案与讨论归档 | 当时已有可执行插件或反馈学习 | 本次开始独立插件实现和本机验证 |

## 目录名与内容的差异

[重命名提交 d24a840](https://github.com/sky-wang-salvation/Calculet_NPU/commit/d24a840b9c7d347ddbd52177b8ef6f33c23f24ed) 仅将图像项目目录由 `MiniMax_H3` 移到 `SD3.5_Medium`，保留原快照内容。现有 Harness 文档仍指旧目录，已修正入口。下一份 SD3.5 实验记录应写清选定模型版本、新迁移路径、实际运行阶段和结果，保留历史快照。

## 当前最有用的工程交接

| 优先级 | 下一份可验证成果 | 完成依据 |
| --- | --- | --- |
| 先做 | 模型团队提供一个能完整运行的原生入口 | 固定模型/SDK/设备/输入，有真实产物、错误边界和执行记录 |
| 接着 | 在该入口外包一层异步服务 | 能力、任务、状态、产物接口与真实入口一致 |
| 然后 | Harness 工具完成一次端到端任务 | 使用真实服务和产物，明确 CPU/NPU 分工 |
| 再做 | 面向具体用户的反馈改进 | 两次任务的指标、改变的状态、可回退证据 |

本次插件不执行模型下载、安装、刷写、远程 SSH 或训练。部署 Skills 待模型团队将亲测步骤提供后再接入；静态安装配方仍作为工程支撑。特别激励对应的真实用户任务、反馈指标和回退演示仍未确定。

依据：[审查提交](https://github.com/sky-wang-salvation/Calculet_NPU/commit/f84c70e2c9319738a63d60823a0bf249b9a492bd)、[图像最新快照](https://github.com/sky-wang-salvation/Calculet_NPU/blob/f84c70e2c9319738a63d60823a0bf249b9a492bd/experiment/SD3.5_Medium/schedule_03.md)、[Nano 最新快照](https://github.com/sky-wang-salvation/Calculet_NPU/blob/f84c70e2c9319738a63d60823a0bf249b9a492bd/experiment/COSMOS%203/schedule_02.md)、[Edge 研究](../../experiment/COSMOS%203/research/cosmos3_edge_npu_20261114/README.md)。
