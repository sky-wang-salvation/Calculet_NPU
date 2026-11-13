# 题三：模型关键特性的 NPU 适配

## 核心是语义兼容

题目要求固定上游版本和小模型，适配一项特性。它关注从“能加载”到“结果符合参考”的距离，不能只用输出文字或成功返回作为正确性证据。[赛题](../../赛题选择.md)

通用推理框架的图划分/回退可以帮助理解适配问题，但不同后端机制不同；不能假设原粒已经有 PyTorch/ONNX 自动回退。[ONNX Runtime 架构](https://onnxruntime.ai/docs/reference/high-level-design.html)

## 三类重要特性

| 特性 | 典型差异 | 检验方式 |
| --- | --- | --- |
| RoPE | 配对方式、部分维度、位置偏移、缩放、多模态位置 | 非零起点、不同长度、prefill/decode 对照 |
| mask | 布尔/加性、padding、因果、缓存长度、滑窗 | 变长 batch、左右 padding、多步缓存边界 |
| norm | RMS/Layer/L2 混淆、epsilon、累加、weight offset | 零向量、低范数、常量、逐层数值比较 |

官方 Transformers 文档区分多种 RoPE 变体，缓存文档要求 mask 覆盖历史与新增位置。名称相同不等于语义相同。[RoPE](https://huggingface.co/docs/transformers/main/en/internal/rope_utils)、[KV cache](https://huggingface.co/docs/transformers/main/cache_explanation)

## 寻找实际增量

SDK 已有普通 RoPE、归一化和 decode 注意力相关模板。应从一个可复现失败输入选择缺失语义/形状，公开文档中的 prefill、编码器和多模态不足可以作为调查入口。[SDK 现状](03-sdk.md)

| 固定项 | 内容 |
| --- | --- |
| 模型 | 名称、权重 revision/hash、配置、tokenizer |
| 上游 | release/commit，不使用变化中的 main 做最终基准 |
| 输入 | batch、长度、padding、最大上下文 |
| 精度 | 权重/激活格式、量化、累加和舍入 |
| 执行 | 单/双芯粒、prefill/decode、缓存布局 |
| 范围 | 一个具体特性及边界，不承诺所有变体 |

## 分层定位

1. 构造能区分错误语义的最小 CPU 参考输入。
2. 对比单算子，保存误差位置与分布。
3. 接入一层模型，定位第一个差异张量。
4. 固定小模型比较 logits、确定性生成及 top-1/top-2 间隔。
5. 检验完整多步推理和原始失败用例。

长序列最终文本不同可能来自微小误差累积，逐层与逐步定位比只看文本更有效。逐位一致和容差一致是不同合同，不能擅自切换。

**最小成果**：固定模型、一项特性、失败复现、补丁、回归和支持范围。更强成果是可复用适配层，以及对图断裂或 CPU 回退改善的证据。

若只能跑子图，明确它尚未完成整模型验收。换模型、删除特性、缩短输入以绕过错误不能包装为原目标适配成功。
