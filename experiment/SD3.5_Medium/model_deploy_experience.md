# 模型下载、部署与迁移经验：从 SD3.5 Medium 复用到其他模型

整理日期：2026-11-15。适用项目：原粒 NPU 赛题5；当前案例为 Stable Diffusion 3.5 Medium。

**用途：为后续模型建立可复用的下载、环境、参考、适配、部署、验收与排障流程，而不是提供一个对任意模型均有效的自动转换器。**

**当前实测边界：已有真实 Linear 子图的 NPU 输出，以及一张端到端 HYBRID 生图预览。该图仅在每个去噪步骤把首层 Q 投影交给 NPU，其余主要计算仍为 CPU；完整核心计算迁移、正式图像质量验收和 NPU 训练均未完成。**

本文件是专题经验手册，不是新的 schedule 快照。历史进度不回写；后续方法更新须保留版本与实测边界。基础环境与 tiny 记录见 [01-setup.md](../01-setup.md)，总体实验方法见 [02-guide.md](../02-guide.md)。

## 1. 先按 NVIDIA/CUDA 经验定位职责

下面是职责对照，不是替换命令名后就能兼容。

| 熟悉的 NVIDIA 操作 | Calculet 对应职责／入口 | 不能直接类比的地方 |
| --- | --- | --- |
| `nvidia-smi` 查设备 | `dort overview`、`board`、`telemetry`、`processes` | 驱动指标和统计口径不同，0 W／0% 不自动证明没有计算 |
| `nvtop` 实时查看 | 当前 CLI 可配合 `watch` 刷新遥测与进程 | 没有已核实的 nvtop 即插即用支持，不编造 `dort top` |
| `CUDA_VISIBLE_DEVICES` | 显式设备编号、板锁、资源与会话配置 | 不使用未经核实的同名 NPU 环境变量；没有锁文件不等于空闲 |
| `model.to("cuda")` | 已支持的 TorchDope 算子路径或模型专用适配 | 改成 `to("dope")` 不代表整模型所有算子都兼容 |
| CUDA kernel／PTX／cubin | Rust kernel／CalVX／原生 ELF；静态路线再打包 calbin | CUDA 二进制不能直接在 NPU 使用 |
| 编译 CUDA 扩展 | 配套 Rust／Triton-Dope／calcc 等编译链 | 取决于具体路线，不要求每个 Python 模型先生成整模型 calbin |
| 显存分配 | 设备层分配、池区、工作区和运行时合同 | 服务器磁盘、主机 RAM、板卡 DDR 是不同资源 |
| `compute-sanitizer` | 静态包检查、运行时守卫、数值差分各管一部分 | `docc calbin doctor` 不是通用运行时内存检查器 |
| CUDA Events／Nsight | 设备层执行记录与平台支持的剖析资料 | 没有已核实的一一对应；SSH／Python 总耗时不是 kernel 时间 |
| GPU 微调／训练 | 需另行验证反向、优化器、通信与保存恢复 | 推理可运行不代表 NPU 能直接训练 |

## 2. 完成标准和证据等级

把每次工作明确归入以下阶段，不能混用“跑通”：

1. 权重／代码下载完成。
2. 参考环境能构造输入并取得输出。
3. 必要适配能编译或导入。
4. 产物已到服务器磁盘，身份一致。
5. 设备实际执行并返回有效输出。
6. 输出按事先明确的数值／质量合同验收。
7. 完整目标流程可复现，再开展性能优化。

文件哈希只证明字节身份；工具自检只证明工具对应场景；单个算子只证明该算子和输入；图片文件存在也不证明 NPU 参与。完整迁移还需要真实执行轨迹及 CPU/NPU 分工。

当前案例的256×256、4步、无 T5 预览只完成阶段性的混合执行闭环，不是最终画质或完整 NPU 迁移成果。

## 3. 三个位置、两套运行环境

| 位置 | 职责 | 本案例 |
| --- | --- | --- |
| 本地 Linux 开发环境／容器 | 下载、模型分析、参考、适配及必要编译 | 项目目录曾使用 `/data/tianjin_hackthon/sd35-medium` |
| 板端服务器 | 接收材料、核对运行条件、调用设备和读回结果 | 用户分配的 Linux x86_64 服务器，原厂套件在 `~/dope-kit` |
| NPU 芯片内存 | 执行设备算子，持有本次所需数据 | 不是可 SSH 浏览的“模型文件夹” |

生图案例进一步将环境拆开：

- **CPU 生成环境：** 独立 venv，PyTorch `2.13.0+cpu`、Diffusers `0.31.0`、Transformers `4.51.3`，负责完整框架和大部分计算。
- **NPU worker 环境：** 使用服务器现成 `~/dope-kit/venv/bin/python`，只读复用厂商 TorchDope／DopeAdapter 等依赖，执行明确的设备请求。
- 两者通过项目内的 SSH 数据桥接交换真实张量，不共享全局 pip 安装状态。

不要在原厂 venv 里直接升级 Torch、Triton、Transformers 来满足另一个模型。也不要假定“用一个 venv 的 Python 创建另一个 `--system-site-packages` venv”就自动继承了原 venv 的包；应明确实际解释器、site-packages 和二进制 ABI 来源。

### 新环境起点

先确认系统／架构、Python、Git、curl、证书、venv 和编译工具是否存在。Docker 仅是本案例的本地 Linux 载体，不是所有部署都必须安装的组件。驱动、固件、SDK 和厂商 wheel 必须取自获授权的配套来源，不能根据包名在 PyPI 随意寻找替代品。

在对应 Linux 环境分别检查：

```bash
uname -m
```

```bash
python3 --version
```

```bash
command -v git curl python3 cargo docc dort
```

缺少工具时，由具备相应权限的操作者按该系统的软件源安装；不默认有 sudo，也不自动修改共享驱动。Rust 静态路线的安装顺序与审阅脚本要求见 [01-setup.md](../01-setup.md)。不把 HTTP 安装脚本直接管道到高权限 shell。

本案 NPU 套件使用 Python 3.14。某个旁置 `pycalrt` 目录按 Python 3.10 构建，不等于本案逐算子路径必须降级到3.10；需看实际 import 路径及 CPython／abi3 合同。新模型的官方 Python 要求可能不同，应在环境边界解决，而非替换厂商解释器。

## 4. 为新模型建立“迁移档案”

下载前先填写这些字段：

| 字段 | 要记录什么 |
| --- | --- |
| 身份 | 模型 ID、发布方、许可、固定 revision，代码版本与权重版本分别记录 |
| 任务 | 文生图／语言／视觉／语音，最终输入输出及质量要求 |
| 组件 | 主干、文本编码器、tokenizer／processor、VAE／decoder、scheduler 等 |
| 首次输入 | batch、尺寸／长度、seed、dtype、采样及 guidance |
| 权重 | 格式、分片、张量名／形状、源与转换后指纹 |
| 前端 | 对应 pipeline／模型类及依赖版本，不固定套用 SD3Pipeline |
| 设备路径 | 静态 calbin、TorchDope eager 或其他已确认路径 |
| 覆盖缺口 | 算子、shape、布局、精度、动态控制和反向需求 |
| 分工 | CPU/NPU 具体阶段、允许的回退和未迁移核心 |
| 验收 | 参考来源、误差／质量合同、设备证据和性能计时边界 |

不能只改 `MODEL_ID` 就继承旧模型的 shape、编码器、权重布局、分辨率和采样规则。例如 MiniMax-H3-Image 的固定6步设定不能套用 SD3.5 或其他模型。

## 5. 工作目录、路径恢复与文件隔离

以下是通用目录模板，不是要求回退到某个历史绝对路径：

```text
PROJECT/
  models/          原始组件，按模型与revision隔离
  src/             审阅后的上游代码
  adapter/         团队的NPU接入实现
  reference/       固定输入和各自验收的参考
  weights/         转换后的布局／参数块
  artifacts/       每次构建、探针及部署批次
  outputs/         每次实际输出
  logs/            完整命令、错误与运行记录
  wheels/          固定依赖与指纹
  cache/           项目缓存，不混入公开仓库
```

以下命令是供 Bash 使用的配置模板。新模型必须替换模型 ID／revision 和项目名，不能原样照搬后宣称适配完成。

```bash
export PROJECT="$HOME/npu-projects/sd35-medium" MODEL_ID="stabilityai/stable-diffusion-3.5-medium" MODEL_REVISION="b940f670f0eda2d07fbb75229e779da1ad11eb80" MODEL_DIR="$HOME/npu-projects/sd35-medium/models/sd35-medium"
```

确认目标目录没有待保留内容后创建自己的工作区：

```bash
mkdir -p "$PROJECT"/{models,src,adapter,reference,weights,artifacts,outputs,logs,wheels,cache}
```

新终端不会继承旧 shell 的所有变量或激活状态。恢复时重新设置项目变量，确认 `pwd` 和解释器路径，再激活正确 venv；不要看到 `command not found` 就重装整套环境。

下载／解压内容先放独立空目录，执行自编工具与数据目录分离。读取第三方模型元数据时可用 `python -I -S` 的标准库工具，不在下载目录直接 import 可能被同名文件遮蔽的模块；模型代码确需执行时，先审阅来源和依赖，不默认 `trust_remote_code=True`。

## 6. 先盘点已有文件，再决定下载

### 6.1 “下过模型”可能只是下了一个组件

本案最初本地模型目录只有 Transformer 的 config 和约4.94 GB检查点，缺 CLIP、VAE、分词器及 scheduler。完整图像 pipeline 需要全部必需组件，不能用“Transformer 文件存在”代替组件齐全。

下载前查看已有项目目录、明确的缓存和原生副本；若完整文件在另一个目录，直接复用或只传缺项。不要因为客户端 cached login=false，就断言本地没有权重。

以下标准库脚本只列元数据，不下载、不哈希巨大权重、不导入模型：

```bash
python3 -I -S - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ['MODEL_DIR']).expanduser()
report = {'root': str(root), 'exists': root.is_dir(), 'components': {}}
if root.is_dir():
    for directory in sorted(p for p in root.iterdir() if p.is_dir()):
        files = [p for p in directory.iterdir() if p.is_file()]
        report['components'][directory.name] = {
            'file_count': len(files),
            'weights': [{'name': p.name, 'bytes': p.stat().st_size}
                        for p in files if p.suffix in ('.safetensors', '.bin')],
            'configs': [p.name for p in files if p.suffix == '.json'],
        }
print(json.dumps(report, ensure_ascii=False, indent=2))
PY
```

这只能发现文件，不证明它们正确、完整或受后端支持。还要阅读 `model_index.json`／官方清单：组件可能引用外部 repo、不同 subfolder 或 variant。最终必须核对实际 loader 使用的位置。

### 6.2 Hugging Face 授权与下载

1. 按模型页面接受许可／申请访问；Read Token 不能自动授予尚未取得的仓库访问权。
2. Token 在实际下载进程所属的用户和环境中可用。本地 Windows、Docker 内 root 与服务器用户的 `~` 不是一个目录。
3. 使用标准客户端解析 `HF_HOME`、`HF_TOKEN_PATH` 等配置，不自行猜固定路径。
4. 不把 Token 发聊天、放脚本／参数／Git，不使用 `set -x` 记录认证命令，不转发到不需要它的 NPU worker。

先准备独立下载环境，不在厂商 venv 中安装客户端。以下为可替换模板，不表示已经在空白机器重放过整份指南：

```bash
python3 -m venv "$PROJECT/.venv-download"
```

```bash
"$PROJECT/.venv-download/bin/python" -m pip install --index-url https://pypi.org/simple huggingface_hub
```

记录实际客户端版本；若所在网络需要其他已批准来源，记录实际索引与错误，不改全局 pip 配置或静默换版本：

```bash
"$PROJECT/.venv-download/bin/python" -c 'import importlib.metadata as m; print(m.version("huggingface_hub"))'
```

交互登录模板：

```bash
"$PROJECT/.venv-download/bin/python" -c 'from getpass import getpass; from huggingface_hub import login; login(token=getpass("HF Read Token (hidden): "), add_to_git_credential=False)'
```

只检查是否能解析到凭据，不输出其值：

```bash
"$PROJECT/.venv-download/bin/python" -c 'from huggingface_hub import get_token; print("token_present=", bool(get_token()))'
```

为新项目首次下载完整固定版本的通用命令：

```bash
"$PROJECT/.venv-download/bin/hf" download "$MODEL_ID" --revision "$MODEL_REVISION" --local-dir "$MODEL_DIR"
```

如果已有 Transformer，只补本案例无T5方案的缺项，可按文件清单限制下载；这是SD3.5特定示例，不适用于所有模型：

```bash
"$PROJECT/.venv-download/bin/hf" download "$MODEL_ID" --revision "$MODEL_REVISION" --local-dir "$MODEL_DIR" --include 'model_index.json' 'text_encoder/*' 'text_encoder_2/*' 'tokenizer/*' 'tokenizer_2/*' 'vae/*' 'scheduler/*'
```

仓库有重复格式／可选大组件时，不盲目全量拉取；新模型应重新确定必需清单。客户端版本不同须查看该版帮助，本案补件实测使用的是第6.3节的固定commit下载器。已知文件稳定就复用，权限错误不应导致重新下载已验收主干。

不推荐把完整 Token 直接写在 `echo "hf_..."` 命令中，因为可能进入 shell history。共享账号下，即使文件权限600也不能隔离同账号使用者；敏感授权宜在私有下载环境完成。误泄露后应由令牌持有者撤销／轮换，不将清理操作伪装成下载步骤。

### 6.3 魔搭／其他合法镜像

本案实际补件来源为魔搭仓库 `stabilityai/stable-diffusion-3.5-medium`，固定 commit：

```text
fe81289a07ee5ebe2410fa7bcf275cb6910145a5
```

下载器验证16个补件与 HF 固定版本对应文件身份一致，再补 CLIP×2、VAE、tokenizers、scheduler 和 model index；原 Transformer 复用。补件约1.8 GB。本案镜像记录标明发布身份未独立认证为原始发布者，不能仅凭仓库名字叫 Stability AI 就作身份背书。

对新模型采用同样原则：

- 核实具体模型仓库、许可和访问要求，不猜 repo ID，不以换源绕过访问控制。
- 分别记录两个平台的 revision；commit 字符串不相同并不自动表示张量不同。
- 大文件按可信的预期大小／SHA-256核对；小文件也可用固定版本的 Git blob 身份比较。
- 下载到 `.incomplete` 等独立临时文件，完成后核对再原子更名；不同 revision 不覆盖旧目录。
- 服务器忽略 Range 返回200时，不能继续把完整响应追加在旧片段后面；本案下载器对此显式处理。
- 文件身份匹配不证明许可、签名、模型质量或 NPU 兼容性。

若使用魔搭 SDK，应在独立下载环境安装、记录版本，并按该版本接口使用 `snapshot_download`。本案实测的是团队固定 commit 下载器，不能把未重放的 SDK 命令写成已实测。

## 7. 隔离依赖：参考端与设备端不要相互污染

### 7.1 先确认已有环境

用绝对解释器路径读取版本；`torch` 名称带 `+cpu` 不排除额外注册的 NPU 后端。只为盘点包版本时用 `importlib.metadata`，不要为了查版本先打开设备。

CPU 参考／完整框架可放项目独立 venv。模板：

```bash
python3 -m venv "$PROJECT/.venv-reference"
```

```bash
source "$PROJECT/.venv-reference/bin/activate"
```

### 7.2 本案可核对的依赖经验

- 子图参考使用 Python 3.14、PyTorch `2.13.0+cpu`，CPU wheel 来自官方 CPU index；已记录 wheel 与依赖指纹，并离线安装。
- 完整生图环境实际记录：Torch `2.13.0+cpu`、Diffusers `0.31.0`、Transformers `4.51.3`。
- 服务器 NPU worker 使用厂商现成环境，不要求它与 CPU 生成端安装同一套 Diffusers／Transformers。
- 安装源曾缺少 `setuptools>=77.0.3`。这属于包索引／依赖问题，不是模型或 NPU 执行失败；本案改用可取得匹配包的官方来源补齐。

对匹配 Python／架构的新参考环境，可按官方 CPU index 取得相应 Torch；以下是本案例版本的下载模板，不能在厂商 venv 里执行：

```bash
python -m pip download --index-url https://download.pytorch.org/whl/cpu --dest "$PROJECT/wheels" 'torch==2.13.0+cpu'
```

确认 wheel 与其依赖已齐全、来源及 SHA 已记录后，离线安装：

```bash
python -m pip install --no-index --find-links "$PROJECT/wheels" 'torch==2.13.0+cpu'
```

下载范围和可用 wheel 必须匹配目标解释器及 glibc／架构；不适用时按新模型和平台重新选版本，不安装错误 ABI 包。

以下是本案成功CPU生成环境的包元数据快照，也是重建同一案例时的依赖示例；该安装命令本身未在全新机器重放，不是对所有模型的推荐组合，且不能在NPU厂商环境中执行：

```bash
python -m pip install --index-url https://pypi.org/simple 'diffusers==0.31.0' 'transformers==4.51.3' 'accelerate==0.34.2' 'huggingface_hub==0.30.2' 'safetensors==0.8.0' 'numpy==2.5.4' 'Pillow==13.0.0' 'requests==2.34.2'
```

新模型若需要不同版本、T5分词依赖或其他扩展，应依其官方requirements另建矩阵；本案未加载T5，不能将其可选依赖当作已验证。保存实际安装版本、wheel来源与哈希；遇到安装索引缺包，只处理明确缺失依赖，不先重建全部环境。

本案使用过的入口导入检查如下，只证明依赖能导入，不加载模型或证明NPU兼容：

```bash
python -c 'from diffusers import StableDiffusion3Pipeline; print(StableDiffusion3Pipeline.__module__)'
```

## 8. 权重、参考和算子适配

### 8.1 权重身份与转换

先固定 tensor key、shape、dtype、字节序及源片段位置。转换到 kernel 需要的分块／对齐布局时，原件和转换结果分别记录指纹。

本案 Q 投影为 `[1536,1536]` BF16，bias `[1536]`；运算是 `X @ W.T + b`。HF 原始 W 按 `[N,K]` 存储，不能因数学上转置就未经核对改写参数块。固定小输入 `M=16` 只是第一轮单元验证，不是生图实际全部隐藏状态。

`tiny-pack` 不是任意模型转换器；每芯粒一个 `param_blk` 也不是所有后端的固定模型存储规则。

### 8.2 参考不是统一逐字节金标准

固定同一输入和权重，在正确工作的 CPU／GPU框架取得参考。必要时保留不同数值口径，例如 BF16、FP32、FP32最后舍入到BF16，明确累计及bias加入位置。

本案三份参考独立重算分别与各自存档一致，不代表它们彼此完全相等。KS1 的累计／舍入合同也不能自动视作 IEEE FP32 或某一版 CPU BLAS。

至少记录形状、dtype、有限性、最大绝对／相对误差、RMSE；低精度场景可辅以 ULP。阈值来自算子合同及模型质量要求，不编造“所有模型都小于某个通用值就通过”。参考不变时复用已验收文件，不每次部署都重算。

### 8.3 覆盖应按实际语义与形状判断

静态搜索只得到候选算子，完整覆盖还需结合固定配置的执行图、分解和实际调用。`aten` 名称相同，不保证 layout／shape／dtype 均可用；注册锁中的 accept 也不是任意输入的真机证明。

保留严格回退策略。缺算子时修复具体实现／布局或明确 CPU 分工，不全局开启 allow 后把 CPU 出图写成 NPU 完成。准备 mask、常量和元数据的 CPU 工作与主要神经网络前向应分别统计。

## 9. 选择实际可用的执行路线

### A. Rust／CalVX／静态 calbin

复用匹配的 SDK 工程与模板，在本地固定程序入口、形状、权重和布局，再调用 `docc` 生成原生包并运行 `doctor`。安装、目录平级与 tiny 命令见 [01-setup.md](../01-setup.md)。

`doctor` exit0只表示其硬性检查通过，必须保留警告。本案生成了两个 CCU ELF，但输入和输出各自的 ping/pong 同址；切换文本 `.cvx` 与二进制 `.cvxo` 输入，9个输出文件仍一致，没有修复问题。不能手改清单地址、授权标志或校验和后宣布正确。

### B. 已支持的 TorchDope／eager 逐算子

本案真实设备输出与混合生图采用此路线，而非执行上述受阻 calbin。

已读取的接口说明确认：

- PrivateUse1 设备名为 `dope`；`torch_dope.register()` 负责注册，不负责打开设备。
- `torch_dope.open_device(backend="dort", board=..., board_lock=..., pool_bytes=..., wait_s=..., journal=...)` 显式开真实设备。
- 默认后端可能是 `fake`，必须明确 `dort`；注册成功或 fake 测试不等于真机执行。
- 计算段可用 `torch_dope.fallback.exclusive()` 强制严格空名单，并记录前后 `calls`／`host_impl`。
- 设备要同步、正确释放；保持异常路径也有关闭和错误记录，不通过自动复位掩盖问题。

上述是已核查的接口与方法，不是任意 `model.to("dope")` 可运行的保证。新模型仍须实现它的实际接入、权重映射与必要 kernel。

静态路线受阻时可以评估真实支持的逐算子路线，保留旧包为失败证据，不能把改走另一条路写成原编译器问题已解决。

## 10. 容量与共享资源：先算真实工作集

文件大小用 GB、设备报告常用 GiB，先统一单位。峰值需要考虑同时驻留权重、活跃激活、工作区／重排副本、池内保留及运行时／外部作业，不能简单加整文件大小，也不能把池内已有权重再与整个池总量重复相加。

本案设备总 DDR 为64 GiB；每芯粒恰有独立32 GiB可用空间不是仅凭均分就能证明的事实。地址窗口不是物理容量，小池也不是跨进程隔离证据。

主机 RAM 与设备 DDR 不同；CPU offload、磁盘映射和分层流送需要实际加载器支持。低比特文件不等于设备低比特计算；若加载时还原全部 BF16，显存未必降低。量化还需要算子与质量验证。

进入真实执行前确认当前作业、fd、约定锁和地址分配合同。不因共用 UID、进程名叫 dort、没有锁文件或一帧 util0就猜资源归属；不停止他人服务，不刷新仲裁状态来强行抢占，不复位或刷写共享设备。

## 11. SSH 与服务器分发经验

### 11.1 先区分认证通道与远端 shell

密码只在真实 `password:` 提示后输入，无字符回显正常；不要在聊天或普通 `PS>` 命令提示符后输入。`ssh -N` 是保持通道，不一定出现服务器交互 shell。

新机器先由管理员提供主机密钥指纹，经受信渠道核对后建立 known_hosts；不能为赶进度关闭 host key检查。以下复用模板假设已确认目标身份，并在本地 Linux 使用，变量由分配信息填写：

```bash
export NPU_HOST='填写已确认的服务器地址' NPU_USER='填写分配的账号'
```

```bash
SSH_DIR=$(mktemp -d /tmp/npu-ssh.XXXXXX)
```

```bash
export CONTROL="$SSH_DIR/control"
```

```bash
ssh -M -S "$CONTROL" -o ControlPersist=1800 -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -f "${NPU_USER:?}@${NPU_HOST:?}"
```

先用本地控制检查确认，不把输入过密码、文件存在或返回 PS 当成功：

```bash
ssh -S "$CONTROL" -O check -o BatchMode=yes -o StrictHostKeyChecking=yes "${NPU_USER:?}@${NPU_HOST:?}"
```

若没有 `Master running`，先定位认证、socket或进程状态，不反复让操作者输密码。新 shell 要恢复 CONTROL 的真实值；不可把每次新建的随机目录名写成长期固定凭据入口。

### 11.2 本案关键坑：Windows 9p挂载不能承载该 mux 发布方式

本案 `/data` 实际位于 Windows 挂载盘。独立 AF_UNIX 实验表明：原始 socket 可连接，但 hardlink 发布产生不同 inode，最终路径 connect=ECONNREFUSED；原生 Linux `/tmp` 的同一实验正常。OpenSSH mux 的临时 socket 硬链接发布因此失效。

最终将 ControlPath 移到原生 Linux 私有 `/tmp` 目录后，实测 `Master running`、exit0，后续真实执行成功。早期围绕 `-f`／前台保持的猜测不能替代这个已证实原因；本案不能据窗口状态责怪密码反复错误。

不要只看路径名字判断文件系统，可在本地查实际挂载类型：

```bash
findmnt -T "$PROJECT"
```

`/tmp` 可用于短期 socket，不代表模型与唯一日志也应该永久放临时目录。模型、源码和结果需要持久保存；原生盘副本是性能／语义选择，不是新的模型 revision。

Windows Git Bash还会自动转换 `docker exec` 中的 Linux 绝对路径。需要时对单次 Docker命令使用 `MSYS_NO_PATHCONV=1`，或在容器 Python 代码中表达路径；这不等于修改全局环境配置。PowerShell命令语法不同，不把 Bash 指令原样粘贴执行。

### 11.3 分发不等于设备部署

仅传模型实际需要的产物／脚本／输入／参考，放授权私有目录。稳定大文件首次或变更时确认指纹；同批次两端已一致，不重复重传、重算或打包。

服务器接收包、解压、校验器 exit2保留阻塞，和网络传输失败是不同状态。本案38文件包已得到 integrity PASS，但原静态包仍BLOCKED；真实执行后来使用独立 eager路径，不是改旧门禁。

服务器磁盘目录不是芯片文件夹。NPU数据是在会话／分配生命周期内上传、计算、读回；会话关闭后不能声称完整模型仍永久常驻其中。

## 12. 真实生图闭环怎样证明

### 12.1 特定模型执行入口不是通用安装命令

本案团队程序 `generate_sd35.py` 和 `npu_q_worker.py` 属于模型专用接入代码，不是 pip 安装后自动出现的 SDK CLI。当前公共资料仓库没有包含完整可运行接入项目；复现该案例须经授权取得对应源码、环境与数据，或按本文方法重新实现自己的适配，不能把受控工作区路径当作已公开下载地址。

本案实际生成入口的参数合同为：

| 参数 | 作用 |
| --- | --- |
| `--model` | 本地完整组件目录，不是仅含Transformer的目录 |
| `--output` | 新的本次运行目录，避免覆盖已有输出 |
| `--socket` | 已确认可用的原生Linux SSH ControlPath |
| `--remote-worker` | 板端主机项目私有目录内的NPU执行程序 |
| `--remote-calls` | 板端主机新建的本批次调用／日志目录 |

换模型时，必须修改实际模型类、模块接入点、权重身份、shape及协议合同，不能仅替换参数中的目录名。

### 12.2 必须让真实设备返回值进入生成链

本案例并非在旁路跑一次 Q投影后再生成纯CPU图，而是：

1. 完整 `StableDiffusion3Pipeline` 从本地组件加载，CPU float32，无T5模式。
2. 找到真实 `transformer_blocks[0].attn.to_q`，将加载后的W/b转BF16后的哈希与设备端参数身份核对。
3. 用 NPU bridge 替换该模块的真实 `forward`。
4. 每步收到实际去噪隐藏状态 `[1,256,1536]`，转为BF16，分16个 M16 tile执行，全部行都使用NPU返回值。
5. 返回值恢复框架所需dtype，实际进入后续去噪；每步callback核对请求序号与latent身份。
6. VAE解码为PNG；保留生成参数、每步请求、回退计数、原始journal、输出图及源码指纹。

这里的SSH桥是向获授权 NPU worker提交真实算子任务，不是调用外部图片生成API。CLIP、其余DiT、scheduler、VAE、转换和行组装均在CPU，必须标为 **HYBRID**，`core_migration_complete=false`。

已跑通的烟雾配置：

| 配置 | 实测值 |
| --- | --- |
| prompt | `A red apple on a wooden table, soft natural window light, realistic photograph` |
| seed | 20261115 |
| 分辨率／batch | 256×256／1 |
| 步数／guidance | 4／1.0 |
| T5 | 本模型支持的 `text_encoder_3=None`、`tokenizer_3=None`；两个真实CLIP保留 |
| NPU范围 | 每步首层Q投影全部256行；4次请求、64个tile |
| 数值回退 | NPU计算段strict/exclusive，CPU fallback／host_impl计数为空 |
| 图片 | 有限像素、非恒定256×256 PNG；低步数预览，画面偏模糊 |

图像SHA-256：

```text
40c42cc65c16dede5a84226692e0a983d68f948298bc0a5ba8dd603811f6258d
```

这不是推荐给所有模型的采样配置，省略T5也不是所有模型可用的通法。分辨率变化会改变token行数；本桥接脚本锁定256行，不能只改height/width而不改shape合同、tile覆盖及输入输出字节数。

## 13. 验收材料与指标

每轮至少保留：模型／代码／SDK／环境版本，输入和权重指纹，真实执行源码，命令和完整错误，设备选择／运行配置，CPU/NPU分工，实际输出及比较口径。

- 子图：shape／dtype／有效字节数、有限性、误差、计算回退与真实设备记录。
- 完整图：prompt、seed、采样、guidance、分辨率、编码器配置、输出PNG和质量参考。
- 失败：第一个实际失败调用、原始错误和复现输入，不用“配置好了”代替结果。
- 性能：编译、加载、预热、传输、设备计算和端到端分别记录；同输入、精度和计算范围才有可比性。

本案单Q投影24576个BF16元素中24573个位一致、3个不同，最大绝对误差0.000244140625；没有据此批准整模型精度。原始DAJF journal保留，但未语义解码，不虚构kernel计时或加速比。

## 14. 监控与排障速查

下面只读命令供已经登录的 NPU Linux 服务器使用，路径以实际套件为准；不是本地 Windows PowerShell 指令。

```bash
"$HOME/dope-kit/dort" -i 0 telemetry
```

```bash
"$HOME/dope-kit/dort" -i 0 processes
```

```bash
"$HOME/dope-kit/dort" -i 0 -j claims
```

近似实时面板：

```bash
watch -n 1 -d "$HOME/dope-kit/dort -i 0 telemetry; $HOME/dope-kit/dort -i 0 processes"
```

`Used` 是CalRT报告的板级内存统计，不是某个PID的独占内存；19.1%内存占比与util0%计算利用率不同。监控命令本身也可能打开设备；当前采样0%不证明没有间歇NPU调用，也不证明整图正在生成。原始十六进制字段需按具体版本定义解释，不猜成百分比或错误码。

| 现象 | 先排查 | 不要做 |
| --- | --- | --- |
| 401／GatedRepoError | 实际下载进程的账号、模型许可、凭据路径，或合法镜像 | 再登录SSH、把Token贴聊天、重下已有主干 |
| `No matching distribution` | Python／架构／包索引和wheel标签 | 直接替换厂商Torch |
| setuptools依赖缺失 | 当前索引是否有匹配构建依赖，在隔离环境补齐 | 误报为NPU不支持模型 |
| socket存在但Connection refused | listener、文件系统和OpenSSH mux发布语义 | 一直重复输入密码、删除未知用户socket |
| doctor exit0但ping/pong同址 | 原生布局、执行合同、导出配置／版本 | 手改地址或用“只跑一次”宣称已修复 |
| 数据包PASS但执行BLOCKED | 哪条技术门禁仍未满足 | 把传输成功写成设备成功 |
| `dort` PID无法归属 | 及时只读查ps／父进程／cwd；退出后记录未知 | 共用UID或名字相同就认作本项目 |
| 图片出来但画质差 | 步数、guidance、编码器、precision、参考配置 | 将烟雾图当质量基准或全NPU证明 |
| 客户端API／网络流EOF | 原任务是否已开始、现有日志和回执，再断点恢复 | 重复启动同一生成、重传稳定包 |

`dort mem`、`dort reg`、`dort refresh-device-list`、`dort device reprobe`、`dort power-mode` 及其他重置／队列控制操作不能统称只读监控；执行前按具体版本和授权确认影响，不能用来强行解除他人占用。

## 15. 训练／微调：当前没有 NPU 实测

**本案例是推理迁移，没有完成 NPU 训练、LoRA 或全参数微调。当前SSH张量桥使用detach、原始字节和推理模式，不保留跨边界autograd图，不能直接接上 `loss.backward()` 就声称NPU训练。**

若新模型确实需要训练，另建明确任务并先确认：

| 方面 | 必需证明 |
| --- | --- |
| 反向能力 | 所需梯度算子／VJP、dtype／shape和设备autograd接入真实可用 |
| 优化器 | 参数／梯度／状态所在位置，是否真实在NPU更新，更新和同步正确 |
| 内存 | 权重、梯度、优化器状态、可能的FP32 master副本、激活、workspace及通信；不是推理占用简单乘2 |
| 数值 | 小输入与CPU/GPU梯度参考、有限性、参数更新和loss行为；一次loss下降不能当完整训练验收 |
| 数据与许可 | 数据集、模型许可、训练目标、保存策略及资源预算明确 |
| 恢复 | checkpoint保存／加载、随机状态和继续训练一致性 |
| 共享条件 | 专门的使用窗口和长时负载约定，不自动占满共享设备 |

不支持或未证明反向时，可在获授权的CPU/GPU环境训练后导出权重，再走NPU推理适配；必须写清训练不在NPU。未经明确数据／目标／预算，不自动启动训练或新增付费资源。

## 16. 换下一个模型时的执行清单

- [ ] 固定任务、模型ID、许可、代码与权重revision。
- [ ] 列出完整必需组件；先盘点已下载目录，不重下稳定文件。
- [ ] 建立独立参考环境和固定输入，确认官方配置能正确工作。
- [ ] 标出模型专用语义、算子、shape、dtype、布局与动态行为。
- [ ] 按真实支持选择静态或逐算子路线，而非强行复用旧脚本。
- [ ] 先用真实权重的最小子图验证设备链，再挂回真实forward，不能旁路做表演计算。
- [ ] 核对加载／工作区峰值、池区与资源隔离，不靠文件大小和瞬时util猜。
- [ ] 在有效窗口下执行并读回，保留真实输出、回退和参考比较。
- [ ] 串联完整流程，明确CPU/NPU核心分工；图像出现不等于完整核心迁移。
- [ ] 按模型自身的质量／数值合同验收，再优化性能和覆盖。
- [ ] 如需训练，独立验证第15节，不能继承推理“已支持”的结论。

单独改模型名不够。至少复核编码器个数、输入／token布局、注意力与mask、权重映射、kernel形状、采样调度、解码器及数值标准。

## 17. 复现边界、资料与两条工作线

本手册提供已验证经验、通用操作模板和新模型迁移清单，**不是已在全新机器重放通过的一键安装器**。模板须按目标模型、SDK版本、解释器和授权替换。完整团队桥接脚本、厂商wheel／源码、原始权重和受控运行日志未随本文公开；不能仅clone此资料仓库就假定它们已齐备。

实际案例定位：

- 单子图与离线审查：团队受控工作区 `ref/qproj-batch02-review-20261114/`、`ref/qproj-v2-work-20261114/`。
- 首个NPU输出：`ref/qproj-direct-probe.dhrjFD/first-npu-result.json` 与 `attempt-01-*`。
- 模型补件与完整混合图：`ref/sd35-generation-v1/runs/attempt-02/component-source.json`、`generation-final.json` 及原图。
- 本地源码核查：同项目 `ref/sd35-generation-v1/source/`；这些是受控定位，不是GitHub已公开附件。

公开入口：

- [团队实验指南](../02-guide.md)
- [tiny基础环境、编译与打包记录](../01-setup.md)
- [首个真实NPU子图快照](schedule_06.md)
- [Calculet SDK入口](http://115.159.82.89/)
- [SD3.5 Medium模型页](https://huggingface.co/stabilityai/stable-diffusion-3.5-medium)
- [PyTorch CPU wheel index](https://download.pytorch.org/whl/cpu)

工作分为两条工作线：**NPU覆盖与设计线**继续研究有效核心覆盖、布局和硬件利用；**部署经验线**整理方法、复现条件和边界。只有前者操作设备，避免并发写入；文档不能把建议、语法检查、镜像哈希或离线成功升级成训练／真机验收。

后续公开更新应采用客观团队口吻，保留来源和未验证项，不提交凭据、设备身份信息、真实参数包或未经允许公开的厂商材料。
