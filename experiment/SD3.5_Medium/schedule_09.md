# schedule_09｜逐实验成果总结、原始生成图片与 CPU 使用说明

归档日期：2026-11-15。承接 [schedule_08](schedule_08.md)，本次按实际实验整理结果，并新增公开已生成的原始图片、通用服务薄桥及精选脱敏记录；不改写历史快照，不新增推理，不将离线检查当作硬件验收。这里只记录现有材料支持的结论，不为每项实验补造指标。

## 1. 成果一览

| 单独实验 | 已有成果 | CPU / NPU 实际范围 |
| --- | --- | --- |
| 真实 Q 投影单元 | 取得真实 NPU 输出，完成与已保存 PyTorch BF16 参考的数值比较。 | NPU 计算一个 `[16,1536]` Q 输出；CPU 负责准备、传输与比较。 |
| 联合 Attention CPU 图与边界测试 | 历史 32 项 CPU 测试通过，验证 RMS 顺序、布局、分路输出及检查工具边界。 | CPU 测试，不是联合 Attention 的 NPU 实测。 |
| Q-only HYBRID 生图 | 真实四步生成，原始苹果 PNG 现已附上。 | 每步首层 Q 投影用 NPU；CLIP、其余 DiT、scheduler、VAE 等仍用 CPU。 |
| 392 Linear 扩大覆盖 | 已有候选清点和实现，运行结局仍为 `UNKNOWN`。 | 不能据候选数量宣称实际覆盖；没有已确认的扩大版图片。 |
| 服务薄桥与接管 | 通用代码、示例、归档包，以及 31 项检查和 17 项请求验收。 | 均为离线协议工作，实际 NPU 调用为 0。 |

本次公开材料不含模型权重、厂商 SDK、受控执行 payload、凭据、私有配置或原始设备日志。通用薄桥引用的受控 handoff 仍须由获授权操作者另行提供；公开这些成果不推定第三方材料的再分发许可。

## 2. 实验：真实 Q 投影单元

**目标：** 使用 SD3.5 Medium 的真实 `transformer_blocks.0.attn.to_q` 参数，在 NPU 执行 `Y = X @ W.T + b`，与独立的 PyTorch BF16 计算参考进行比较。

| 项目 | 已记录结果 |
| --- | --- |
| shape / dtype | `M=16, K=N=1536` / BF16 |
| 执行路线 | TorchDope eager → `dort`；不是受阻静态 calbin 的执行结果 |
| 输出 | `[16,1536]`，24,576 个元素、49,152 字节，全有限 |
| 逐位比较 | 24,573 个相同、3 个不同；**不满足全量逐位一致** |
| 最大绝对误差 | `0.000244140625` |
| RMSE | `1.557344391530825e-06` |
| 最大 BF16 ULP 距离 | `4` |
| 设备计算段回退 | CPU fallback=0、host implementation=0；历史记录为正常关闭 |

比较使用已保存的 PyTorch 参考，本次不重算参考。原比较工具只比较字节/数值，不独立证明输出来自设备；设备来源须与运行记录及相同输出 SHA-256 对应。没有预先批准的数值容差，因此结论保留为 `METRICS_ONLY / NOT_EVALUATED_NO_APPROVED_TOLERANCE`，不把低误差改称正式数值通过。

成果：[数值指标原件](ref/experiment_results_20261115/q_projection/metrics.json)、[脱敏实验摘要](ref/experiment_results_20261115/q_projection/result.summary.json)。输出 SHA-256 为 `231c6188b0cae01dfb2d7d48c503aa9d73bca31fd9a0af966da807e0c8276908`；不公开含私有现场信息的完整运行记录。

## 3. 实验：联合 Attention CPU 图与边界测试

历史 `unit-reviewed.log` 记录 **32/32 项通过，耗时 0.453 秒**。已覆盖 BF16 RMS 在乘 gamma 前转换的顺序、图像先于上下文的 packing、head 布局、SDPA 分路及两路输出投影，以及张量头、长度、Q 参数身份和比较输出完整性等边界。

这些是 CPU 图和工具测试，不证明完整联合 Attention 已在 NPU 执行。原日志还记录该测试环境 NumPy 不可用的警告；测试通过不能据此推断完整生成环境就绪。

成果：[精选测试摘要及原日志身份](ref/experiment_results_20261115/joint_attention_cpu/result.summary.json)。本次不发布含本地环境路径的原始日志，也不重新执行该实验。

## 4. 实验：Q-only CPU/NPU HYBRID 四步生图

### 4.1 原始图片

![历史 SD3.5 Medium Q-only CPU/NPU HYBRID 四步生成的苹果预览，256×256，seed 20261115](ref/experiment_results_20261115/hybrid_generation/sd35-medium-hybrid.png)

[查看原始 PNG](ref/experiment_results_20261115/hybrid_generation/sd35-medium-hybrid.png) · [生成结果与 CPU/NPU 摘要](ref/experiment_results_20261115/hybrid_generation/result.summary.json)

这是此前 `attempt-02` 的实际模型输出，不是本次新图，也不是薄桥测试使用的合成 PNG。原始文件未缩放、重绘或重新编码，86,885 字节，SHA-256：

```text
40c42cc65c16dede5a84226692e0a983d68f948298bc0a5ba8dd603811f6258d
```

| 固定输入 | 取值 |
| --- | --- |
| 模型 | `stabilityai/stable-diffusion-3.5-medium` |
| revision | `b940f670f0eda2d07fbb75229e779da1ad11eb80` |
| prompt | `A red apple on a wooden table, soft natural window light, realistic photograph` |
| seed / 分辨率 / batch | `20261115` / `256×256` / `1` |
| steps / guidance | `4` / `1.0` |
| 文本编码 | 两个真实 CLIP；不加载 T5；`max_sequence_length=64` |
| 历史完成时间 | `2026-11-14T19:13:11.325935+00:00`，即北京时间 2026-11-15 03:13 左右 |

### 4.2 功能正确性与 NPU 的真实贡献

```text
CLIP、去噪上游（CPU）
  ↓ 每步实际隐藏状态 [1,256,1536]
block0.attn.to_q（NPU，16 个 M16 tile 覆盖全部 256 行）
  ↓ NPU 返回的 Q 真正进入当前步 Attention / DiT
其余 DiT、scheduler（CPU）
  ↓ 四步完成
VAE（CPU）→ 原始 PNG
```

- 四个采样步对应 4 次真实 Q 请求、64 个 M16 tile，不是旁路执行一次探针后另用纯 CPU 生图。
- 每步保留实际 Q 输入/输出摘要、请求号及依赖该返回值的 latents 摘要，现公开于生成摘要中。
- Q 设备计算段的 CPU fallback 和 host implementation 均报告为 0；**这不等于整条应用没有 CPU 计算。**
- 图片可读取、尺寸正确且非恒定；可见苹果轮廓，但明显模糊。此次目标是固定低步数流程及 NPU 返回值接入验证，不是画质比赛或正式质量基准。

按实际四次 `[256,1536] × [1536,1536]` 逻辑矩阵尺寸推算，Q GEMM 合计 `2,415,919,104 MAC`；若一乘一加计两次浮点操作，则约为 `4.832 GFLOP`。这只是排除 bias、转换、传输和运行开销的**逻辑操作数**，不是实测吞吐、加速比，也不是 NPU 占全模型算量的百分比。

### 4.3 “CPU 用了多少”的直接回答

**这次并不是 CPU 只做前后处理：主要模型计算仍在 CPU，NPU 仅接入每步首层 Q 投影。**

| 问题 | 现有记录能回答的内容 |
| --- | --- |
| CPU 承担哪些计算？ | 两个 CLIP 文本编码器、除 `block0.attn.to_q` 外的全部 DiT（含其余 Linear、Attention QK/softmax/PV、归一化、激活等）、scheduler、VAE，以及 BF16 边界转换、行拼接和传输组织。 |
| 主机内存用了多少？ | Linux 生成主进程峰值 RSS=`18,814,324 KiB`，即 `19,265,867,776` 字节，约 **17.94 GiB**。这是进程生存期峰值驻留内存，不是 CPU 利用率、NPU 内存、系统总内存或包含远端 worker 的总和。 |
| 用了多少 CPU 线程？ | 实际执行源码配置 `torch.set_num_threads(8)`，即 PyTorch 算子内并行线程设置为 **8**；不是实测固定占满 8 个物理核心，也不是进程总线程数。 |
| 运行多久？ | 完整请求墙钟 **99.798 秒**，包含加载、CPU、NPU、传输和收尾；不能当作 CPU 独占耗时或纯 NPU 时间。 |
| CPU 占用了百分之多少？ | 没有记录 CPU 利用率、CPU user/system 时间、CPU/NPU 分阶段时间或全模型 FLOPs 分母，因此**不能给出可信的 CPU 时间占比、利用率或算量百分比**。不使用“1/392”或请求数推算比例。 |

内存字段来自历史报告的 `peak_cpu_rss_kib`；计量代码为 `resource.getrusage(resource.RUSAGE_SELF).ru_maxrss`。线程配置和计量位置分别见生成摘要中列明的执行源码身份及行号。

### 4.4 应用价值与复现范围

该实验已经证明：真实 SD3.5 权重的一个实际去噪模块可通过 NPU 计算并接入完整生成链，最终取得图片。它尚未证明主要计算已迁移、画质通过、相对 CPU 加速或任意输入都可用。

公开记录给出了输入、输出原件、组件版本、执行源码摘要和逐步因果摘要；完整复现仍需获授权模型组件、厂商运行环境、私有受控入口、实际 worker 与设备窗口。**仅下载本目录不能独立重跑真实模型/NPU 生图**，不把材料可下载称为硬件可复现。

## 5. 实验：扩大至 392 Linear 候选

扩大版清点了 392 个候选 Linear，代码预算为 BF16 参数 `4,486,127,744` 字节、设备池 `8 GiB`。这些是候选与配置，不是已实测驻留量。

最终运行回执、实际执行模块清单、扩大版图片及当前资源释放状态没有确认，仍记为 **`UNKNOWN`**。因此本次不补造扩大版成果图片、CPU 占比、实际 NPU 覆盖率或性能结果。历史 Q-only 关闭记录不适用于扩大版。相关既有状态见 [schedule_07](schedule_07.md)。

## 6. 实验：服务薄桥和生产请求接管

已有独立通用标准库薄桥，支持固定 Q-only 配方的完整 request/result 协议、身份与摘要绑定、固定输入拒绝、窗口门禁、锁拓扑配置绑定，以及新鲜图片/trace/evidence 的发布。它不是完整模型 payload，也不含模型或 SDK。

| 检查 | 已记录结果 |
| --- | --- |
| 薄桥检查 | **31/31 通过**，包含真实 Node 摘要对照、合成 simulation 文件的冻结生产 `validateResult` 互通和原子不覆盖发布回归。 |
| 生产请求补充验收 | **17/17 通过**，覆盖真实服务函数生成的完整 deployment/generation 请求、错误字段/输入/摘要/锁门禁。 |
| 主控接管 | 主控报告独立复核字节并复跑两组测试通过；仍是离线复核，不是新增硬件认证。 |
| 硬件与 CPU 资源 | 两组均不启动真实模型或 SDK，实际 NPU 调用=0；没有据此给出模型 CPU 用量。 |

公开成果：

- [原样通用薄桥 ZIP](ref/experiment_results_20261115/sd35-service-bridge.zip)，23,757 字节，SHA-256=`298dd9573237a1ca04d423960dc54cdde86ef82f9d2386af524de749a1b5a0be`。
- [薄桥源码](ref/experiment_results_20261115/service_bridge/service_bridge.py)、[合同与前提](ref/experiment_results_20261115/service_bridge/bridge-contract.json)、[原包清单](ref/experiment_results_20261115/service_bridge/bundle-manifest.json)。
- [31 项离线检查记录](ref/experiment_results_20261115/service_bridge/offline-checks.json)、[测试输出](ref/experiment_results_20261115/service_bridge/offline-tests.log)、[测试源码](ref/experiment_results_20261115/service_bridge/tests/test_service_bridge.py)。
- [17 项验收收据](ref/experiment_results_20261115/request_acceptance/acceptance.json)、[验收源码](ref/experiment_results_20261115/request_acceptance/verify_production_requests.py)。

ZIP 和对应展开文件保持交付版本字节不变；其中模板为占位示例，不是当前授权或成功执行回执。真实模型桥仍拒绝 simulation/replay，生产结果校验器互通使用的合成图不冒充模型图。

### 6.1 可复跑的公开离线测试

在仓库根目录，使用 Python 3.12；若 Node 可用，以下命令会运行 30 项并跳过 1 项需要外部生产校验器的测试。没有 Node 时另有 Node 对照项跳过，不能宣称全部 31 项都已执行。

```bash
python -I -B experiment/SD3.5_Medium/ref/experiment_results_20261115/service_bridge/tests/test_service_bridge.py -v
```

历史完整 31 项与 17 项验收还依赖 SHA 已绑定的生产 `adapter.mjs` 及其同目录依赖。补充验收源码提供 `--bridge`、`--service-module`、`--report` 参数；必须供应相同身份的本地实现，否则拒绝，不能用不同版本冒称复跑。

新桥真机重验证仍为 `NOT_RUN`，真实锁拓扑、原生 Linux 环境、worker stage、新设备窗口及未知遗留状态仍需独立确认。

## 7. 本次上传内容与历史记录的关系

- `schedule_08` 是当时仅发布进度与摘要的快照，保持原样；本次新增授权发布图片和通用成果，不追改旧文。
- 本次附件中的模型生成图片仅有上述已确认的 `attempt-02` 原始苹果 PNG，不新增未验证图片，也不把协议测试夹具列为生成成果。
- [公开附件清单](ref/experiment_results_20261115/MANIFEST.sha256) 覆盖各附件字节；摘要匹配不等于独立硬件认证。
- 受阻静态 calbin、完整核心 NPU 迁移、正式数值/画质/性能验收均未因本次归档升级。

**总结：原图和可公开成果已经附上；CPU 的可确认数据是主进程峰值约 17.94 GiB、PyTorch 算子内线程配置 8，以及除首层 Q 外的大部分模型运算仍由 CPU 完成。CPU 利用率、耗时占比和算量占比没有对应实测，不能给出百分比。**
