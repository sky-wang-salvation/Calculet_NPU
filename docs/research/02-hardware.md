# 两款硬件与性能边界

## 附件参数

下表是用户材料的标称值，尚未经本项目验证。单/双芯粒对应关系来自用户描述，需由设备信息确认。

| 项目 | 单芯粒/边缘设备 | 双芯粒/工作站 |
| --- | --- | --- |
| 主机 | Raspberry Pi 5 Model B | Minisforum MS-A2 |
| CPU | 四核 Cortex-A76，最高 2.4 GHz | Ryzen 9 9955HX，16 核 32 线程 |
| 主机内存 | 8 GB | 64 GB DDR5 |
| 主机存储 | 64 GB | 1 TB NVMe |
| NPU | Calcumex Core | Calcubic R120 |
| 标称算力 | 200 TOPS | 400 TOPS |
| NPU 专用内存 | 32 GB LPDDR5x | 64 GB |
| 标称内存带宽 | 137 GB/s | 273 GB/s |
| 加速器接口 | PCIe Gen 4 ×4 | PCIe Gen 4 ×4 |
| 功耗口径 | 典型 30 W | 最大 75 W |
| 材料中的系统 | Ubuntu 26.10 | Ubuntu 26.04 LTS |

原件：[边缘参数](../assets/edge-spec.png)、[工作站参数](../assets/workstation-spec.png)、[边缘海报](../assets/edge-poster.png)、[工作站海报](../assets/workstation-poster.jpg)。

## 五个关键限制

**TOPS 口径未知。** 先确认精度、稠密/稀疏、MAC 计数和频率。不能将 TOPS 当作 FP16 TFLOPS，也不能用矩阵峰值预测排序性能。

**主机与 NPU 内存不同。** 树莓派的 8 GB 主机 RAM 可能约束加载和权重转换，即使 NPU 有 32 GB。要确认流式加载、权重格式和临时缓冲。

**接口能力不等于整机连接。** 树莓派官方产品简表标注 PCIe 2.0 ×1 外接接口，附件 Gen 4 ×4 应先视为加速器规格。实际适配板、链路协商和有效带宽必须核实。[Raspberry Pi 官方简表](https://pip-assets.raspberrypi.com/categories/892-raspberry-pi-5/documents/RP-008348-DS-10-raspberry-pi-5-product-brief.pdf)

**功耗条件不同。** 典型 30 W 与最大 75 W 不能直接算能效；还需说明测量边界是否包含 CPU、风扇和电源。

**双芯粒不保证两倍速度。** 273/137≈1.99 只是标称带宽比。权重划分、通信、负载均衡和串行阶段决定实际收益。

## 性能估算方法

```text
T_compute >= 运算量 / 对应精度有效吞吐
T_memory  >= 实际访存字节 / 有效带宽
T_kernel  >= max(T_compute, T_memory)  （理想重叠的简化下界）
T_end_to_end = 临界路径上的主机处理、搬运、调度、计算和同步耗时
```

算术强度低时访存更可能成为限制；规模小或并行度不足时还可能受启动延迟影响。这是通用分析方法，不搬用 GPU 的硬件结构或性能数字描述原粒。[NVIDIA 性能背景文档](https://docs.nvidia.com/deeplearning/performance/dl-performance-gpu-background/index.html)

**假设算例，不是预测或实测**：稠密 7B 模型使用理想 4-bit 权重，权重本体约 3.5 GB；若每 token 从 DRAM 读一遍全部权重，仅这部分流量给出的上界为 137/3.5≈39 token/s 或 273/3.5≈78 token/s。量化元数据、KV、激活、可达带宽与调度会改变结果；缓存、批处理和 MoE 又会改变假设。它只说明 TOPS 无法独立预测 decode 性能。

普通 KV cache 的容量可先估为：

```text
KV bytes ≈ 2 × 层数 × batch × 上下文长度 × KV头数 × head_dim × 元素字节
```

滑窗、量化、压缩和共享缓存需修正；GQA 的 KV 头数不能误写成 query 头数。[缓存文档](https://huggingface.co/docs/transformers/main/cache_explanation)

## 对选题的影响

- 融合：减少外存往返，但防止片上占用增加造成退化。
- 采样：检查每 token 的主机同步和往返是否占关键时间。
- 模型适配：容量足够不代表算子、布局、dtype 和运行时支持足够。
- 重排：测 batch=1 响应与多候选批处理两种场景。
- 开放题：大内存不能消除扩散/视频的多轮计算和算子缺口。

两台整机 CPU 差异明显。没有同主机单/双芯粒控制实验时，只能报告整机配置差异，不能称为纯芯粒扩展收益。
