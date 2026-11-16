# schedule_01｜服务器断连期间的项目总进度快照

记录日期：2026-11-16（Asia/Shanghai）。范围：SD3.5 Medium 生图迁移、DeepSeek Harness 接入及现有验证边界。

**当前 NPU 服务器无法连接；这是本次操作者提供的状态，本轮未尝试重连，未执行新的模型推理或设备操作。最高已归档成果是 Q-only CPU/NPU HYBRID 生图，不是全模型 NPU 部署完成。**

本文件直接保存在 `experiment/` 根目录，作为跨模型部署与 Harness 工作线的总进度快照。模型子目录中的既有 `schedule_XX.md` 保留原文；本次不合并其他分支、不补写历史成功结果，也不更改旧实验的验收等级。

## 1. 当前状态总览

| 工作项 | 已有成果 | 当前边界 |
| --- | --- | --- |
| 目标模型 | `stabilityai/stable-diffusion-3.5-medium`，revision `b940f670f0eda2d07fbb75229e779da1ad11eb80` | 不再以历史 MiniMax 目录记录代表当前模型；不是 SD3.5 Large。 |
| 本地 SDK 与构建链 | 已记录 tiny 编译、CPU 参考、CalVX 生成、docc 原生打包和 doctor 检查。 | 构建、打包成功不等于模型已经在 NPU 执行。 |
| 真实模型 Q 投影 | 已有一次真实 NPU 输出及与 PyTorch BF16 参考的误差比较。 | 只是 `transformer_blocks.0.attn.to_q`；正式数值容差尚未批准。 |
| 历史完整生图流程 | 已归档一张真实 SD3.5 Medium 四步混合生成 PNG。 | 每步仅首层 Q 投影使用 NPU，其余主要模型计算仍在 CPU。 |
| 更大范围迁移 | 已有 392 个 Linear 候选清点与候选实现。 | 最终运行、实际覆盖与产物仍为 `UNKNOWN`，不能按候选数量声称迁移成功。 |
| 静态 calbin 路线 | 原生产物可以生成，结构硬性检查通过。 | `BLOCKED_NATIVE_IO_DOUBLE_BUFFER` 未解除；eager 路线成功不代表此问题已修复。 |
| Harness 插件 | `dsh-sn4ck@0.2.0` 已发布，生成与部署共九项工具已有实现。 | 安装、工具注册和离线协议通过，不代表真实模型服务已接入验收。 |
| 模型服务薄桥 | 已有通用 request/result 薄桥和离线交接检查。 | 新桥真机闭环 `NOT_RUN`，当前不具备新一轮真实联调条件。 |
| 服务器与设备现状 | 当前服务器无法连接。 | 断连原因、设备占用、遗留任务和资源释放情况未知，不能推定设备空闲。 |

## 2. 已归档实验成果

### 2.1 本地工具链与原生构建

[01-setup.md](01-setup.md) 保存了从环境准备到 tiny 原生包静态检查的过程，包括 Rust 安装排障、三库平级布局、测试权重、CPU 参考以及带 `step` 的完整程序编译。

真实 SD3.5 Q 投影后续已完成权重提取、CPU 参考及离线编译打包。原生包中两个 I/O 张量的 ping/pong 地址仍分别重合，因此静态路线保持阻塞；不能手改清单地址或只运行一次来宣布问题解决。

此前已用文本与二进制 CalVX 输入分别重生成原生包，仍未解决布局问题。已确认的是 CalVX 声明到原生产物的结果差异；内部解析、分配或导出哪个环节导致问题，尚未确定。

### 2.2 首个真实 NPU Q 投影

[已合入 main 的 schedule_06](SD3.5_Medium/schedule_06.md) 记录了独立 TorchDope eager → `dort` 路线，不是受阻静态 calbin 的运行结果。

| 项目 | 归档结果 |
| --- | --- |
| 数学与参数 | 真实模型参数，`Y = X @ W.T + b` |
| 形状、类型 | `M=16, K=N=1536`，BF16，小端 |
| 实际输出 | `[16,1536]`，24,576 个元素、49,152 字节，全部有限 |
| 与参考逐位不同 | 3 个元素；不满足全量逐位相等 |
| 最大绝对误差 | `0.000244140625` |
| RMSE | `1.557344391530825e-06` |
| 最大 BF16 ULP 距离 | `4` |
| Q 计算段回退 | 归档记录报告 CPU fallback 与 host implementation 均为 0 |
| 正式数值验收 | `METRICS_ONLY / NOT_EVALUATED_NO_APPROVED_TOLERANCE` |

零回退只针对所记录的 Q 设备计算段，不代表整条应用不使用 CPU。比较工具本身不证明输出来自设备，来源判断仍需结合执行记录与相同输出摘要。

### 2.3 历史 Q-only HYBRID 四步生图

后续模型成果位于待审分支的 [schedule_09 固定版本](https://github.com/sky-wang-salvation/Calculet_NPU/blob/7fca842f9086b2445e73ef42e55ac681146d7824/experiment/SD3.5_Medium/schedule_09.md)。该记录包含历史原始 PNG 及精选脱敏摘要；本次未新增图片。

```text
两个真实 CLIP 文本编码器（CPU；不加载 T5）
  ↓
每个去噪步的真实隐藏状态
  ↓
首层 block0.attn.to_q（NPU）
  ↓ 返回的 Q 实际进入 Attention 与后续去噪
其余 DiT、scheduler（CPU），共四步
  ↓
VAE（CPU）→ 256×256 PNG
```

| 固定配置 | 已记录取值 |
| --- | --- |
| prompt | `A red apple on a wooden table, soft natural window light, realistic photograph` |
| seed / batch | `20261115` / `1` |
| 分辨率 / steps / guidance | `256×256` / `4` / `1.0` |
| 文本配置 | 保留两个真实 CLIP；不加载 T5；`max_sequence_length=64` |
| NPU 工作 | 四次真实 Q 请求，每次 16 个 M16 tile，共 64 个 tile |
| 完整生成流程 | 已完成该固定配置的混合生成，`coreMigrationComplete=false` |
| 图片性质 | 低步数烟雾预览，苹果可辨但模糊；不是正式画质基准 |

[查看历史原始 PNG](https://github.com/sky-wang-salvation/Calculet_NPU/blob/7fca842f9086b2445e73ef42e55ac681146d7824/experiment/SD3.5_Medium/ref/experiment_results_20261115/hybrid_generation/sd35-medium-hybrid.png) · [生成及 CPU/NPU 分工摘要](https://github.com/sky-wang-salvation/Calculet_NPU/blob/7fca842f9086b2445e73ef42e55ac681146d7824/experiment/SD3.5_Medium/ref/experiment_results_20261115/hybrid_generation/result.summary.json)

本轮仅从已取得的 Git 对象核对 PNG 的文件头、尺寸及 SHA-256：86,885 字节，`256×256`，摘要与生成摘要一致：

```text
40c42cc65c16dede5a84226692e0a983d68f948298bc0a5ba8dd603811f6258d
```

该核对证明归档图片字节与已发布摘要一致，不是重新生成，也不构成新的独立硬件认证。

### 2.4 CPU、计时与覆盖范围

| 指标 | 能确认的内容 |
| --- | --- |
| CPU 执行部分 | 两个 CLIP、除首层 Q 外的其余 DiT、scheduler、VAE，以及边界转换和传输组织。 |
| 历史生成主进程峰值 RSS | `18,814,324 KiB`，约 `17.94 GiB`；不是系统总内存或远端 worker 总内存。 |
| CPU 线程 | 执行源码配置 PyTorch 算子内线程为 `8`；不是实测始终占满 8 个物理核。 |
| 历史完整请求墙钟 | `99.7984737969964` 秒，包含加载、CPU、NPU、传输和收尾；不是纯 NPU 推理时间。 |
| 编译、加载、预热、纯 NPU 计算各阶段时间 | 本快照没有可分别引用的测量，记为未测。 |
| CPU 利用率、CPU/NPU 时间或算量占比 | 未测，不给百分比。 |
| 加速比、完整模型质量 | 未验收。 |

不能用 `1/392`、请求数量或单层逻辑计算量推算 NPU 占全模型计算的比例。当前里程碑是局部 NPU 计算真实接入完整生成链，不是完整核心迁移完成。

## 3. DeepSeek Harness 与服务接入进度

[Harness 当前说明](../harness/README.md) 和 [部署验收合同](../harness/docs/deployment-acceptance.md) 将支持范围限定为固定 SD3.5 首层 Q 投影 HYBRID 烟雾配置。

| 层次 | 当前进展 | 尚未证明 |
| --- | --- | --- |
| 插件发行 | `dsh-sn4ck@0.2.0`；已有 npm 与 GitHub Release 安装说明及安装验证记录。 | 不等于插件已能调用当前真实 NPU 服务。 |
| 原生工具 | 五项生成工具、四项部署工具；包含计划、应用、状态、等待和产物查询。 | 不等于自然语言规划模型实际选工具并完成全流程。 |
| HTTP 与部署服务 | 仓库已有能力/生成/查询合同及 TaskSpec、异步计划、执行、持久任务和证据校验等实现。 | 已有实现不能证明服务在目标服务器上线或完成硬件验收。 |
| 服务离线验证 | 仓库归档 62 项部署服务测试通过，明确标记 `simulation`、`hardwareAccessed=false`。 | 不计作 NPU 推理或真实生图次数。 |
| 模型服务薄桥 | 归档有 31 项离线检查、17 项请求侧补充验收。 | 两组有重叠且实际 NPU 调用为 0；新桥真机闭环仍 `NOT_RUN`。 |
| 公开薄桥复跑 | 原发布记录为 30 项执行通过、1 项外部生产校验器检查跳过。 | 不能把公开复跑改写成新的 31/31 或完整真机联调。 |

薄桥固定配方尚不支持任意 prompt、seed 或全 NPU 要求；不匹配输入应明确拒绝，不静默换成 CPU、simulation 或历史图片。

预期链路仍是：

```text
Harness 原生工具
  → 团队服务：TaskSpec / 计划 / 异步任务
  → 已绑定身份和环境的真实模型适配器
  → 新一次获授权的 NPU 执行 + 明确的 CPU 部分
  → 新鲜图片、执行证据与结果
  → Harness 查询并展示
```

历史生成成功与离线协议通过，不能拼接成同一次 Harness→服务→模型→NPU 的真实闭环。`hardware` 字段、文件哈希或安装成功也不能替代实际设备执行证据。

## 4. 当前阻塞与未知事项

| 类别 | 现状 | 能确认与不能确认的边界 |
| --- | --- | --- |
| 访问阻塞 | 操作者报告当前无法连接 NPU 服务器。 | 本轮未复测连接；网络、服务器、认证或其他原因均未确定。 |
| 设备遗留状态 | 392 Linear 扩大版的运行结局与释放状态未知。 | 不宣称任务已成功、失败、停止或资源已释放。 |
| 全模型迁移 | 最高确认成果仍为 Q-only HYBRID。 | 完整 Attention/DiT 及其他主要计算的 NPU 覆盖尚未验收。 |
| 静态导出 | 双缓冲布局阻塞未解决。 | 不将 eager 成功当作原生 calbin 修复。 |
| 新桥运行前提 | 真实 worker、受控材料、环境身份、锁拓扑和新设备窗口仍需现场核对。 | 离线包或历史许可不自动提供新的运行条件。 |
| 真实服务联调 | 当前服务器不可达，且缺少新桥同次执行的完整验收包。 | 当前不能开始真实联调；可继续离线文档、合同与产物核对。 |
| 正式验收 | 数值容差、图像质量与可比性能均未完成。 | 不由误差较小、PNG 存在或测试数量推定通过。 |

## 5. 恢复连接后的优先顺序

以下是后续操作计划，**本轮均未执行**。

| 优先级 | 操作 | 通过条件 |
| --- | --- | --- |
| P0 | 由设备负责人恢复访问并确认使用窗口；先只读核查设备占用与扩大版遗留任务。 | 连接可用、资源归属与任务状态明确；不得因没有锁文件就判断空闲。 |
| P1 | 核对运行时、模型组件、worker、适配器身份和实际锁拓扑，保留旧版本。 | 本轮请求绑定与现场文件一致，不改共享 SDK/驱动来绕过问题。 |
| P2 | 使用原生入口复验固定 Q-only HYBRID 基线，记录新请求与新输出。 | NPU 返回值实际参与去噪，图片来源和 CPU/NPU 范围明确，失败时保留日志。 |
| P3 | 用同一固定配置完成 Harness→服务→薄桥→真实模型的新一轮闭环。 | 计划、作业、实际参数、输出、设备记录及产物读取可对应同一次运行；不能复用旧 PNG 冒充。 |
| P4 | 确认 392 候选的实际运行结果，再按模块扩大核心 NPU 覆盖。 | 每项都有真实模块、shape、dtype、数值比较与执行记录，不按候选数量验收。 |
| P5 | 批准数值/画质标准，建立分阶段计时，正确性基线成立后优化。 | 编译、加载、预热、传输、计算和端到端计时分别记录，有可比条件。 |

需要修复静态 calbin 路线时，应沿最小复现与对应后端定位；不修改历史包、清单地址、校验和或锁文件来消除表面告警。

## 6. 证据来源与分支状态

本次整理时核对的 `main` 为 `5f564205aa49a46144171c1b9b372a48e97f1503`。其中 `schedule_06` 已记录首个真实 Q 输出；更晚的历史生图、通用薄桥和原图位于提交 `7fca842f9086b2445e73ef42e55ac681146d7824`，对应的 [模型进度 PR](https://github.com/sky-wang-salvation/Calculet_NPU/pull/1) 在核对时仍为 OPEN，尚未合入 `main`。

本快照使用固定提交链接引用这些已公开成果，不代为合并该 PR。读者只查看 `main` 时，应同时注意这里的来源分支，而不是把旧快照中“尚未出图”的历史状态当作后续实验的最终结论。

| 资料 | 用途 |
| --- | --- |
| [环境与 tiny 过程](01-setup.md) | 编译、CPU 参考、打包、静态检查及新手步骤。 |
| [团队协作指南](02-guide.md) | 本地与真机分工、先跑通后优化的方法。 |
| [真实 Q 投影进度](SD3.5_Medium/schedule_06.md) | 首个真实设备输出及未正式验收的数值指标。 |
| [固定版本 schedule_08](https://github.com/sky-wang-salvation/Calculet_NPU/blob/7fca842f9086b2445e73ef42e55ac681146d7824/experiment/SD3.5_Medium/schedule_08.md) | 薄桥离线交付、门禁及未完成前提。 |
| [固定版本 schedule_09](https://github.com/sky-wang-salvation/Calculet_NPU/blob/7fca842f9086b2445e73ef42e55ac681146d7824/experiment/SD3.5_Medium/schedule_09.md) | 原始图片、CPU 使用说明与逐实验成果。 |
| [生成后端合同](../harness/docs/backend-contract.md) | 团队 HTTP 接口，不是厂商 SDK 自带端点。 |
| [部署集成合同](../harness/docs/deployment-integration-contract.md) | TaskSpec、计划、任务与适配器交接。 |
| [归档服务测试清单](../harness/deployment/verification/manifest.json) | 62 项 simulation 测试的执行范围，明确无硬件访问。 |

公开快照不包含密码、Token、私有服务器地址、设备身份、模型权重、厂商 SDK 或受控执行 payload。本轮仅检查已有 GitHub/Git 资料与归档图片字节，没有进行 SSH、设备查询、模型加载、生图或新的性能测试。

**阶段结论：历史局部 NPU 参与的混合生图已有成果，插件发行和服务离线准备已有进展；当前服务器不可连接，新桥真实联调和完整核心 NPU 迁移仍未完成。**
