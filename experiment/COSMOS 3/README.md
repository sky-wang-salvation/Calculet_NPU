# COSMOS 3｜Calculet NPU 部署进度

记录日期：2026-11-14（Asia/Shanghai）。本次状态快照时间：08:18。本文区分官方资料核查、用户提供的服务器实测报告和实际部署结果；不是部署成功报告，也不是已经复现的安装教程。

**当前状态：完成首轮模型与后端调研，正在解决 SSH 认证与隔离部署准备问题。尚未确认登录成功，尚未创建远端 `cosmos3` 目录，没有下载完整模型权重，没有运行 Cosmos 或 NPU 负载，也没有生成视频。**

本目录单独记录 Cosmos3，不改写 [01-setup.md](../01-setup.md) 中历史 tiny 实验的完成边界。tiny 的编译、打包与静态检查不能作为 Cosmos 已在 NPU 上运行的证据。

## 1. 目标与完成标准

目标模型为 **`nvidia/Cosmos3-Nano-Sim-Auto`**：先在双芯粒 Calculet NPU 上正确运行，再考虑优化。不能用基础 `Cosmos3-Nano`、其他 Cosmos 模型或 Qwen 示例替代这一目标。

首个端到端目标采用官方允许的 **RGB-only、480p** 合法请求，保留支持的相机身份、逐相机 caption、控制数据对齐、rolling KV 历史和固定四步采样。之后再评估长视频、720p 和可选 LiDAR；不先做量化或性能调优。

部署成功至少需要：

- 固定的代码、权重、样例版本和随机种子。
- 真实 NPU 执行日志，而不只是包已安装、导入成功或编译成功。
- 可播放的视频，帧数、分辨率和相机/控制/caption 对齐正确。
- 关键中间张量与参考结果的数值比较，披露 CPU 回退和未覆盖部分。
- 设备使用窗口与文件隔离边界得到确认。

## 2. 进度总表

| 项目 | 状态 | 证据与边界 |
| --- | --- | --- |
| 模型主页与实际代码入口 | 已完成首轮调研 | 实现位于 `NVIDIA/cosmos-framework`；`NVIDIA/cosmos` 是导航入口 |
| 用途、输入和模型组件 | 已完成首轮调研 | 自动驾驶多摄像头视频/可选 LiDAR 仿真，不是普通单 prompt 文生视频 |
| 服务器硬件与软件信息 | 已取得用户实测报告 | 引用既有只读采集，不冒称本文整理时重新测量 |
| 现有 HF＋Dope 路径 | 已有说明与脚本证据 | Qwen 示例直接读取 HF 权重，不读取 calbin；不能推导任意 HF 模型均受支持 |
| Cosmos CUDA 耦合定位 | 已完成定点静态核查 | 已定位 rolling attention 的关键硬路径；不是全仓库兼容性审计 |
| SSH 连接 | 认证阻塞 | 主机可达，已做主机密钥检查；认证仍被拒绝，正在排查传递方式和连接配置 |
| 远端 `cosmos3` 目录 | 尚未创建 | 连接后先确认实际 HOME、归属及符号链接，不覆盖已有目录 |
| 文件系统强隔离 | 方案已形成，未实施 | 环境变量重定向不能替代强隔离 |
| 厂商包入口/ABI/算子表 | 仍需静态核对 | 包存在及版本号不代表目标运算可用 |
| Cosmos 源码与配置落盘 | 未在目标目录完成 | 只读网络资料研究不算服务器部署 |
| 完整权重与官方样例 | 未部署 | 无目标目录内的下载、校验记录 |
| 导入测试、单模块 NPU 测试 | 未执行 | 不占用共享设备，不伪称兼容通过 |
| 完整视频、精度与性能 | 未验证 | 无 NPU 延迟、吞吐、峰值占用或精度通过率结论 |

**当前连接阻塞不能简单记成“密码错误”。** 需要区分凭据传递、客户端配置和服务端认证策略，不盲目重复认证。公开仓库不保存认证材料或完整认证日志。

## 3. 服务器基线：用户提供的只读实测报告

### 3.1 硬件与系统

| 项目 | 当前记录 |
| --- | --- |
| 主机 | MS-A2 迷你工作站 |
| CPU | Ryzen 9 9955HX，16 核 32 线程 |
| 主机内存 / 存储 | 64 GB / 1 TB NVMe；报告时已用约 100 G |
| 系统 | Ubuntu 26.04 LTS，内核 7.0.0-38 |
| NPU | CalcubicR120，2 芯粒；用户确认每芯粒 16 核 |
| 板上物理 DDR | `dort board` 报总量 **64 GiB（65536 MiB）** |
| 每芯粒物理内存 | **未单独验证**；32 GiB 仅为总量除以 2 的推断 |
| SRAM | 报告为 18 MiB/芯粒 |
| DDR 地址窗口 | 252 GiB、38 位孔径；**不是物理内存容量** |
| PCIe | Gen4 ×4、16 GT/s 链路协商；不等于应用传输吞吐已实测满速 |

完整模型权重文件合计约 **32.3 GB，约 30.1 GiB**。这是磁盘权重大小，不是运行内存要求。64 GiB 总容量不保证能装下每芯粒权重/副本、激活、rolling KV 缓存、工作区和运行时预留；仍需核对内存分布、访问范围和分片方案。

硬件核数不能直接映射成 PyTorch 进程数，也不能将 SDK 示例的 `cores = 2` 直接改成 `16`。本记录没有附 sysfs 原始属性，不能声称已从驱动节点验证每芯粒 32 GiB。

### 3.2 软件版本

| 层 | 用户报告的版本 |
| --- | --- |
| 内核驱动 `calculet` | 1.1.4 |
| DRT | rt 3.1 / ABI 1.1，commit `74832e51`，线协议 rev 2 |
| 设备 OS 批次 | `20261113-batch` |
| `dort` CLI | 0.4.1 |
| libcalrt / pycalrt | 1.1.6 |
| 容器内 Rust 工具链 | rustc 1.98.1（nightly-2026-11-13），带 docc/dort；不假定已装在所有环境 |
| vLLM / 插件 | 0.32.0+dopame / vllm_dope 0.0.1 |
| Torch / 插件 | 2.13.0+cpu / torch_dope 0.1.0 |
| Triton / 插件 | 3.7.1 / triton_dope 0.2.3 |
| 其他 | calcc 0.3.0、dopeadapter 0.0.1、flag_gems 5.0.2+dope |

`torch` 标为 `+cpu` 不能单独证明没有 NPU 后端；设备能力可能由插件提供。安装了插件也不证明 Cosmos 已受支持。`dope-kit` README 中“calculet 8.3”含义未核实，不作为驱动、固件或 SDK 版本依据。实际 Python 解释器、扩展 ABI 和入口仍需读取目标环境元数据确认。

用户已提供的只读查询入口是 `dort board` 和 `dort mem-map`。其结果在此作为用户实测报告引用，不冒称本次文档发布重新访问了服务器。

## 4. 路线修正：优先评估 Python 后端

现有套件说明明确区分：

1. `dort` 读取预生成 calbin。
2. vLLM 读取 HF 权重，经 Dope 后端运行，不读取 calbin。

因此，**`Rust → CalVX → calbin` 不是当前模型部署默认必须先走完的步骤**。优先评估一般 PyTorch / Cosmos Framework 能否接入 `torch_dope` 等后端，再按实际缺口适配。

但 Qwen 的文本生成示例不等于 Cosmos 多摄像头扩散流水线：

- 不能只替换 Qwen 脚本的 `MODEL_DIR`。
- `vllm_dope` 不等于已经具备兼容 Cosmos 的 vLLM-Omni 后端。
- Qwen 的双芯粒按层放置、8 GiB 内存池和 token KV 预算不能直接照搬。
- 不升级或覆盖共享厂商 venv 的 Torch/Triton/vLLM，不原样安装 NVIDIA CUDA 依赖组。

## 5. 最新静态核查与兼容性风险

定点核查基于 Framework 提交 `1f1737931214166d5e7b253def319c562cf7a1eb`。

| 发现 | 对首次部署的影响 |
| --- | --- |
| 官方入口为 `python -m cosmos_framework.scripts.inference` | 初始化和模型构造都要检查，不能只看 pipeline 类名 |
| 多进程初始化涉及 CUDA、NVML、NCCL；设备枚举接受 cuda/cpu/meta | 需确认厂商设备注册、初始化及通信接入，不能只改设备字符串 |
| 存在通用 attention selector | 只影响经过 selector 的调用，不代表所有路径均可替换 |
| rolling replay 的 `require_gapped_replay` / `maskless_attention` 限定 CUDA、指定 SM，并直接触及 FA4、CUDA custom-op 和 Triton | **当前重点适配风险**；关闭 torch.compile 或改通用 attention 环境变量不足以证明绕过 |
| 路径涉及变长/分段序列和 LSE | 需核对对应语义、BF16 运算与 FP32 LSE 合并，不只是有同名 attention 算子 |
| 其他位置存在 Transformer Engine 导入 | 尚未证明全部属于当前 Sim-Auto 推理必经项，不把依赖组等同于所有路径的强制要求 |

关键源码入口：

- [推理初始化](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/cosmos_framework/inference/common/init.py#L207)
- [设备枚举](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/cosmos_framework/utils/flags.py#L52)
- [rolling 模型前置要求](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/cosmos_framework/model/generator/omni_mot_causal_model.py#L610)
- [maskless attention 检查](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/cosmos_framework/model/generator/mot/maskless_attention.py#L423)
- [maskless attention 执行路径](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/cosmos_framework/model/generator/mot/maskless_attention.py#L839)

**结论仍是“具备尝试移植的基础，但未确认可完整运行”，不是现成的一键部署。** 当前没有经过验证的 Dope attention 替换、依赖补丁或可运行命令可供发布。

## 6. 共享服务器与文件边界

用户要求新建独立 `cosmos3` 目录。以下是必须落实的要求，不代表均已实施：

- 连接后先确认 HOME、归属及符号链接；预期根目录为 `$HOME/cosmos3`，当前未创建，不覆盖已有目录。
- 所有新增/修改，包括源码、虚拟环境、模型、样例、缓存、临时文件、日志和输出，限制在项目根目录内。
- 目录外必要的系统、厂商依赖和设备状态只读复用，以部署会话明确确认的范围为准，不扩展到他人项目。
- 不使用 sudo/apt，不修改共享 venv、驱动、固件、SSH 配置或全局缓存，不执行共享启动脚本。
- 运行第三方代码前核对现有非特权文件系统隔离手段；不能只靠 HOME、HF_HOME、TMPDIR 等变量就声称写入被严格约束。
- 未确认设备使用窗口前，不导入可能初始化 NPU 的厂商模块，不运行任何 NPU 负载。
- 不停止、重启或清理已有服务，不执行全局 pkill/killall；无板锁不代表设备空闲。
- 若共同设备锁要求写目录外文件，先解决授权与隔离冲突，不改用私锁绕过。
- 不将 IP、登录账号、密码、令牌、设备 SN/UUID 或完整认证日志写入公开仓库。

## 7. 当前阻塞与下一步

按顺序推进，前一关未过时不把后一关记为完成：

1. **解决 SSH 认证**：核对客户端传递方式和连接配置，恢复可信的只读连接；不公开认证材料，不盲目重试。
2. **确认目录与强隔离**：只创建自己的根目录，落实可写路径和缓存边界；隔离能力不足时暂停。
3. **只读核对后端**：读取包元数据和入口源码，确认设备注册、ABI、分发/回退、attention、动态形状、缓存与通信支持，不执行导入负载。
4. **准备源码与小配置**：静态明确 CUDA 硬路径替换方案，不先下载完整权重。
5. **隔离兼容性检查**：复用兼容厂商依赖，新增内容只写项目目录；未执行的导入检查不标为通过。
6. **资源窗口内再上板**：确认内存布局，下载校验固定权重与官方样例，从单模块到完整 RGB 视频，最后才扩展功能或优化。

后续应补充具体路径、版本、脱敏命令、返回结果和失败点，区分“计划”“静态检查”“实际执行”。本次没有可发布的 Cosmos 视频、NPU 精度或性能数据。

## 8. 参考资料与证据边界

- [目标模型卡](https://huggingface.co/nvidia/Cosmos3-Nano-Sim-Auto)
- [模型文件元数据](https://huggingface.co/api/models/nvidia/Cosmos3-Nano-Sim-Auto?blobs=true)
- [Cosmos 导航仓库](https://github.com/NVIDIA/cosmos)
- [固定版本 Sim-Auto 推理指南](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/docs/inference_sim_auto.md)
- [固定版本环境说明](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/docs/setup.md)
- [RGB-only / 480p 输入准备](https://github.com/NVIDIA/cosmos-framework/blob/1f1737931214166d5e7b253def319c562cf7a1eb/.agents/skills/cosmos3-nano-sim-auto/inference/references/input-preparation.md)
- [Calculet 官方 SDK 入口](http://115.159.82.89/)
- [历史 tiny 实验](../01-setup.md)

服务器信息和 Dope 套件说明来自用户提供的只读采集记录；Cosmos 兼容性发现来自官方源码静态阅读。用户提供的视频已核实标题与作者，但未取得 30:54 附近字幕，不作为可复现部署步骤的证据。
