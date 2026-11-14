# MiniMax H3-Image｜Calculet NPU 部署调查与进度

更新日期：2026-11-14。

目标：先让 **MiniMax-H3-Image** 在两芯粒 Calculet NPU 上完成可验证的图像生成，再讨论性能优化。本目录记录部署调查和必要适配，不把 CUDA／昇腾方案等同于 Calculet 部署。

**当前结论：服务器已有 HF 权重＋Dope Python 后端入口，不需要先转换成 calbin 才能走这条路径；但现有证据仅覆盖套件提供的 Qwen 文本生成示例，尚未证明 H3-Image、Diffusers 或扩散模型所需算子已经受支持。H3-Image 尚未在目标 NPU 上执行。**

## 1. 证据来源与完成边界

本记录依据三类信息整理：

1. 上游模型主页、框架文档和 Calculet 原始 SDK 文档的只读调查。
2. 用户提供的目标服务器只读采集报告；本记录编写时没有重新登录服务器复核。
3. 用户粘贴的 `dope-kit/README.md`、单双芯启动脚本及 `dort calbin parse --help` 终端输出。

| 项目 | 当前状态 | 不能据此推断 |
| --- | --- | --- |
| 模型组件、权重规模与上游推理入口 | 已调查 | Calculet 已有完整适配 |
| 目标服务器硬件、驱动与软件版本 | 已取得用户采集报告 | 本记录已独立复测、设备当前空闲 |
| Dope 套件说明与启动脚本 | 已读取用户粘贴内容 | 任意 HF 模型都受支持 |
| HF／calbin 两条路径的区别 | 已由套件 README 确认 | 两条路径的编译产物和 ABI 可以混用 |
| `dort calbin parse` 接口 | 已取得帮助输出，明确纯静态 | 已解析实际包、部署或执行模型 |
| Dope 包入口、设备注册与算子覆盖 | 待读取 | 已支持一般 PyTorch／Diffusers 程序 |
| 本机 Qwen 样例复现 | 本记录尚无执行结果 | 套件的异机实测就是本机复现 |
| H3-Image 权重下载、加载和模块验证 | 未执行 | 模型已可运行或容量足够 |
| H3-Image 完整出图、精度与性能 | 未执行 | NPU 部署成功 |

本轮没有安装、升级软件或启动推理服务，没有占用 NPU，也没有停止已有容器。这里的进度与 [01-setup.md](../01-setup.md) 记录的容器内 tiny 编译／打包／静态检查是不同阶段：旧文档保存当时结果，不应用来替代当前服务器环境核查。

## 2. 上游模型调查

### 2.1 模型不是单个算子，也不是只有约 68 GB 的完整流水线

| 组件 | 作用与精度 | 权重文件规模 |
| --- | --- | ---: |
| 文本编码器 | MiniMax-H3 的 Qwen3-VL；图像流水线读取第 50 层隐藏状态 | 约 66.7 GB |
| DiT | 33.1B 参数；主体 BF16，embedding／timestep／output 等部分 FP32 | 约 66.28 GB |
| 图像 VAE | 图像编码／解码；检查点 FP32 | 约 2.34 GB |
| PDD 输出头与配置 | 固定采样步对应的输出头和调度配置 | 约 12 MB |

- 核心组件权重文件合计约 **135 GB**；这是文件规模，不是运行显存或主机内存要求。
- HF 仓库同时保留原始格式和 Diffusers 格式，全量下载约 **204 GB**。应先选定前端和格式，避免重复下载。
- `MiniMax-H3-Image-PE` 提示词扩写模型是可选项，首次部署不引入；也不需要先接在线扩写 API。
- 模型使用原生固定 **6 步**采样。首次验证不改步数、不引入量化或性能调优。
- 默认最小生成画布为 2048×2048；请求更小的输出可能仍先在较大画布生成再缩小，不能仅凭输出尺寸推断计算量。

### 2.2 上游支持范围与 Calculet 不能混同

MiniMax 官方 GitHub 主要提供说明、效果和请求示例；实际模型推理依赖 SGLang、vLLM-Omni、Diffusers 等框架，不是克隆 MiniMax 仓库就获得完整本机推理实现。

已经找到 H3-Image 的 **昇腾 NPU** 部署文档，但它依赖昇腾驱动、`torch_npu`、HCCL 和相应设备，不能当作 Calculet 的安装说明。公开资料中尚未取得 H3-Image 的 Dope 专属适配或可直接运行的 Calculet 启动命令。

Calculet SDK 中已有 `examples/minimax_h3`，但必须区分：

- 它针对 **MiniMax-H3 音视频生成**，不是本次目标 H3-Image。
- 示例固定 **16 芯粒**，不是目标机器的两芯粒；不能只改芯粒数量而不核对分片、布局、内存和通信。
- 原始 README 明确写着“**全部没有上板、没有数值验证：现在只到 calbin 编得出来**”。

因此它只是移植参考，不是本次部署成功的依据。

## 3. 目标服务器快照

以下均来自用户提供的只读采集报告，不是本记录新增实测。可用内存、磁盘和设备占用会变化，执行前须重新确认。

### 3.1 硬件与设备

| 项目 | 采集内容 |
| --- | --- |
| 主机 | `calculet-MS-A2`，MS-A2 |
| CPU | AMD Ryzen 9 9955HX，16 核 32 线程 |
| 主机内存 | 约 59 GiB，采集时可用约 55 GiB；Swap 8 GiB |
| 存储 | 1 TB NVMe，采集时剩余约 769 G |
| 系统 | Ubuntu 26.04 LTS，内核 `7.0.0-38`，x86_64 |
| 设备节点 | `/dev/calculet0`，一块板 |
| PCI 枚举 | `0000:07:00.0`，`20f5:c001`，SDXI 控制器类别 |
| 芯粒 | 2；使用者另确认每芯粒 16 核，不能直接映射成 SDK 的 `cores` 参数 |
| PCIe 链路 | 报告为 16 GT/s ×4；这是链路协商信息，不是实测模型吞吐 |
| 内核驱动 | `calculet` 1.1.4 |
| 设备状态 | 采集时 active、Health good，设备 OS／运行时已启动 |
| 运行时协议 | rt 3.1／ABI 1.1／线协议 rev 2；采集报告称与本机 dort 兼容 |
| NPU 物理内存及每芯粒可用量 | **尚未取得确切数据** |

该设备不是 CUDA 显卡，但仍通过 PCIe 连接。不能因为 PCI 类别显示 SDXI 就否定其加速能力，也不能把主机的 59 GiB 内存当作 NPU 内存。

### 3.2 软件与资源

| 组件 | 用户报告的版本／位置 |
| --- | --- |
| 离线套件 | `~/dope-kit` |
| `dort` | 0.4.1，`~/dope-kit/dort` |
| Python | 3.14.4，`~/dope-kit/venv` |
| vLLM | `0.32.0+dopame`，加 `vllm_dope` 0.0.1 |
| PyTorch | `2.13.0+cpu`，加 `torch_dope` 0.1.0 |
| Triton | 3.7.1，加 `triton_dope` 0.2.3 |
| 其他 | `calcc` 0.3.0、`dopeadapter` 0.0.1、`flag_gems` `5.0.2+dope` |
| `pycalrt` | `/usr/local/pycalrt`，libcalrt 1.1.6；报告称按 Python 3.10 编译 |
| 已提供模型 | Qwen2.5-0.5B-Instruct HF 权重，以及单双芯 calbin |
| Rust／`docc` | 采集报告称服务器未安装；原先的编译在另一容器进行 |

`torch` 带 `+cpu` 不等于没有第三方 NPU 接入能力；但安装 `torch_dope` 也不等于具备完整算子覆盖。`pycalrt` 的构建 Python 版本与当前 venv 不同，只能列为待核查项：需确认真实加载路径和扩展 ABI，不能直接判定失败或盲目降级 Python。

## 4. 本轮最重要的确认：HF＋Dope 与 calbin 是独立模型入口

用户提供的套件 README 原文：

> calbin 是 dort/pydort 的格式；vLLM 走 HF 权重 + dope 后端，不读 calbin。

```text
路径 A：HF 权重／配置 → vLLM＋Dope 后端 → 厂商运行时 → NPU
路径 B：已打包的 calbin → dort／pydort → NPU
```

两条路径可以共享底层运行时，但 HF 路径不以加载整模型 calbin 为前提。后续优先检查 Python 后端的模型接入范围，不再把 tiny 的 `.cvxo` 如何上板作为 H3-Image 的必经步骤。

[01-setup.md](../01-setup.md) 已记录 tiny 原生 calbin 的生成和静态检查，因此不能再笼统说“完全没有打包办法”。仍未验证的是该编译环境产物与服务器 `dort 0.4.1` 的实际兼容性、输入输出契约和真机执行；这与 H3-Image 的 HF 接入调查分开处理。

### 4.1 双芯 vLLM 脚本的关键配置

| 配置 | 脚本值／含义边界 |
| --- | --- |
| 插件选择 | `VLLM_PLUGINS=dope` |
| 模型输入 | `MODEL_DIR` 指向 HF 模型目录，不传入 calbin 路径 |
| 后端 | `backend="dort"` |
| 图与权重准备选项 | `graph="off"`、`prepack="linear"`；不能仅凭配置名推断完整模型编译能力 |
| 双芯放置 | `placement="layers"`、`placement_chips=2`，Qwen 按层分片 |
| 执行池 | 默认 `POOL_BYTES=8589934592`，即 8 GiB；不是设备物理容量 |
| KV 预算 | 默认 1 GiB，面向 Qwen 文本生成，不是 H3-Image 的通用内存配置 |
| 精度 | vLLM 参数 `--dtype bfloat16`；不证明 H3-Image 的混合精度算子均可用 |
| 离线模式 | `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1` |
| 服务 | 默认监听本机 `127.0.0.1:8000`，示例提供 `/v1/models` 和 `/v1/chat/completions` |

套件 README 报告 npu3 的 Qwen 单双芯正常出词，这不是目标机器已经复现，更不是 H3-Image 验证。Qwen 的双芯按层配置也不能直接外推为任意模型的分片方案。

**不能仅把 `MODEL_DIR` 换成 H3-Image 就宣称完成部署。** H3-Image 是扩散图像流水线；当前脚本是文本生成服务，现有普通 vLLM 插件与 vLLM-Omni 的图像模型执行能力不能混为一谈。脚本里的 token sampling 配置也不代表已经支持扩散去噪调度。

### 4.2 已取得的静态解析帮助

用户实际提供：

```text
dort calbin parse --help
解析并报告内容：子模型、张量、内存预留与权重分片。
纯静态，不开设备。
Usage: dort calbin parse [OPTIONS] --filepath <PATH>
-f, --filepath <PATH>  calbin 目录
-j, --json             JSON 输出
-i, --index <INDEX>    只看这一个设备；默认列出全部
```

本轮仅取得帮助，没有据此解析或运行任何实际包。不能把另一版本 `dort` 的参数拼到这里使用。

## 5. 当前阻塞项与执行约束

1. **Python 后端能力未知。** 需确认设备注册名、一般 eager／`torch.compile` 支持、模型专用入口、CPU fallback，以及 BF16／FP32、Attention、RoPE、归一化、卷积和图像解码相关算子覆盖。
2. **图像前端未知。** 需确认是否安装兼容的 Diffusers／相关依赖，以及 Dope 是否有现成扩散模型桥接。公开 Rust SDK 不能替代这部分本地实现证据。
3. **容量未闭环。** 约 135 GB 的文件规模不等于必须同时常驻，但当前主机只有约 59 GiB RAM，NPU 物理内存／预留／可用量尚不明确，不能直接照搬常规全量加载或 CUDA offload 方案。增大 `POOL_BYTES` 不会增加物理内存。
4. **不要破坏原厂依赖组合。** 暂不升级套件 venv 中的 vLLM、Torch、Triton，不先在其中安装新版图像依赖；先查兼容要求，再确定隔离环境方案。
5. **共享设备必须协调。** 采集时有其他容器中的服务占用 NPU，当前状态需重查。共用账号不能推定作业归属；没有锁文件不代表设备空闲。`DOPEADAPTER_BOARD_WINDOW=yes` 也不代表已经获得资源窗口。
6. **不使用全局停服务命令。** 套件 README 的 `pkill -f ...` 可能影响其他人的 vLLM；本调查不执行它，也不停止已有容器。锁只有在各方共同遵守同一约定时才有协调作用。

## 6. 下一步：只读检查 Dope 包入口

**以下是待执行的采集命令，不是已完成结果。** 它只读安装元数据和源码文本，不导入业务后端、不调用模型、不主动请求设备执行；`-I -S` 用于隔离当前目录并跳过 site 启动钩子。输出如含凭据应先打码，不能将凭据提交到仓库。

在目标服务器终端执行：

```bash
"$HOME/dope-kit/venv/bin/python" -I -S - <<'PY'
import importlib.metadata as metadata
from pathlib import Path
import sysconfig

site = Path(sysconfig.get_path("purelib"))
print("site-packages:", site)

wanted = ("torch-dope", "vllm-dope", "diffusers", "accelerate", "vllm-omni")
packages = {}
for dist in metadata.distributions(path=[str(site)]):
    name = (dist.metadata.get("Name") or "").lower().replace("_", "-")
    if name in wanted:
        packages[name] = dist

for name in wanted:
    dist = packages.get(name)
    print(f"\n===== {name}: {dist.version if dist else '未找到安装元数据'} =====")
    if dist is not None and name in ("torch-dope", "vllm-dope"):
        print("entry_points.txt:")
        print(dist.read_text("entry_points.txt") or "(无)")
        print("top_level.txt:")
        print(dist.read_text("top_level.txt") or "(无)")

for module in ("torch_dope", "vllm_dope"):
    path = site / module / "__init__.py"
    print(f"\n===== {path} =====")
    if path.is_file():
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        for number, line in enumerate(lines[:180], 1):
            print(f"{number:4}: {line}")
    else:
        print("此路径不存在，需按上面的入口信息定位。")
PY
```

拿到输出后，继续定向阅读入口引用的注册和执行实现；不能仅凭入口存在或依赖包安装就判断算子覆盖。若仍有源码／ABI 缺口，向厂商确认，不凭包名编造运行命令。

## 7. 后续部署决策与验收顺序

- **若一般 PyTorch 执行与所需算子可用：** 优先评估 Diffusers → Dope 接入，再验证具体组件；不是现在直接承诺这条路线已经可运行。
- **若只有指定 LLM 或模型编译支持：** 先明确扩散前端、导入／转换与执行适配的缺口，不把替换 HF 路径当作完成移植。
- **获得明确设备窗口后：** 先复现本机原厂 Qwen 基线，再按选定路线做算子／模块验证，最后进行 H3-Image 单张文生图。
- **首次图像验收：** 固定模型版本、详细英文提示词和 seed，batch 1，先验证 2048×2048 与原生 6 步；后续再检查推荐大尺寸和图像编辑，不先做性能优化。
- **保留证据：** 环境版本、真实 NPU 执行日志、输出图片、各模块与参考实现的数值对比，以及 CPU fallback 范围。远程 API 出图、CPU 兜底出图和仅启动 HTTP 服务均不能代替 NPU 模型验收。

**下一个可报告的进展是“后端入口与能力范围已确认”，不是“模型已部署”。当前没有 H3-Image NPU 出图、精度通过率、耗时或吞吐结果。**

## 8. 资料入口

- [前序 tiny 环境／编译／打包记录](../01-setup.md)
- [MiniMax H3-Image 官方 GitHub](https://github.com/MiniMax-AI/MiniMax-H3-Image)
- [Hugging Face 模型页](https://huggingface.co/MiniMaxAI/MiniMax-H3-Image)
- [Diffusers H3-Image 文档](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3_image)
- [vLLM-Omni H3-Image 昇腾方案，非 Calculet 教程](https://github.com/vllm-project/vllm-omni/blob/main/recipes/MiniMaxAI/MiniMax-H3-Image-NPU.md)
- [Calculet 原始快速开始](http://115.159.82.89/quickstart.md)
- [Calculet H3 音视频示例，固定源码快照](http://115.159.82.89/git/calculet/calBLAS/src/commit/32d2bb83d7160a593eaab67aa02e5dddbc8706cf/examples/minimax_h3/README.md)

上游文档和服务器状态会变化。后续更新应保留证据来源和实测边界，不将不同版本的 SDK／运行时命令混用，也不把历史快照写成当前设备状态。
