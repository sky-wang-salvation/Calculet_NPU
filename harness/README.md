# DeepSeek Harness × Calculet NPU：方案与讨论交接

整理日期：2026-11-14（Asia/Shanghai）。本章节保留需求、讨论、取舍和未定事项；新增可执行插件及本机开发交接。方案讨论与实现验收分别记录。

**用户希望用 DeepSeek Harness 连接不常见的 NPU：调用已部署的多模态模型、利用部署经验协助迁移新模型，并探索反馈学习。用户已经否定将固定安装、部署或“把经验存成 Skill”本身当作主要应用价值。具体面向哪个真实用户任务，仍未最终确定。**

## 目录与运行入口

本目录统一收纳 Harness 相关工程与进展记录：

```text
harness/
├── README.md                      # 总入口与当前状态
├── docs/                          # 方案、决策、进度审查与开发交接
├── plugins/npu-bridge/             # 原生插件源码与测试
├── scripts/                       # 启动器与配置覆盖示例
├── package.json                   # 工作区脚本与依赖
├── package-lock.json              # 锁定依赖版本
└── Start Calculet Harness.command  # macOS 启动入口
```

从仓库根目录执行 `cd harness`，再按[本机开发与验证](docs/local-development.md)安装、构建和启动。npm 命令均在 `harness/` 下运行；本地配置和运行数据放在该目录的 `.local/`，不提交到 Git。模型迁移实验仍从下方模型工程链接进入。

## 阅读顺序

| 文档 | 用途 |
| --- | --- |
| [最新进度 schedule_01](docs/schedule_01.md) | 与插件第一版对比：Windows 运行、异步跟踪、产物展示及 22 项测试结果 |
| [Windows 联调指南](docs/windows-integration.md) | 当前电脑的安装、启动、测试服务与复现步骤 |
| [本机开发与验证](docs/local-development.md) | 已安装版本、启动方法、官方插件开发方式和实际验证范围 |
| [插件源码](plugins/npu-bridge/README.md) | 五项原生工具、配置和测试；包含新增等待工具 |
| [进度审查](docs/progress-review-20261114.md) | 当前 GitHub 模型进度及可接入边界 |
| [后端接口草案](docs/backend-contract.md) | 下一阶段与模型部署团队对接的 HTTP 合同 |
| [需求与工作流程](docs/requirements-and-workflows.md) | 用户要做什么，插件/模型/Skills/NPU 各自负责什么 |
| [讨论记录与方案取舍](docs/discussion-and-decisions.md) | 哪些想法提出过、为何调整、哪些已否定、哪些仍是候选 |
| [场景与验收](docs/scenarios-and-validation.md) | 从用户问题到方案、NPU 核心计算、指标与商业假设 |
| [交接文档](docs/HANDOFF.md) | 下一位协作者从哪里继续，什么结论不能擅自升级 |
| [详细场景表与思维导图](../docs/research/13-scenarios-and-value.md) | 重新对照赛题 PDF 的三场景分析与五题映射 |

## 当前状态

| 项目 | 状态 |
| --- | --- |
| 正式参赛方向 | 原粒企业赛道题五，已有模型迁移记录；具体报名由团队处理 |
| Harness 载体 | 用户明确选择 DeepSeek Harness |
| 当前插件 | Windows 官方宿主已启动验证；五项工具，新增异步等待与测试产物交付；19 项插件测试＋3 项联调测试通过，未接入真实 NPU 模型服务 |
| 连接能力 | 用户说明文本推理与多模态方向都在推进；按实际接口与验收记录接入 |
| 固定部署 Skill/安装包 | 保留为底层工程组件，作为独立应用卖点已被用户否定 |
| 最终用户与场景 | 未决定；脚本分镜、仿真补测、资料助手等均为候选 |
| 反馈学习/RSI | 探索目标，尚无实现、改善或自改进成绩 |
| 商业化 | 未做客户访谈或付费验证，没有价格/市场规模结论 |

## 与模型工程的关系

- [Cosmos 目录与交接](../experiment/COSMOS%203/README.md)：区分 Nano-Sim-Auto 的部署记录和新增 Edge 研究。
- [图像实验目录](../experiment/SD3.5_Medium/)：已由 MiniMax_H3 更名；目前快照仍描述 H3，不能据目录名判断 SD3.5 已运行。
- [赛题原文](../%E8%B5%9B%E9%A2%98%E9%80%89%E6%8B%A9.md)：功能、正确性、NPU 实际贡献与复现要求。

本机已安装官方 Harness 并完成测试服务联调，已取得固定测试图片的预览与下载结果；尚无真实模型生成产物或 NPU 执行结果。未来交付仍需同时证明真实用户任务完成和核心设备执行。
