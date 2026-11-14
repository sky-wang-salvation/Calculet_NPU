# schedule_04｜SD3.5 Medium 真实子图与离线修复收尾

记录日期：2026-11-14。

**最终状态：`BLOCKED_NATIVE_IO_DOUBLE_BUFFER`。真实 Q 投影子图已完成 CPU 参考与离线编译打包；v2 的非法 JSON 问题已修复，并通过独立解析与哈希复核。原生包仍将输入、输出各自的 ping/pong 指向同一地址，因此没有达到可申请上板测试的就绪状态。**

本文件为新增第四份快照，不修改 [schedule_01.md](schedule_01.md)、[schedule_02.md](schedule_02.md)、[schedule_03.md](schedule_03.md)。前三份保留的是前期 MiniMax 调研历史，不是 SD3.5 Medium 的验证结果；本文件记录切换模型后的真实子图执行准备与离线修复。

本轮没有连接 NPU 服务器、执行 NPU 或模拟器，没有启停共享服务、复位设备或修改共享 SDK／厂商环境。完整模型推理和出图仍未取得成功记录。

## 1. 当前最小闭环范围

项目选择赛题5，当前图像模型为 **Stable Diffusion 3.5 Medium**。本轮只验证一个真实 Linear 子图，不是完整 Attention、Transformer 块、DiT 或文生图流水线。

| 项目 | 范围 |
| --- | --- |
| 模型 | `stabilityai/stable-diffusion-3.5-medium` |
| 固定 revision | `b940f670f0eda2d07fbb75229e779da1ad11eb80` |
| 层 | `transformer_blocks.0.attn.to_q`，含真实 weight 与 bias |
| 数学 | `Y = X @ W.T + b` |
| 形状 | `M=16`，`K=N=1536`；输出 `[16,1536]` |
| 精度 | BF16 输入／权重／输出；累计、bias 与舍入按参考及设备合同分别核对 |
| 程序配置 | 单芯粒、程序 `cores=2`；不据此推断物理核利用率 |
| 输入性质 | 固定种子的单元验证输入，不是整模型图像／prompt 产生的隐藏状态 |

子图复用官方 calBLAS Linear 模板。项目工作包括真实权重提取、数值参考、程序编排、打包与布局审查，不能将已有厂商内核归为项目从零实现。

## 2. 已完成的 v1 本地基线

### 2.1 真实权重与输入

执行日志报告 Transformer 检查点大小为 **4,939,433,672 字节**，SHA-256 为：

```text
f81eb93a348be218af757dd095cbda45090380d9bbda91049442e0e40bb4cc95
```

该文件不等于完整图像流水线的全部组件。发布阶段没有重新下载或重算母文件完整哈希。

| 数据 | 字节数 | 已有结果 |
| --- | ---: | --- |
| Q 投影 weight `[1536,1536]` | 4,718,592 | 真实载荷提取及哈希检查通过 |
| bias `[1536]` | 3,072 | 提取及哈希检查通过 |
| 固定输入 X `[16,1536]` | 49,152 | 准备完成 |
| 参数块，含 W／bias／对齐填充 | 4,722,688 | 准备日志报告检查通过 |

### 2.2 CPU 参考

已生成三份参考：PyTorch BF16、FP32、FP32 按 RNE 转 BF16。初始日志报告有限性与重复计算检查通过；后续独立只读复算的三份结果分别与各自归档 `EXACT_MATCH`。

这不表示三种参考彼此逐字节相等。BF16 路径与 FP32→RNE→BF16 的诊断比较中，24,576 个元素有3个不同，最大绝对误差为 `0.0001220703125`；这是 CPU 路径差异，不是 NPU 精度结果或赛题验收门槛。

### 2.3 编译与打包

- Rust 设备构建 exit 0，生成具备入口、内存声明和 kernel 调用的 CalVX。
- cargo 当时提示只生成 CalVX，不能仅凭 target 名称宣称已有原生 ELF。
- 后续独立 `docc from-calvx` exit 0，生成原生 calbin 和两个 CCU ELF。
- `doctor` exit 0，拒收0、不可解码0，但有两条 ping/pong 同址警告。

这是离线构建链路，不是设备执行成功。

## 3. v2 已完成修复：合法 JSON 与原件保留

v1 的 `manifest.json` 第20、22行将半开区间写成了 `[数字,数字)`，真实 JSON 解析在第20行第45列失败。原件保留，没有通过覆盖原文件抹除审查事实。

项目内新增 `qproj-v2/tools/generate_manifest.py`：严格识别两处已知语法错误，解析为对象，核对 revision、真实权重选定载荷、文件位置、参考／参数块与 SDK 状态，再用 JSON 序列化生成修正版。

修正版保留以下语义：

```text
weight_file_pos = [520377288, 525095880]
bias_file_pos   = [520374216, 520377288]
file_pos_semantics = "[begin,end)"
```

生成与收尾验证已报告：

- `artifacts/qproj-v2/manifest.json` 通过独立 JSON 解析。
- 26个关键 v1 原件的大小／SHA-256 前后不变，原始无效清单另有备份。
- X、W、bias 与三份 CPU 参考共6个哈希不变；参考脚本与 CPU 包版本不变。
- 复用已验收 CPU 参考，没有重复 CPU 数值计算或重新下载权重。
- 共享 SDK 的固定提交与工作区未修改。

发布阶段已独立解析回传的最终 v2 清单，并核对其 SHA-256 为：

```text
bc1e7afd42bda1d0aa35f635805dcf0802072bab9d4eded32305763e26d001d4
```

生成器记录明确区分：母文件完整哈希复用前序验收，选定权重载荷重新核对；不是本轮重新哈希整个 Transformer 检查点。

## 4. 双缓冲对照探针：已执行，但没有修复

本轮进行了一个基于现有 SDK 示例约定的受控离线探针：以同一个已编程序的二进制 `step.cvxo` 和同一真实参数块作为输入，与 v1 的文本 `step.cvx` 路线对照。

| 项目 | 实际结果 |
| --- | --- |
| Rust／数学代码 | 未改，因此未重新运行 cargo |
| 原生生成 | 确实重新执行 `docc from-calvx`，exit 0 |
| 静态检查 | 确实重新执行 `doctor`，exit 0；拒收0、不可解码0、警告2 |
| 两包比较 | 执行侧逐文件比较9个输出文件，大小／SHA 一致，记录为字节相同 |
| 手动修改地址或 ELF | 未执行 |
| 布局结论 | `buffer_layout_fixed=false` |

输入、输出仍分别为：

| 张量 | ping | pong | 结果 |
| --- | --- | --- | --- |
| `in_x` | `0xc0490000` | `0xc0490000` | 同址 |
| `out_outputs_0` | `0xc04a0000` | `0xc04a0000` | 同址 |

Rust 与 CalVX 中保留 `double_buffer`，但原生 I/O 未落实分离。落差目前仅定位到 **CalVX → calbin 输出边界**，尚未证实是内部解析、分配还是导出逻辑问题。

**切换二进制输入没有解决问题，不能把探针成功退出写成修复成功。** 两包9文件一致的结论来自执行侧完整产物比对记录；发布阶段没有重新取回并逐字节比较全部原生二进制。

本次所用 `docc` 二进制 SHA-256：

```text
a150425971469995af1015b847baee5ba72f03383a252090e472646a0afa135d
```

## 5. 已准备的最小复现与受阻上板计划

### 5.1 最小复现

项目内已有 `artifacts/qproj-v2/minimal-repro/`，包含真实参数块、`step.cvx`／`step.cvxo`、相关原文、预期观测和 `reproduce_export.py`。

复现 runner 本身只做过语法检查；等价的导出和 doctor 探针已实际执行。不能将 runner 存在写成该脚本已完整重跑。最小复现、权重与原始包均未对外上传。

### 5.2 候选上板计划

`candidate-npu-test.json` 状态为 **`BLOCKED_NOT_RUNNABLE`**，`executed=false`。已按本地 `dort 0.4.1` 真实帮助整理 raw tensor 候选参数：

- 模型名为 `sd35-medium-qproj-m16`，不是 `llm_decode` 类型名。
- 输入 `in_x`、输出 `out_outputs_0`；逻辑上均为 BF16 小端 `[16,1536]`，各49,152字节。
- 原生 `uint32[12288]` 是存储视图，不是 FP32 语义输入。
- 不使用 token／logits 路线，不把单算子输入伪装成 LLM 平面。

该计划仍要求核对 loader／PLD 初始状态、phase 地址绑定及 raw I/O 合同。本地帮助文本和相同版本号不能单独证明目标二进制、ABI、设备健康或实际加载行为一致；计划没有执行。

## 6. 剩余最小阻塞与下一步

当前状态为 **`BLOCKED_NATIVE_IO_DOUBLE_BUFFER`**，不是 `READY_FOR_AUTHORIZED_NPU_TEST`。下一步需要文档或工具链提供方明确：

1. 对应 SHA 的 `docc` 是否支持将 `double_buffer` 落实为独立原生 I/O 地址。
2. 是否需要文档化 phase／导出配置，以及清单、CCU 和 PLD 之间的地址绑定合同。
3. 若当前版本不支持，提供与目标 runtime 兼容的修复版本或可核查的正确生成路径。

取得正确生成路径后，才重新生成、检查并独立复验；不手改清单地址后宣布成功，也不以“只运行一次”豁免。

后续上板仍须单独明确授权、有效设备窗口和运行前实时检查。`READY` 只表示离线准备可以申请测试，不表示已获准运行、设备数值正确或整模型就绪。设备结果需要检查有限性、形状及误差，并依 KS1 累计／舍入合同与事先约定容差验收，不虚构 bitwise 保证或阈值。

## 7. 证据与独立核查范围

本地 v1 审查副本：`ref/qproj-batch02-review-20261114/`。发布准备阶段对20个文件与随包清单逐个比对通过；`MANIFEST.sha256` 自身哈希为：

```text
70ea442893e5d47007b139ac0367f77abdd7055fd8cd8558a1813898384e1c4e
```

本地 v2 收尾副本：`ref/qproj-v2-work-20261114/evidence/final/`，关键文件：

- `manifest.json`：已独立解析并核对上述 `bc1e7afd...` 完整 SHA。
- `verification-result.json`：JSON 修复、26个原件不变、未重算 CPU、二进制导出及总体阻塞状态。
- `buffer-investigation.json`：导出／doctor 命令记录、I/O 同址、9个文件指纹及负结果。
- `candidate-npu-test.json`：未执行的候选计划与前置条件。
- `phase1-manifest-repair.log`、`phase2-binary-from-calvx.log`、`phase2-binary-doctor.log`、`phase3-manifest-regenerate.log`、`phase4-independent-verification.log`。

发布阶段只读取回传数据并做静态解析／哈希检查，没有重新在 Linux 执行导出或设备测试。26个原件复核和9个完整原生输出的比对，以执行侧收尾记录为依据；不能将文本包一致性当作厂商签名或设备正确性证明。

以上是本地证据定位，不是已公开的 GitHub 附件。本进度只包含文档，不包含原始源码包、权重、二进制、连接凭据或设备身份信息。

## 8. 本阶段总结

**已完成：真实 Linear 子图 CPU 参考和离线构建；v2 JSON 修复及独立解析；原件与参考保留；一次有依据的输入格式对照探针；最小复现和受阻候选上板计划。**

**仍未完成：原生双缓冲布局修复、可批准部署的子图包、NPU 执行与数值对比，以及完整 SD3.5 Medium 推理和出图。**

本轮离线修复已收尾，不能写成整模型已部署。发布目标为新增 `schedule_04.md`，不改写前三份历史快照；GitHub 发布是否成功以单独的提交核验结果为准。
