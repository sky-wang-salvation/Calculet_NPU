# 来源、版本与检索记录

检索日期：2026-11-13，Asia/Shanghai。优先采用用户原件、原粒公开文档、上游官方文档与原始论文。动态网站可能更新；涉及本次 SDK 状态的链接尽量固定 commit。

## A. 用户材料与目标仓库

| 编号 | 来源 | 使用范围 |
| --- | --- | --- |
| U1 | [原粒赛题 PDF](../assets/challenge.pdf)，2 页 | 五题、验收、设备共享和提交要求；已提取全文核对 |
| U2 | [工作站参数](../assets/workstation-spec.png)、[海报](../assets/workstation-poster.jpg) | 设备标称值，非实测 |
| U3 | [边缘参数](../assets/edge-spec.png)、[海报](../assets/edge-poster.png) | 设备标称值，非实测 |
| U4 | [仓库赛题](../../赛题选择.md) | 与用户正文/PDF 交叉核对 |
| U5 | [仓库快速开始](../../Calculet%20NPU%20黑客松%20·%20选手快速开始.md) | SDK 公开入口、Rust 工具链和三库 |
| U6 | [BoHack 总则](../../BoHack%202026%20赛道和赛题设置/BoHack%202026%20赛道和赛题设置.md) | 企业赛道与提交时间；未独立确认后续更新 |

用户说明本次提供资料不涉及未公开内容。原件保留于 `docs/assets`，[manifest.json](../assets/manifest.json)记录原文件名和 SHA-256；未修改图片内容。

## B. 原粒公开材料

| 编号 | 来源 | 本次支持的判断 | 读取方式/限制 |
| --- | --- | --- | --- |
| C1 | [SDK 主页](http://115.159.82.89/) | Rust/CalVX 链路、A/B 路线、视觉与端到端导向 | 直接读取公开 HTML；未执行其中命令 |
| C2 | [calBLAS README](http://115.159.82.89/git/calculet/calBLAS/src/commit/32d2bb83d7160a593eaab67aa02e5dddbc8706cf/README.md) | 覆盖表、例子阶段、候选缺口 | 公开 main 文档，记录提交；未完整审计源码 |
| C3 | [calBLAS STATUS](http://115.159.82.89/git/calculet/calBLAS/src/commit/32d2bb83d7160a593eaab67aa02e5dddbc8706cf/STATUS.md) | 历史编译与未上板状态 | 内含 2026-10 的记录，不当作最新实测 |
| C4 | [calDNN README](http://115.159.82.89/git/calculet/calDNN/src/commit/1e06c41c557a469a9acc7566acb9f7e2c7f7ca62/README.md) | Graph/Engine/Plan，融合覆盖与工作区方向 | 文档描述，不等于已发射执行 |
| C5 | [npu SYNTAX](http://115.159.82.89/git/calculet/npu/src/commit/172aad2611c86ead4071356fbaca3cf6facd2917/SYNTAX.md) | 原语、形状/控制流、CalVX 类型层次 | 语法支持不等于后端全部支持 |
| C6 | [原粒官网技术介绍](https://www.calculet.com.cn/newsinfo/11263291.html) | CalcuMex/CalcuGrid/CalcuKit 总体定位 | 使用搜索抓取内容；直接页面抽取不完整，厂商自述 |
| C7 | [AI Chiplet 与算力融合介绍](https://www.calculet.com.cn/newsinfo/7586329.html?templateId=1642678) | 芯粒与可扩展架构背景 | 历史产品理念，不作为比赛性能证据 |
| C8 | [官网端侧 Agent 方向介绍](https://www.calculet.com.cn/newsinfo/11254984.html?templateId=1642678) | 本地存储、持续运行与能效背景 | 厂商定位说明，未推导实测能力 |

版本记录同时见 [SDK 文档](03-sdk.md)。原始下载内容的哈希见 [public-source-manifest.json](public-source-manifest.json)，用于识别本次阅读版本；本仓库不复制整篇外部技术文档。

## C. 上游技术依据

| 编号 | 一手来源 | 用于理解什么 | 对原粒不能证明什么 |
| --- | --- | --- | --- |
| T1 | [Triton fused softmax 教程](https://triton-lang.org/main/getting-started/tutorials/02-fused-softmax.html) | 融合与访存分析 | 不证明 Triton 后端支持 |
| T2 | [FlashAttention 原始论文](https://arxiv.org/abs/2205.14135) | 分块与 IO-aware 计算 | 不证明原粒获得同样加速 |
| T3 | [FlashInfer 无排序采样](https://flashinfer.ai/2025/03/10/sampling.html) | 选择/采样的算法空间 | 不证明 CUDA kernel 可移植 |
| T4 | [FlashInfer sampling 接口](https://docs.flashinfer.ai/generated/flashinfer.sampling.top_k_top_p_sampling_from_logits.html) | 过滤顺序、随机与接口语义 | 不等于比赛指定合同 |
| T5 | [PyTorch topk 文档](https://docs.pytorch.org/docs/2.15/generated/torch.topk.html) | 并列索引不稳定等边界 | 不确定比赛要求的 tie-break |
| T6 | [Transformers RoPE](https://huggingface.co/docs/transformers/main/en/internal/rope_utils) | 位置编码变体 | 不承诺全部变体可支持 |
| T7 | [Transformers cache](https://huggingface.co/docs/transformers/main/cache_explanation) | KV、位置与 mask 关系 | 不证明具体缓存实现已适配 |
| T8 | [Sentence Transformers 检索重排](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html) | 召回与 cross-encoder 分工 | 不证明模型能跑 NPU |
| T9 | [BAAI BGE reranker 模型卡](https://huggingface.co/BAAI/bge-reranker-v2-m3) | query-document 打分接口 | 不作为选定的比赛模型或兼容承诺 |
| T10 | [检索指标文档](https://sbert.net/docs/package_reference/sentence_transformer/evaluation.html) | Recall、MRR、nDCG | 不代替测试集和真值 |
| T11 | [ONNX Runtime 架构](https://onnxruntime.ai/docs/reference/high-level-design.html) | 图划分、执行后端 | 不证明原粒使用 ORT |
| T12 | [ORT 性能排查](https://onnxruntime.ai/docs/performance/tune-performance/troubleshooting.html) | 回退可能造成开销 | 不证明本项目存在具体回退 |
| T13 | [NVIDIA 性能背景](https://docs.nvidia.com/deeplearning/performance/dl-performance-gpu-background/index.html) | 算术强度与瓶颈模型 | 不移植 GPU 参数和线程模型 |
| T14 | [树莓派官方产品简表](https://pip-assets.raspberrypi.com/categories/892-raspberry-pi-5/documents/RP-008348-DS-10-raspberry-pi-5-product-brief.pdf) | Pi 5 外接 PCIe 2.0 ×1 | 不确定比赛适配板与实际协商速度 |

## D. 未能直接读取的入口

- [飞书赛题](https://tcnf5s7xd39g.feishu.cn/wiki/EpxXwbYkkieZrfk0QbRc7wWQnRc?from=from_parent_docx)：工具未取得正文；使用用户 PDF 与仓库副本核对。
- [飞书快速开始](https://fcnnjk5lt27s.feishu.cn/wiki/XbyKwwdBeiEYcWkbAkLcfOaondd)：工具未取得正文；从仓库副本发现公开 SDK 站点并成功读取。
- [招聘入口](https://app.mokahr.com/social-recruitment/calculet/187884#/)：未取得职位正文，不引用职位要求。

没有从这些失败访问推断不存在内容，也没有声称读过其未获取部分。

## E. 检索方法与仍未解决的问题

先核对附件，再搜索原粒官网/SDK，最后对照官方上游文档和论文。检索覆盖品牌与产品名、SDK/GitHub、融合、采样、RoPE/KV、检索重排与硬件接口。搜索中出现的非官方媒体、聚合站和论坛不作为关键技术结论依据。

仍未取得各题完整验收包、当前真机基线、原生运行产物、设备 profiler/功耗数据；未验证目标模型权重、SDK 安装与编译。下一阶段应按[确认清单](11-questions.md)和[验收协议](10-evaluation.md)补齐。
