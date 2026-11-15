# 日新 · NPU 部署翻译官

> 将部署意图转为受约束、可追踪的 NPU 任务。

日新是基于 **DeepSeek Harness** 的原粒 NPU 部署助手，面向希望使用本地 NPU、但不熟悉完整工具链的模型开发者。项目将部署目标整理为结构化任务契约，结合已验证配方组织执行、跟踪状态并交付产物与证据，减少用户反复判断和持续盯守。

**快速阅读：** [项目说明](项目说明.md) · [项目展示与答辩说明](PPT%E2%80%94guide.md) · [模型部署经验](experiment/SD3.5_Medium/model_deploy_experience.md) · [运行与开发](#运行与开发)

## 为什么做这个项目

“把模型部署到 NPU”背后，往往还有许多需要人来判断的问题：

- 环境、组件和 SDK 是否匹配，哪些已有材料可以复用？
- 哪些计算真正进入 NPU，哪些仍由 CPU 承担？
- 任务中断后该继续查询、重新执行，还是先确认设备状态？
- 有了输出，是否就满足数值、质量和交付要求？

日新希望把这些判断中可以明确的部分，沉淀为任务约束、可复用配方和检查规则，让系统在约定范围内推进任务。

## 怎样工作

以下是项目的总体设计，完整自然语言与真实硬件闭环仍待联调验收。

```mermaid
flowchart LR
    A["用户部署目标"] --> B["结构化任务契约"]
    B --> C["能力与约束检查"]
    C --> D["配方与执行计划"]
    D --> E["受控工具与模型适配器"]
    E --> F["状态、产物与执行证据"]
```

**任务契约**明确模型、参数、CPU/NPU 计算范围与验收等级；**配方**记录已经验证的方法及其适用条件；**执行与证据机制**负责说明任务做到哪一步、结果来自哪里，以及哪些项目仍未通过验收。运行环境、资源与授权由可信配置和规则检查，规划模型提出的内容需要经过校验。

一个目标交互示例：

> 按已有 SD3.5 烟雾配方准备并验证一张预览图，允许 CPU/NPU 混合执行，但不能影响共享任务。

系统应先确认配方和执行条件，交付时同时给出任务状态、产物、CPU/NPU 分工和验收证据。这个例子表达目标体验，不代表当前已支持任意自然语言、模型或参数。

## 当前成果与完成度

截至 **2026-11-15**，模型真机记录、公开主线代码和开发版记录分别如下：

| 工作项 | 已有成果 | 当前范围 |
| --- | --- | --- |
| SD3.5 真实 NPU 子图 | 首层 Q 投影返回 `[16,1536]` BF16 输出，并与 CPU 参考比较 | 单个 Linear 子图；正式数值容差尚未验收 |
| SD3.5 混合生图 | 已记录 256×256、4 步预览；每步首层 Q 投影全部 256 行使用 NPU 返回值，共 4 次请求、64 个 tile | Q-only HYBRID；其余主要计算在 CPU，正式画质与完整核心迁移未验收 |
| `main` 中的 Harness 插件 | 5 项原生工具，支持生成提交、状态查询、异步等待与恢复查询；已有 19 项插件测试和 3 项联调测试通过记录 | 使用 simulation 测试服务完成产物预览与下载，真实模型服务待接入 |
| 项目说明记录的开发版 | 9 项工具、任务契约、计划绑定、幂等提交和持久作业；记录了合计 103 项离线/模拟测试通过（含 62 项部署服务测试）及候选包安装验证 | 源码与候选包未随当前 `main` 发布；记录不等于自然语言规划或真实硬件联调通过 |
| Cosmos Nano / Edge | Nano 有历史基础探针与方形因果注意力适配报告；Edge 有架构研究和资源估算 | 完整 rolling 与视频生成未验收，Edge 设备验证未执行 |
| RSI 自进化 | 已有反馈、对照评价与回退的设计方向 | 尚无经验证的学习收益 |

**当前没有可发布的整模型全 NPU 迁移、同条件加速比或能耗结论。** Q 投影计算段的零 CPU 回退，仅说明该计算段，不能外推为整条生成管线都在 NPU。

核对成果可从这些入口开始：

- [SD3.5 运行配置、精度与 CPU/NPU 分工](experiment/SD3.5_Medium/model_deploy_experience.md)。
- [SD3.5 最新模型归档](https://github.com/sky-wang-salvation/Calculet_NPU/blob/c3ac86f8a3e79baa4b4fe5466790e7b090d9776b/experiment/SD3.5_Medium/schedule_07.md)及[脱敏证据索引](https://github.com/sky-wang-salvation/Calculet_NPU/blob/c3ac86f8a3e79baa4b4fe5466790e7b090d9776b/experiment/SD3.5_Medium/ref/progress_20261115/evidence_index.json)：位于独立模型进度分支；扩大 Linear 覆盖仍为候选，完成结果未确认。
- [Cosmos 最新模型归档](https://github.com/sky-wang-salvation/Calculet_NPU/blob/c3ac86f8a3e79baa4b4fe5466790e7b090d9776b/experiment/COSMOS%203/schedule_03.md)：位于同一进度分支。
- [公开插件联调记录](harness/docs/schedule_01.md)与[开发版测试统计及交付范围](项目说明.md)。

## 运行与开发

### 1. 安装并检查公开插件

需要 Node.js **24.9 及以上的 24.x 版本**。以下命令针对当前 `main` 中的 Harness 工作区：

```bash
git clone https://github.com/sky-wang-salvation/Calculet_NPU.git
cd Calculet_NPU/harness
npm ci --cache .local/npm-cache
npm run build
npm run typecheck
npm test
npm run test:integration
```

这些检查验证公开插件与测试服务，不连接 NPU，也不运行生成模型。

### 2. 体验本地任务联调

在同一 `harness/` 目录执行：

```bash
npm run harness:test-service
```

打开 [本地联调台](http://127.0.0.1:3081/)，可查看任务提交、等待、失败、刷新恢复，以及测试图片的预览和下载。

该服务始终为 **simulation**：返回带 TEST 标记的固定 PNG，不加载模型。任务保存在内存中，服务重启后清空；停止等待不会取消后台任务。

### 3. 接入官方 Harness 或真实模型

- **安装宿主插件：** 按[本机开发指南](harness/docs/local-development.md)或[Windows 联调指南](harness/docs/windows-integration.md)初始化专用 profile。现有指南采用 pnpm 11.28.5；`--from-default-profile` 仅用于首次初始化。
- **启动宿主：** 初始化后在 `harness/` 下执行 `npm run harness`。自然语言工具选择还需要配置规划模型，并单独验证。
- **对接模型服务：** 按[后端接口合同](harness/docs/backend-contract.md)实现能力查询、提交、状态查询与产物访问，再配置本地后端地址。真实任务需要模型材料、适配器和设备使用条件就绪。
- **模型复现：** 阅读[模型部署经验](experiment/SD3.5_Medium/model_deploy_experience.md)。公共仓库不包含完整模型接入程序、权重、厂商 SDK 或原始设备材料，克隆仓库不能直接复现真机生图。

服务地址与令牌放在本地配置中，不提交到仓库。更换模型或参数时，重新核对组件、shape、精度和支持范围。

## 文档导航

| 你想了解什么 | 阅读入口 |
| --- | --- |
| 项目定位、贡献与交付范围 | [项目说明](项目说明.md) |
| 总体架构、展示方式与答辩依据 | [项目展示指南](PPT%E2%80%94guide.md) |
| 原生插件工具、配置与源码 | [NPU Bridge](harness/plugins/npu-bridge/README.md) |
| 当前公开插件的实现与联调进度 | [Harness 进度](harness/docs/schedule_01.md) |
| 模型服务如何对接插件 | [后端接口合同](harness/docs/backend-contract.md) |
| 下载、环境隔离、适配、数值比较与模型复现 | [模型部署经验](experiment/SD3.5_Medium/model_deploy_experience.md) |
| 实验执行方法与工具链操作 | [实验指南](experiment/02-guide.md)、[NPU 操作手册](experiment/03-NPU-guide.md) |
| Cosmos 型号、研究和历史部署记录 | [Cosmos 入口](experiment/COSMOS%203/README.md) |

历史文档保留各自记录时点；当前定位以本页及最新展示指南为准，功能是否可运行以对应分支代码和同版本验收记录为准。

## “日新”的下一步

- **能力日新：** 扩大经过验证的 NPU 计算范围，逐步让兼容 Agent 发现并复用新能力。
- **流程日新：** 将部署经验变为带条件的配方，完成真实模型与 Harness 的统一调用链验收。
- **体验日新：** 用固定标准和保留任务对比新旧策略，验证反馈能否减少重复纠错，并支持版本回退。

这些是后续方向。项目当前优先完成一个固定配置、可追踪、可验收的真实部署任务。

## 基础平台与贡献

项目基于 DeepSeek Harness、原粒 NPU 工具链及 SD3.5 / Cosmos 等上游模型。团队工作集中在原生插件、任务与接口合同、执行状态机制、模型专用接入和证据化验证；模型、SDK 与硬件的原有贡献归各自上游。
