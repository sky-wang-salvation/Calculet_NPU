# Calculet NPU 运行手册：命令说明、离线构建与受控上板

整理日期：2026-11-14。面向第一次接触 Linux、Rust 和本套 NPU SDK 的开发者。

**本手册是团队公开维护的操作指南，不是厂商官方手册，也不代表任意模型已经迁移成功。** 文中将命令的含义、执行位置、前置条件、检查方式和停止条件分开说明。

<a id="cuda-migration"></a>
## 0. NVIDIA / CUDA 用户先看：命令与迁移对照

已有 NVIDIA 开发经验时，可以先按本节找到相同任务在 Calculet 流程中的位置，再跳到正文执行完整步骤。**这是任务与职责对照，不是将命令名、API 或文件后缀替换后就能运行的兼容说明。**

表内 NVIDIA 命令是常见用法示意，本次没有执行；`kernel.cu`、`kernel.ptx`、`./app`、`app.py` 是示例文件名，`...` 与 `<...>` 是省略和占位，不能原样当作完整脚本复制。CUDA Runtime、cuBLAS、cuDNN 是编程接口或库，不是 shell 命令。

### 0.1 按熟悉的 NVIDIA 操作定位 NPU 入口

| 任务 | NVIDIA / CUDA 侧常见做法 | Calculet NPU 侧入口 | 对应关系与迁移注意 |
| --- | --- | --- | --- |
| 核对编译器 | `nvcc --version` | `rustc +calculet --version --verbose`；另查 `command -v docc dort` | **近似职责**。这是不同工具的版本，不能只看默认 `rustc` 或把工具路径当版本证明；见[安装验收](#setup) |
| 查看设备与状态 | `nvidia-smi`、`nvidia-smi -L` | 先用本机 `dort --help` 查受支持的设备查询子命令 | **固定等价命令尚未核实**。`--help` 本身不产生设备状态报告，不把它冒充 NPU 版 `nvidia-smi`；见[设备授权](#authorization) |
| 选择设备 | `CUDA_VISIBLE_DEVICES=2,1 python app.py` | 已获授权的 `dort calbin run ... --index <分配下标>` | **只对照选择任务**。CUDA 变量还控制进程内可见性和枚举顺序；NPU 下标不能按 CUDA 逻辑编号直接照搬 |
| 配置开发环境 | CUDA Toolkit、主机编译器及项目依赖 | `rustup`、配套 `calculet`、`docc/dort` 与平级 SDK 源码 | **不同工具链**。装好 CUDA 或 PyTorch 不代表 NPU 工具链已经安装；见[环境准备](#prerequisites) |
| 编译设备代码 | `nvcc -c kernel.cu -o kernel.o` | `cargo build -p tiny --lib --target dopamine-unknown-none-elf` | **近似编译阶段，不同源码与产物**。CUDA kernel 不能交给 cargo 原样编译；这里是 tiny 示例，见[cargo 说明](#cargo) |
| 查看设备侧中间表示 | `nvcc --ptx kernel.cu -o kernel.ptx` | 检查本次生成的 `tiny.cvx` | **仅作理解类比**。PTX 与 CalVX 不互通，不存在改后缀即可转换的结论 |
| 准备完整执行入口 | 主机 `main`、CUDA 调用与设备 kernel 的配套构建 | tiny 使用 `--features step`，实际模型还需程序声明、图/计划与主机编排 | **不是单条编译命令的替换**。能编 kernel 不等于已有完整模型入口；见[完整程序](#cargo) |
| 设备原生产物生成 | `nvcc --cubin kernel.ptx -o kernel.cubin` 等 CUDA 构建阶段 | `docc calbin from-calvx <输入目录> --out <新输出路径>` | **职责部分相近，包不等价**。docc 流程还组织权重、清单、命令流等；`.cubin` 不是 calbin，见[打包](#docc) |
| 复用算子库 | cuBLAS / cuDNN | 按职责理解 `calBLAS` / `calDNN`，核对实际算子、shape、dtype 与接入方式 | **不是 API/ABI 兼容承诺**。不能改链接库名就复用所有实现 |
| 启动一次计算 | `./app` 或项目的 `python app.py` 通过 CUDA Runtime 启动计算 | `dort calbin run` 配合实际包、设备与模型名 | **近似启动职责**。`cargo run -p tiny-pack` 是 CPU helper，不是在 NPU 推理；见[运行参数](#dort-options) |
| 准备输入和读回输出 | 应用通过 CUDA Runtime 等接口组织传输、调用和同步 | 匹配包接口的 LLM 参数或适用的 `--raw-in/--raw-out`，必要时使用专用主机程序 | **不能逐个 API 机械对应**。raw 模式不会自动补齐多输入或 LLM 状态；见[模式边界](#raw-mode) |
| 检查部署包结构 | 按具体 CUDA 应用核对链接、文件与依赖，没有统一的跨项目单条命令 | `docc calbin doctor <包>` | **NPU 包的离线检查**。它不启动模型，也不证明设备数值正确；见[doctor](#doctor) |
| 查运行时内存错误 | `compute-sanitizer --tool memcheck ./app` | 本手册尚未核实可直接对应的 NPU 动态检查器 | **不是 doctor 的对应功能**。Compute Sanitizer 随应用运行检查 CUDA 访问等行为，doctor 检查包结构 |
| 分析性能 | `nsys profile ./app` | 先获取平台支持的 NPU 测量方法；保留实际部署、执行与输出日志 | **固定等价 profiler 命令尚未核实**。`--dump-layout`、doctor、总墙钟时间都不能直接当 NPU 核内性能分析 |
| 建立正确性基线 | 原项目的 CPU/框架参考与固定输入，具体程序由项目决定 | tiny 的 `tiny-ref`，或真实模型自己的参考程序 | **相同验证原则**。没有通用“CPU 参考命令”自动替代所有模型；见[输出比较](#outputs) |

NVIDIA 侧定义已按官方文档核对，短原文和来源见[对照依据](#nvidia-sources)；Calculet 侧仍以本手册已有的 SDK 帮助转录与团队记录为基础，没有因此新增真机验证结论。

### 0.2 先建立正确的编译链路模型

```text
CUDA 侧的职责示意：
  CUDA 源码与主机代码 → 编译/链接、可能的 PTX 与设备原生代码 → 应用与 CUDA Runtime → GPU 执行

Calculet 侧的本手册流程：
  Rust kernel 与完整程序声明 → CalVX → docc 原生生成与 calbin → dort/配套主机程序 → NPU 执行
```

这是为解释职责而拆分的示意；CUDA 可以采用不同的提前编译、即时编译和打包方式，并非每个项目都显式留下独立 `.ptx` 文件。CalVX 与 PTX 处在可类比的位置，不代表两者指令集、二进制、内存模型或同步语义兼容。

`calbin` 也不是“把 CUDA 可执行文件换个后缀”：源程序、算子语义、张量布局、真实权重和运行接口都要匹配目标实现。默认 tiny kernel 编译、启用 `step`、docc 打包和 dort 上板是不同阶段。

### 0.3 最容易误判的四个对应关系

1. **`nvidia-smi` 显示的 CUDA 版本不等于 `nvcc` 版本。** 驱动支持的 CUDA 能力与已安装工具包可能不同；迁移时分别记录驱动/运行环境、编译器和库。同理，NPU 设备报告不能代替 SDK 工具链版本记录。
2. **`CUDA_VISIBLE_DEVICES` 不等于 NPU 的 `--index`。** NVIDIA 官方文档说明，`CUDA_VISIBLE_DEVICES=2,1` 后，CUDA 进程内逻辑设备 `0` 对应原设备 `2`；不要将该逻辑编号、PCI 顺序、芯粒编号和 NPU 运行器下标混为一谈。CUDA 环境变量也不是 NPU 设备选择协议。
3. **`doctor` 不等于 Compute Sanitizer。** 前者可离线检查 calbin，后者的 memcheck 是 CUDA 应用的运行时检查；doctor 无拒收不能推出没有越界、竞争或数值错误，尤其不能忽略 ping/pong 同址警告。
4. **`--dump-layout` 不等于 Nsight Systems。** 前者显示实际部署落点，Nsight 的 `profile` 会启动应用进行分析。CPU/主机时间线即使能采集，也不能在没有专门支持的证据时直接解释成 NPU kernel 内部耗时。

### 0.4 从 NVIDIA 工程迁移时按什么顺序推进

1. **先保留原工程基线。** 固定模型、源码、真实权重、输入 shape/dtype、随机配置与参考输出，而不是先替换全部依赖。
2. **保留可复用的主机逻辑，识别不可直接复用的核心计算。** 预处理、后处理和参考程序可以按项目条件复用；CUDA/Triton kernel、CUDA 扩展和设备专用布局需要面向目标实现适配。不能假定把 `.cuda()` 改成 `.npu()` 就已取得完整兼容后端。
3. **按 Calculet 链路做最小离线验证。** 从 tiny 学会完整程序、权重与原生包的组织，再验证真实模型所需算子和子图；不是把 tiny 的测试权重当成目标模型。
4. **在授权窗口验证真实 NPU 计算。** 核对设备、包和输入，执行受控单次计算并读回结果；已有静态检查不能代替这一步。
5. **先正确，再扩大规模与优化。** 对照同一基线检查数值与可重复性，再使用已确认的测量口径分析瓶颈，不把改命令后“能启动”当成迁移完成。

完整迁移方法见 [02-guide.md](02-guide.md)，本手册下文继续按实际命令解释操作细节。

## 阅读前必须知道的边界

- 团队已发布的 tiny 记录包含 CPU 参考、CalVX 编译、原生打包和离线检查；该记录不包含 tiny 的 NPU 数值正确性与性能验证。
- 本次编写没有安装 SDK、重放整套空环境流程、连接服务器或运行 NPU。新增命令组合需要在实际环境中验证。
- 本次访问厂商公开入口返回 HTTP 502，未取得新的厂商源码版本。运行参数依据已提供的完整终端帮助转录，**使用前必须核对所在机器的 `--help`**，不能假定历史默认值永远不变。
- 公开仓库的调研、团队终端记录、厂商原文和真机实测是不同证据。来源、失败的取证记录及哈希见[附录](#sources)。
- 所有真机命令都以已取得设备授权、明确设备编号与使用窗口为前提。没有这些条件时，只进行离线部分。

## 目录

0. [NVIDIA / CUDA 用户先看：命令与迁移对照](#cuda-migration)
1. [先分清在哪里运行](#locations)
2. [工具与文件分别是什么](#concepts)
3. [Linux 命令入门与复制规则](#shell)
4. [首次使用：基础依赖与网络](#prerequisites)
5. [源码、Rust 与 SDK 安装](#setup)
6. [创建独立实验目录与恢复终端](#workspace)
7. [理解 cargo：编译 tiny 与 CPU 参考](#cargo)
8. [理解 docc：生成原生 calbin](#docc)
9. [理解 doctor：检查结果不是运行结果](#doctor)
10. [版本、完整日志与哈希归档](#evidence)
11. [真机前的授权与共享设备检查](#authorization)
12. [将实验目录交给板端主机](#transfer)
13. [dort 参数逐项解释](#dort-options)
14. [tiny 单次运行候选流程](#tiny-run)
15. [单算子裸字节模式与图像模型边界](#raw-mode)
16. [如何理解和比较输出](#outputs)
17. [常见错误按阶段排查](#troubleshooting)
18. [命令风险速查与发布原则](#checklist)
19. [来源、证据与版本说明](#sources)

<a id="locations"></a>
## 1. 先分清在哪里运行

“本地”“服务器”“设备”并不是同一层。登录到一台 Linux 主机，也不意味着已经在 NPU 上执行计算。

| 位置 | 主要工作 | 能否据此宣称 NPU 已正确执行 |
| --- | --- | --- |
| Windows 桌面、编辑器或浏览器 | 阅读、编辑文档、管理代码 | 不能 |
| Linux x86_64 开发环境，包括匹配的容器或 WSL 环境 | 下载 SDK、生成参考、适配算子、交叉编译、打包、离线检查 | 不能；是否兼容仍以实际 SDK 为准 |
| 连接 NPU 的板端主机 | 选择分配的设备、部署、组织输入、调用运行时、读回结果 | 需要进一步核对部署和运行日志 |
| NPU 板卡 | 执行已经编译并正确部署的程序 | 仍需与参考输出比较，不能只看“结束” |

开发机和板端主机可以是同一台机器，但职责必须分清。

### 1.1 两种“推送”不是一回事

- `git push`：将代码或文档提交发送到 GitHub，不会启动 NPU。
- 将 calbin 传到服务器：只是传文件，不等于已经部署到板卡。
- `dort calbin run`：按运行器行为部署并执行设备程序，涉及共享设备状态。

### 1.2 当前能做哪部分

| 当前条件 | 建议做到哪里 |
| --- | --- |
| 只有普通 Linux 开发环境 | 完成第 4～10 节；没有板卡也能准备编译和检查材料 |
| 能登录服务器，但没有设备使用授权 | 仅核对经允许的文件、工具帮助和环境，不部署、不运行 |
| 已有分配设备与时间窗口 | 先满足第 11 节，再按配套版本进行受控单次验证 |
| 已有可信的单次正确结果 | 明确缓冲区和同步安全后，再安排重复性与性能实验 |

<a id="concepts"></a>
## 2. 工具与文件分别是什么

### 2.1 工具关系

| 名称 | 在本流程中的职责 | 常见误解 |
| --- | --- | --- |
| `git` | 获取与管理源码版本 | 克隆代码不等于安装全部依赖 |
| `rustup` | 安装和选择 Rust 工具链 | 安装 rustup 不等于已安装所需定制编译器 |
| `rustc` | Rust 编译器 | 系统默认 stable 不一定能生成 NPU 代码 |
| `cargo` | 构建 Rust 工作区、运行主机侧工具 | `cargo run` 不一定是在 NPU 上运行 |
| `calculet` | 本流程使用的定制 Rust 工具链名称 | 不是可以替换任意 CUDA 后端的通用兼容层 |
| `npu` | NPU 存储、原语、kernel 与程序声明 | 包名不代表全部硬件能力已自动暴露 |
| `calDNN` | 图、算子接口与执行计划 | 有接口不等于某个实现已支持所有 shape |
| `calBLAS` | 算子实现、特化与示例 | tiny 测试权重不是任意真实模型的权重 |
| `docc` | 将完整 CalVX 程序生成原生产物、打包及离线检查 | `wrote` 不代表已经上板 |
| `dort` | 按实际子命令查询或操作设备、部署与运行 | `--deploy-only` 仍然会改变设备状态 |

### 2.2 文件关系

```text
Rust 源码与程序声明
    → 设备侧编译：.cvxo 与可读 .cvx
    → 完整程序 + 对应权重：docc 生成原生产物并打包 calbin
    → doctor：离线结构检查
    → 经授权部署与运行：读回设备输出
    → 与相同输入、权重、数值语义的参考比较
```

| 文件或目录 | 含义 |
| --- | --- |
| `Cargo.toml` | Rust 包名、依赖、feature 和工作区配置 |
| `rust-toolchain.toml` | 该目录选用的工具链 |
| `.cargo/config.toml` | cargo 源、目标等配置，具体以实际文件为准 |
| `.cvxo` | CalVX 目标文件，不应随意改后缀伪装成汇编文本 |
| `.cvx` | 可读 CalVX；本流程按打包约定使用其完整程序版本 |
| `step.cvx` | 本文示例打包输入中的约定文件名，是完整 `tiny.cvx` 的副本 |
| `param_blk0.bin`、`param_blk1.bin` | 该 tiny 示例两芯粒的参数块，不是所有模型的通用布局 |
| calbin | 部署包概念；运行器帮助支持目录或打成单文件的 calbin |
| `ccu*.elf` | doctor 中可以看到的原生 CCU 镜像，不宜用镜像数推断物理计算核利用率 |
| `cpu-out.bin` | 主机 CPU 参考结果，不能当成模型输入或参数块 |
| `MANIFEST.sha256` | 文件哈希清单，用于核对同一份材料，不证明模型正确 |

### 2.3 “核”和“芯粒”不要机械换算

团队所述硬件配置是双芯粒、每芯粒 16 核；示例配置中的 `cores = 2` 是 SDK 程序语义，两者映射尚未核实。设备下标、芯粒编号、CCU 编号也不是可以相互替代的数字。

不要因为有两芯粒就把运行器 `--index` 设置为 `2`；也不要把示例源码直接改成 `cores = 16`。设备编号由授权环境确定，程序配置按配套 SDK 的语义确认。

<a id="shell"></a>
## 3. Linux 命令入门与复制规则

### 3.1 先看当前目录与用户

以下命令只显示当前 shell 的基础信息：

```bash
pwd
```

```bash
whoami
```

```bash
ls -lah
```

- `pwd`：显示当前目录，决定相对路径从哪里开始。
- `whoami`：显示当前用户。容器内的 root 不等于拥有宿主机或板卡权限。
- `ls`：列目录；`-l` 是详细信息，`-a` 包含隐藏项，`-h` 使用便于阅读的大小单位。
- 日志中的 `root@主机:目录#` 是提示符，不属于命令，不应复制执行。

### 3.2 路径与变量

| 写法 | 含义 |
| --- | --- |
| `/data/project` | 从文件系统根目录开始的绝对路径 |
| `target/tiny.cvx` | 相对于当前目录的路径 |
| `.` / `..` | 当前目录 / 父目录 |
| `$HOME` | 当前用户的家目录，不保证是 `/root` |
| `$SDK_ROOT` | shell 变量，本文用来保存 SDK 父目录 |
| `"$RUN_DIR/file.bin"` | 将路径作为一个参数传递，避免空格拆成多个参数 |

`export NAME=value` 将变量传给后续子进程；普通 `NAME=value` 至少对当前 shell 有效。新终端、重新 SSH、切换用户、进入容器后，变量可能不再存在。

`source 文件` 会在当前 shell 执行文件中的内容。只加载由团队创建并确认可信的环境文件，不能把下载的未知内容当配置直接 source。

### 3.3 长选项、短选项与 `--`

例如：

```bash
cargo run -p tiny-pack --bin tiny-ref -- /实际实验目录/weights 7 /实际实验目录/reference/cpu-out.bin
```

此处路径是说明用占位路径，不能原样作为复现命令。

- `-p tiny-pack`：cargo 选择包。
- `--bin tiny-ref`：选择该包中的主机程序。
- 第一个单独的 `--`：cargo 参数到此结束。
- 后面的目录、`7`、输出路径：传给 `tiny-ref`，不是传给 cargo。

`-o` 和 `--out` 在已记录的 docc 帮助中是同一输出选项的短、长形式。不能把所有工具中的 `-m`、`-d`、`-s` 都按同一个意思理解。

### 3.4 多行命令与退出状态

- 行末 `\` 表示命令续行；其后不能追加空格或注释。
- `&&` 表示前一个命令成功才继续；`;` 无论前一个是否成功都会继续。
- `$?` 是上一条命令的退出状态，一般 `0` 表示该命令成功；它会被下一条命令覆盖。
- `--help` 用来查看本机版本的参数，不是实际模型推理。

本手册中包含“候选”“占位”“仅在授权后”的代码块，不应整篇无差别复制成脚本执行。

### 3.5 日志与管道

`2>&1` 将标准错误并入标准输出；`tee 文件` 一边显示输出，一边保存日志。管道默认可能只反映最后一个程序的状态，不能因 `tee` 成功就认定构建成功。

在 Bash 中可先启用：

```bash
set -o pipefail
```

下面是有实验目录后的日志示例：

```bash
docc calbin doctor "$RUN_DIR/tiny-native-output" 2>&1 | tee "$RUN_DIR/logs/doctor.log"
```

该命令后立刻查看整个管道状态：

```bash
printf 'pipeline_exit=%s\n' "$?"
```

需要分别记录管道各程序状态时，应在管道后立即读取 Bash 的 `PIPESTATUS`；不要先执行 `ls`、`cat` 等命令。日志文件名重复时 `tee` 默认会覆盖，所以每次实验应使用独立目录。

<a id="prerequisites"></a>
## 4. 首次使用：基础依赖与网络

**执行位置：团队自己的 Linux 开发环境。不要在共享板端主机上擅自安装或升级系统软件。**

### 4.1 确认架构和发行版

```bash
uname -m
```

```bash
cat /etc/os-release
```

本文的 SDK 构建路径针对 Linux x86_64。ARM、Windows 原生 PowerShell、某个特定 WSL/容器配置能否兼容，不能只凭名称判断；不符合时先确认主办方支持的构建环境。

### 4.2 检查基础工具

```bash
command -v git curl cc make python3
```

`cc`、`make` 用于主机侧编译链接；`python3` 用于本文的可选输出分析。缺少工具时，先解决依赖，不要把所有报错都归因于 NPU 编译器。

对于允许自行管理的 Debian/Ubuntu 环境，可按权限选择一种方式：

| 用户状态 | 操作 |
| --- | --- |
| 自己的容器或虚拟机内已经是 root | 使用下面的 `apt-get` 命令，不需要再装 sudo |
| 自己管理的普通账号，且明确有 sudo 权限 | 经授权给下面两条命令加 `sudo` |
| 共享主机、托管容器或无管理权限 | 由管理员提供基础工具，不尝试提权或改公共环境 |

```bash
apt-get update
```

```bash
apt-get install -y ca-certificates curl git build-essential python3
```

这两条是发行版级的准备建议，不是本次编写时重放过的安装记录。其他发行版应使用其包管理方式，不照抄 apt 命令。

### 4.3 下载失败时的停止条件

- HTTP 502、超时、连接拒绝：保留完整错误，确认网络与服务状态，恢复后再下载。
- HTTPS 证书错误：检查系统时间、证书包和组织代理配置；不使用 `curl -k` 作为常规解决方法。
- 文件不存在、大小异常或下载中断：不继续执行安装脚本，不将错误页面当源码解压或交给 shell。
- 服务只提供 HTTP 时：阅读脚本并不能证明后续下载的二进制可信；隔离环境和主办方确认的分发渠道仍然必要。

本次厂商 HTTP 入口返回 502 的事实见[取证记录](ref/NPU-guide-20261114/collection-attempts.txt)，不能将本手册当作该服务当前可用性的保证。

<a id="setup"></a>
## 5. 源码、Rust 与 SDK 安装

**本节是面向新环境的操作说明；历史安装事实见 [01-setup.md](01-setup.md)，不代表本次编写已在空容器完整重放。已有匹配环境的读者可以核对版本后进入第 6 节。**

### 5.1 选择团队自己的工作目录

在个人开发环境中，以下使用家目录下的新工作区：

```bash
SDK_ROOT="$HOME/calculet-work"
```

```bash
mkdir -p "$SDK_ROOT"
```

如果这个账号或家目录与其他团队共用，应改为管理员分配的团队目录；不要把公共目录默认当成个人目录。

### 5.2 三个 SDK 仓库必须平级

仅在服务可访问且目标目录尚未被其他工作占用时克隆：

```bash
git clone http://115.159.82.89/git/calculet/calBLAS.git "$SDK_ROOT/calBLAS"
```

```bash
git clone http://115.159.82.89/git/calculet/calDNN.git "$SDK_ROOT/calDNN"
```

```bash
git clone http://115.159.82.89/git/calculet/npu.git "$SDK_ROOT/npu"
```

```text
calculet-work/
├── calBLAS/
├── calDNN/
├── npu/
└── runs/       后续创建的实验记录
```

`calBLAS` 使用指向相邻仓库的路径依赖，因此不能把 `calDNN` 放到 `calBLAS/calDNN` 中。目录已存在时检查其来源和工作状态，不执行删除、重置或强制覆盖。

### 5.3 检查是否已有 Rust

```bash
command -v rustup rustc cargo
```

```bash
ls -ld "$HOME/.cargo/bin" "$HOME/.rustup"
```

两个默认目录不存在只能直接说明默认位置没有文件，还要结合 `CARGO_HOME`、`RUSTUP_HOME` 和管理员提供的安装位置判断。团队初次 tiny 环境确实没有 Rust，不能把该结论套用到每台机器。

### 5.4 下载并审阅安装文件

仅在自己的开发环境中创建新的下载目录：

```bash
INSTALL_DIR="$(mktemp -d "$SDK_ROOT/install-XXXXXXXX")"
```

先通过 Rust 官方 HTTPS 入口保存 rustup 安装脚本：

```bash
curl --proto '=https' --tlsv1.2 -fSs https://sh.rustup.rs -o "$INSTALL_DIR/rustup-init.sh"
```

```bash
cat "$INSTALL_DIR/rustup-init.sh"
```

确认信任来源并完成审阅后：

```bash
sh "$INSTALL_DIR/rustup-init.sh" -y --profile minimal --default-toolchain none
```

```bash
source "$HOME/.cargo/env"
```

`--default-toolchain none` 不安装默认 stable；本流程稍后安装定制工具链。如果已经有符合要求的 rustup，不重复安装。

再下载厂商脚本，下载失败时停止：

```bash
curl -fSs http://115.159.82.89/install.sh -o "$INSTALL_DIR/calculet-install.sh"
```

```bash
cat "$INSTALL_DIR/calculet-install.sh"
```

确认脚本与主办方配套版本一致后才执行：

```bash
sh "$INSTALL_DIR/calculet-install.sh"
```

历史脚本使用 `nightly-2026-11-13` 并链接为 `calculet`，历史记录中的编译器版本为 `1.98.1`。这不是未来脚本必然保持不变的保证；也不要因旧 README 写了别的工具链名，就把两个发布阶段的命令混用。

### 5.5 验收工具可见性

```bash
rustup toolchain list
```

```bash
rustc +calculet --version --verbose
```

```bash
command -v cargo docc dort
```

若只安装了 rustup 且选择了 `--default-toolchain none`，在任意目录直接运行 `rustc --version` 可能提示没有默认工具链；应明确选择 `+calculet` 或进入配置了该工具链的工作区，不必为此盲目安装 stable。

只需要恢复当前 shell 的 PATH 时，可加载可信的 `$HOME/.cargo/env`。共享服务器上不要擅自修改共用账号的 `.bashrc`、升级其工具链或覆盖已有软链接。

<a id="workspace"></a>
## 6. 创建独立实验目录与恢复终端

**从本节开始，cargo 命令在 `calBLAS` 根目录执行。`docc`、`dort` 示例使用绝对实验路径，仍需正确的执行主机。**

```bash
cd "$SDK_ROOT/calBLAS"
```

创建唯一目录，避免覆盖上一次结果：

```bash
mkdir -p "$SDK_ROOT/runs"
```

```bash
RUN_DIR="$(mktemp -d "$SDK_ROOT/runs/tiny-XXXXXXXX")"
```

```bash
mkdir "$RUN_DIR/weights" "$RUN_DIR/reference" "$RUN_DIR/logs" "$RUN_DIR/outputs"
```

保存本地路径上下文：

```bash
printf 'SDK_ROOT=%q\nRUN_DIR=%q\n' "$SDK_ROOT" "$RUN_DIR" > "$RUN_DIR/run.env"
```

```bash
printf 'SDK_ROOT=%s\nRUN_DIR=%s\n' "$SDK_ROOT" "$RUN_DIR"
```

预期结构：

```text
runs/tiny-随机后缀/
├── run.env
├── weights/
├── reference/
├── logs/
├── outputs/
├── tiny-native-input/    打包前创建
└── tiny-native-output/   docc 生成
```

### 6.1 新终端如何恢复

1. 确认是原来的用户、容器和开发机，必要时重新加载 `$HOME/.cargo/env`。
2. 找到本次实验的真实目录，而不是重新执行 `mktemp` 误建另一次实验。
3. 从该可信目录的 `run.env` 恢复变量，再进入 `calBLAS`。

以下路径是占位示意，需替换为实际目录：

```bash
source "/实际工作区/runs/tiny-实际后缀/run.env"
```

```bash
cd "$SDK_ROOT/calBLAS"
```

不能加载他人提供的未知 `run.env`。复制到板端后路径往往不同，**不能直接 source 本地的绝对路径配置**；板端应按第 12 节重新设置 `RUN_DIR`。

<a id="cargo"></a>
## 7. 理解 cargo：编译 tiny 与 CPU 参考

### 7.1 设备编译命令逐项解释

```bash
cargo build -p tiny --lib --target dopamine-unknown-none-elf
```

| 片段 | 含义 |
| --- | --- |
| `cargo build` | 编译，不代表运行计算 |
| `-p tiny` | 选择工作区中的 tiny 包 |
| `--lib` | 构建该包的库 |
| `--target dopamine-unknown-none-elf` | 使用 NPU 设备目标，不是 x86 主机目标 |

检查实际生成的文件：

```bash
ls -lh target/dopamine-unknown-none-elf/npu/tiny.cvx target/dopamine-unknown-none-elf/npu/tiny.cvxo
```

出现“ELF 要 docc 收 CalVX 1.0，当前只出了 CalVX”的历史警告时，只能确认这次 cargo 没有生成原生 ELF；不要仅因 target 名称含 `elf` 就写成已完成原生编译。历史 tiny 后续独立 docc 打包成功，也说明该警告不等于 docc 一定拒绝此文件。

### 7.2 主机侧生成测试权重

```bash
cargo run -p tiny-pack --bin tiny-pack -- "$RUN_DIR/weights"
```

这里运行的是本地 CPU 上的权重生成工具，不会启动 NPU。

历史记录中生成两块参数，各 `6221824` 字节，使用固定种子供 tiny 回归测试。它们不是训练好的大模型权重，也不是 SD3.5 等真实模型的转换结果。

### 7.3 主机侧产生固定输入参考

```bash
cargo run -p tiny-pack --bin tiny-ref -- "$RUN_DIR/weights" 7 "$RUN_DIR/reference/cpu-out.bin"
```

| 程序参数 | 含义 |
| --- | --- |
| 第一个路径 | 权重所在目录 |
| `7` | 输入 token ID，不是“生成 7 次” |
| 最后一个路径 | CPU 参考输出文件 |

历史输出为 `1024` 字节，即 `512` 个 bf16；对应的 argmax 为 `303`，两半词表相同，对应前半的 `47`。同分位置可以影响 argmax 的具体选择，不能只用一个最大值下标代替完整数值比较。

### 7.4 启用完整程序入口

```bash
cargo build -p tiny --lib --features step --target dopamine-unknown-none-elf
```

`--features step` 启用该示例的完整程序入口。默认 kernel 编译、完整程序编译、运行主机侧 helper 是三个不同操作；tiny 本身没有可直接 `cargo run -p tiny` 的主机二进制入口。

再次检查 `.cvx` 与 `.cvxo` 的时间和内容来源，确保后续打包用的是本次带 `step` 生成的版本。文件大小只能帮助排查，不是正确性标准。

<a id="docc"></a>
## 8. 理解 docc：生成原生 calbin

**执行位置：有配套工具的 Linux 开发环境；本节不需要板卡。**

### 8.1 本机帮助优先

```bash
docc calbin from-calvx --help
```

已归档帮助的[第 1～15 行](ref/NPU-guide-20261114/help/docc-calbin-from-calvx.txt#L1-L15)显示，参数顺序的核心是输入目录与 `--out` 输出位置。

| 参数 | 已记录的作用或使用原则 |
| --- | --- |
| `<DIR>` | 打包输入目录，不是直接传 CPU 参考文件 |
| `-o` / `--out` | 输出位置，本流程使用尚不存在的新路径 |
| `--network` | 帮助列出的网络配置选项；未在历史 tiny 命令中手动设置，不猜其值 |
| `--max-seq-len` | 历史默认 `32768`；包配置不证明模型或设备已支持该上下文 |
| `--ddr` / `--sram` | 历史版本的地址/预留配置，不是自动探测实际物理容量的结果 |
| `--entries` | 入口相关配置；没有配套依据时不手写地址 |
| `--arg` | 取值语法需核对配套版本，不从参数名臆造格式 |
| `--no-params` | 历史 tiny 打包没有使用；省略参数内容的结构实验不能代替真实权重部署验证 |

不能将某套包的预留地址、地址窗口或 doctor 中的保留字节数，直接当作板卡物理 DDR 容量或模型实际峰值占用。

### 8.2 准备只属于本次实验的输入目录

```bash
mkdir "$RUN_DIR/tiny-native-input"
```

复制刚生成的完整程序：

```bash
cp target/dopamine-unknown-none-elf/npu/tiny.cvx "$RUN_DIR/tiny-native-input/step.cvx"
```

复制对应的两块测试权重：

```bash
cp "$RUN_DIR/weights/param_blk0.bin" "$RUN_DIR/weights/param_blk1.bin" "$RUN_DIR/tiny-native-input/"
```

目录应包含 `step.cvx` 与两个 `param_blk` 文件，不放入 `cpu-out.bin`。`cp` 默认可能覆盖目的文件，因此这里先创建新目录；不在旧实验目录中反复覆盖源文件。

### 8.3 打包

```bash
docc calbin from-calvx "$RUN_DIR/tiny-native-input" --out "$RUN_DIR/tiny-native-output"
```

```bash
ls -lah "$RUN_DIR/tiny-native-output"
```

历史记录中该命令输出 `wrote ...`，产生根级保留区信息、两块权重和一个子模型目录。它证明工具写出了包，不能证明已经部署到 NPU。

模型名必须继续以 doctor 报告为准，不要仅由包目录名猜测。历史 tiny 的输出目录叫 `tiny-native-output`，模型名却是 `tiny-native-input`。

<a id="doctor"></a>
## 9. 理解 doctor：检查结果不是运行结果

```bash
docc calbin doctor --help
```

```bash
docc calbin doctor "$RUN_DIR/tiny-native-output"
```

[归档帮助第 1～7 行](ref/NPU-guide-20261114/help/docc-calbin-doctor.txt#L1-L7)说明检查包括：清单解析、已知加载规则、引用文件、稳态命令流解码；拒收或解码失败返回失败，只有警告不会使工具失败。

### 9.1 怎样读报告

| 报告字段 | 应关注什么 |
| --- | --- |
| 模型 / 子模型名 | 后续 `--model` 需要实际名字，不一定等于 Rust 包名 |
| `type` | 是 LLM、decode 等哪种包，不由文件后缀决定 |
| 设备类型与保留区 | 是否与计划部署环境匹配；静态规则不代表实际容量已验证 |
| 权重块 | 芯粒、文件数量和大小是否与程序声明一致 |
| CCU ELF | 是否存在预期原生镜像，但镜像存在不等于已执行 |
| CPU command stream | 运行包中的调度/数据搬运等命令流，不能仅由名字断言核心计算退回 CPU |
| 张量 / ICSR | 输入、输出和状态接口需要与运行方式匹配 |
| 拒收 / 警告 / 解不开的流 | 分别记录；不能只截取一行“通过” |

### 9.2 历史 tiny 的结果与限制

[01-setup.md](01-setup.md) 记录了两块权重、4 个 CCU ELF、4 个 CPU command stream，最终为：

```text
拒收 0 条
警告 3 条
解不开的稳态流 0 份
```

三个张量的 ping/pong 地址分别重合：

| 张量 | 历史报告中的同址地址 |
| --- | --- |
| `in_input_ids` | `0xc05f0000` |
| `in_position_ids` | `0xc0600000` |
| `out_outputs_0` | `0xc0610000` |

ping/pong 通常用于交替处理的缓冲区；两者指向同一位置时，第二轮写入或尚未读取就复用输出可能覆盖前一轮数据。它不是可以与 `dead_code` 等同看待的提示。

**该记录应称为“硬性完整性检查通过，保留缓冲区覆盖风险”，不能称为“无警告、可连续运行”。** 不擅自手改清单地址来消警告，不开启循环、流水或并发。`--steps 1` 只是单轮候选计划，并不修复地址别名或证明其运行安全。

<a id="evidence"></a>
## 10. 版本、完整日志与哈希归档

### 10.1 保存版本与帮助

在 `calBLAS` 根目录：

```bash
git rev-parse HEAD
```

```bash
git -C ../calDNN rev-parse HEAD
```

```bash
git -C ../npu rev-parse HEAD
```

```bash
rustc +calculet --version --verbose
```

将以下帮助完整保存到本次实验，而不是只记住聊天摘要：

```bash
docc calbin from-calvx --help > "$RUN_DIR/logs/docc-from-calvx-help.txt" 2>&1
```

```bash
docc calbin doctor --help > "$RUN_DIR/logs/docc-doctor-help.txt" 2>&1
```

```bash
dort calbin run --help > "$RUN_DIR/logs/dort-run-help.txt" 2>&1
```

这里的 `>` 会覆盖同名文件；使用新的 `RUN_DIR` 保存每次实验。编译、打包、doctor 和后续真机运行应保留完整 stdout、stderr 与退出状态，不能只保存最后一句成功。

### 10.2 为本次实验生成 SHA-256 清单

在所有写文件操作完成、文件不再变化时执行；这个例子只遍历本次实验目录，不扫整个系统：

```bash
(set -o pipefail; cd "$RUN_DIR" && find . -type f ! -name MANIFEST.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > MANIFEST.sha256)
```

首次使用该命令前应确认 `find`、`sort`、`xargs`、`sha256sum` 可用；常见 Linux 环境提供这些工具。`-print0` 与 `-0` 配合，避免文件名含空格时被拆开。

若修改了清单覆盖的任何文件，旧清单不再代表新实验。不要为掩盖差异而覆盖历史快照；需要记录修改后的一次新基线。

核验：

```bash
(cd "$RUN_DIR" && sha256sum -c MANIFEST.sha256)
```

哈希一致只证明双方拿到相同文件，不证明下载渠道可信、部署成功或数值正确。大型权重可以按许可和空间条件只保留完整哈希，不因“留痕”把巨大检查点上传到文档仓库。

<a id="authorization"></a>
## 11. 真机前的授权与共享设备检查

**这一节是进入设备操作前的门槛，不是建议先运行一次看看。**

确认以下事项后再使用运行模板：

- 主办方或管理员明确了账号、服务器入口、分配的设备下标和使用窗口。
- 设备当前任务、容器和服务的归属已确认；能看到进程不等于有权结束它。
- 运行时、驱动、板卡类型、内存约束和包版本匹配。
- 包、权重、输入和参考属于同一次实验，doctor 的拒收项已经处理，警告有明确运行限制。
- 运行主机上的目录归属和写权限正确，日志与输出不会覆盖其他团队文件。
- 板锁与排队规则明确，运行时长仍处于授权窗口内。

### 11.1 板锁不等于设备使用权

[运行帮助第 79～87 行](ref/NPU-guide-20261114/help/dort-calbin-run.txt#L79-L87)记录了板锁路径与等待参数。

- 默认锁路径是该版工具的历史默认值，不是证明当前环境空闲的证据。
- 没有锁文件、不持锁的未知进程、可以写目录，都不能推出“设备可以随意使用”。
- 不删除锁文件、不停止未知服务、不重启板卡、不终止他人容器来让自己的任务跑起来。
- `--lock-wait` 是等待锁的秒数，不会延长主办方允许的设备使用窗口。
- `--board-lock external` 只在外层已经按约定持锁时使用，不能把它当成绕过锁的开关。

### 11.2 工具安装与状态查询

先在获准的板端环境核对工具位置和本机帮助。不要为运行一个包而擅自重装共享用户的 Rust、驱动或运行时。

具体设备查询子命令应以本机 `dort --help` 为准。本手册没有取得所有设备查询子命令的最新完整输出，不臆造 reset、刷写、寄存器或内存操作命令。

<a id="transfer"></a>
## 12. 将实验目录交给板端主机

**本节涉及连接服务器，仅在已有授权入口后执行；手册编写过程没有执行 SSH 或 SCP。**

建议交付完整实验：calbin、固定输入、参考输出、版本、完整日志、哈希和已知限制，而不是只上传一个 `.cvxo`。

### 12.1 在本地传输

管理员提供 SSH 登录目标及团队目录后，设置 `BOARD_SSH_TARGET`、`BOARD_WORKDIR`。不得把这两个值替换为猜测的账号、IP 或公共目录。

下面使用空值检查，未设置变量时 Bash 在启动 scp 前停止：

```bash
scp -r "$RUN_DIR" "${BOARD_SSH_TARGET:?先确认获准的SSH目标}:${BOARD_WORKDIR:?先确认团队目标目录}/"
```

`scp -r` 递归传目录。这里没有给出真实服务器地址、密码、私钥或 token。首次连接的主机指纹应通过可信渠道核对，不关闭主机密钥检查来消除提示。

### 12.2 在板端重新建立路径

在授权服务器上确认目录后，将 `RUN_DIR` 设为**板端实际收到的实验路径**。不要直接 source 本地 `run.env` 中的路径，也不要在板端继续沿用本地 `SDK_ROOT`。

以下仅为路径占位示意：

```bash
RUN_DIR="/主办方分配的团队目录/tiny-本次实验后缀"
```

```bash
ls -lah "$RUN_DIR/tiny-native-output"
```

```bash
(cd "$RUN_DIR" && sha256sum -c MANIFEST.sha256)
```

传输后若新增了日志或改动文件，清单的适用范围需要单独说明；不能将未被清单覆盖的新文件说成已经通过哈希核验。

必要时在配套工具版本下重新运行 doctor 并保存报告。哈希正确不替代运行时和硬件兼容性检查。

<a id="dort-options"></a>
## 13. dort 参数逐项解释

先核对：

```bash
dort calbin run --help
```

以下仅解释[已归档的完整运行帮助](ref/NPU-guide-20261114/help/dort-calbin-run.txt)。帮助输出来自团队提供的终端记录，不是本次编写时重新执行二进制的结果。

### 13.1 公共选择与部署参数

| 参数 | 含义 | 新手容易踩的坑 |
| --- | --- | --- |
| `-f` / `--calbin` | 包目录或单文件包 | 不是只传权重目录或 `.cvx` |
| `-i` / `--index` | 选择设备下标 | 不是芯粒数；必须使用分配编号，不依赖“默认全部”的行为 |
| `-m` / `--model` | 选择包中的模型名 | 历史帮助说缺省仅列模型后退出；不能把这种退出当推理成功 |
| `-j` / `--json` | 该版帮助中的 JSON 输出开关 | 自动化解析前仍需核对 stdout/stderr 与实际输出结构 |
| `--deploy-only` | 只部署，不推理 | 仍写设备状态，不是无需授权的离线检查 |
| `--dump-layout` | 部署后打印实际 section 落点 | 用于排除空部署或落点异常，不等于验证数值 |
| `--board-lock` | 锁文件路径，或约定的 `external` 模式 | 不修改锁机制来绕过他人任务 |
| `--lock-wait` | 等待锁的上限，单位秒 | 超时后先协调，不删除锁文件 |

### 13.2 LLM 输入与输出参数

依据[帮助第 48～77 行](ref/NPU-guide-20261114/help/dort-calbin-run.txt#L48-L77)：

| 参数 | 含义 | 本手册 tiny 候选用法 |
| --- | --- | --- |
| `--tokens` | 逗号分隔的 token ID | `7`，与 CPU 参考一致；不是自然语言字符串 |
| `-s` / `--steps` | 该版 LLM 运行器输出步数；帮助将 1 描述为只跑 prefill | 仅计划 `1`，不据此证明任意包具有通用 prefill 能力 |
| `-d` / `--decode-model` | 多步时使用的 decode 子模型名 | 初次候选流程不启用多步；不能凭名字猜 decode 子模型 |
| `--in-tokens` | token 输入张量名 | 历史 tiny 为 `in_input_ids` |
| `--in-positions` | 位置输入张量名 | 历史 tiny 为 `in_position_ids` |
| `--out-logits` | logits 输出张量名 | 历史 tiny 为 `out_outputs_0` |
| `--dump-out` | 每步原样保存输出张量的目录 | 使用本次独立输出目录，而不是公共 `/tmp` 文件 |

历史默认名字 `inputs[0]`、`inputs[1]`、`outputs[0]` 与 tiny 的名字不相同，省略这些选项不一定能运行 tiny。张量名字、大小、dtype 和布局都应以本次包与源码为准。

### 13.3 裸字节参数

依据[帮助第 28～46 行](ref/NPU-guide-20261114/help/dort-calbin-run.txt#L28-L46)：

| 参数 | 含义 |
| --- | --- |
| `--raw-in` | 原样写入一个输入张量的二进制文件 |
| `--raw-out` | 原样保存该模式输出的文件；明确指定路径，避免覆盖历史默认 `/tmp/raw_out.bin` |
| `--in-tensor` | 目标输入张量名，不能默认叫 `in` |
| `--out-tensor` | 目标输出张量名，不能默认叫 `out` |

裸字节不等于自动解析 NumPy、图片、JSON、文本或模型权重。文件内容必须已经符合目标输入的 shape、dtype、字节序和布局。

<a id="tiny-run"></a>
## 14. tiny 单次运行候选流程

**以下命令未在本手册编写时上板验证。存在第 9 节警告时，必须先由 SDK/运行环境负责人确认单次执行限制；不得当作可连续运行的成品脚本。**

### 14.1 在板端准备一次新的运行记录

确认第 11 节全部条件，并核对 `RUN_DIR` 是板端实际路径。创建新目录，不覆盖上一轮输出：

```bash
BOARD_RUN_DIR="$(mktemp -d "$RUN_DIR/board-run-XXXXXXXX")"
```

```bash
mkdir "$BOARD_RUN_DIR/outputs"
```

```bash
docc calbin doctor "$RUN_DIR/tiny-native-output"
```

确认本次模型名与张量名仍然匹配。示例使用历史报告中的 `tiny-native-input`；若实际报告不同，不直接照抄。

管理员分配设备下标后，设置 `NPU_DEVICE_INDEX` 为该数字。本文不提供默认编号 `0`，未设置时下面的参数展开会阻止执行。

### 14.2 单次执行候选命令

```bash
dort calbin run \
  --calbin "${RUN_DIR:?先设置板端实际实验路径}/tiny-native-output" \
  --index "${NPU_DEVICE_INDEX:?先设置获准的设备下标}" \
  --model tiny-native-input \
  --tokens 7 \
  --steps 1 \
  --in-tokens in_input_ids \
  --in-positions in_position_ids \
  --out-logits out_outputs_0 \
  --dump-layout \
  --dump-out "${BOARD_RUN_DIR:?先创建本次板端运行目录}/outputs"
```

执行条件满足时，按第 3.5 节方法保存完整运行日志和退出状态。没有 `--model` 可能只列模型就退出；只有“deploy completed”也不够，需同时看真实部署落点、执行状态和输出。

### 14.3 结束后检查什么

- 是否实际部署了所需 section，而非 0 字节空部署。
- 是否在正确设备上完成了预期的一次执行；失败时保留错误，不立即盲目重跑。
- 是否生成预期输出，大小、dtype 和有效区域是否符合包与源码。
- 日志中是否存在设备、内存、同步或输入张量异常。
- 输出是否已读取和归档，能否与同一权重、token `7` 的 CPU 参考比较。

历史帮助约定 LLM dump 名为 `<tag>-<步>.bin`，如 `prefill-0.bin`；实际文件应以运行日志与目录内容为准。本手册没有生成过这次真机输出，不能预先填入设备结果。

<a id="raw-mode"></a>
## 15. 单算子裸字节模式与图像模型边界

### 15.1 单算子的候选模板

仅适用于已有专门 calbin、输入输出接口已经明确、确实适合一次单输入/单输出裸字节验证的场景。所有变量都应由该实验的包与数据决定，不沿用 tiny 的默认名称。

**本模板会访问并运行设备，同样需要第 11 节的授权。**

```bash
dort calbin run \
  --calbin "${NPU_CALBIN:?先确认单算子包}" \
  --index "${NPU_DEVICE_INDEX:?先设置获准的设备下标}" \
  --model "${NPU_MODEL_NAME:?先核对模型名}" \
  --raw-in "${NPU_RAW_INPUT:?先生成匹配布局的二进制输入}" \
  --in-tensor "${NPU_INPUT_TENSOR:?先核对输入张量名}" \
  --out-tensor "${NPU_OUTPUT_TENSOR:?先核对输出张量名}" \
  --raw-out "${NPU_RAW_OUTPUT:?先选择新的输出文件路径}" \
  --dump-layout
```

输入有多个必要张量时，不假定一个 `--raw-in` 文件能自动填完全部输入；应确认专用主机程序或 SDK 的多输入绑定方法。

### 15.2 为什么不能拿 raw 模式代替 tiny 的 LLM 流程

[运行帮助第 76～77 行](ref/NPU-guide-20261114/help/dort-calbin-run.txt#L76-L77)明确提醒：裸字节模式不设置整步程序需要的 `cur_seq_len` 等 CSR 状态。两种模式的差别不只是文件名。

需要 LLM 状态的完整程序，不应为了“参数看起来更简单”改走 raw 模式；单算子 bf16 输入也不应被当成 token 平面交给默认 LLM 路径。

### 15.3 SD3.5 等图像模型不是 `--tokens` 示例的直接替换

真实图像模型需要明确对应的文本编码、去噪、调度、VAE 等阶段，准备真实权重、实际张量输入和主机编排。`tiny-pack` 不会自动转换这些权重，`--tokens 7` 也不会自动发起完整文生图流程。

本手册只解释运行接口，不宣称已存在通用 CUDA/PyTorch 到本 NPU 的自动转换。必要算子、布局、精度、权重与后端适配仍应按模型逐项实现，并用参考结果验证；具体迁移方法见 [02-guide.md](02-guide.md)。

<a id="outputs"></a>
## 16. 如何理解和比较输出

### 16.1 `.bin` 为什么不能直接当文本看

bf16 的每个值占 2 字节，但其位模式不是整数大小、UTF-8 字符，也不能按 fp16 或 f32 直接读取。文件名相同不保证 dtype 与布局相同。

比较前先明确：

1. CPU 与 NPU 是否使用同一权重、同一输入与预处理。
2. 输出张量中的有效偏移、长度、shape、dtype 和字节序。
3. 是否含调试空间、padding、未写入区域或多步拼接。
4. 应采用逐位比较还是数值容差，容差由语义与验收口径决定。

不要因为两个文件长度不同就立即断定模型错误；也不要因为长度相同就认定正确。tiny 的 CPU 参考是 `1024` 字节，设备输出张量可能更大，应先按真实布局提取对应的 `512` 个 logits。

### 16.2 可选的 bf16 指标计算示例

以下是**本手册提供的分析代码，不是历史真机实验输出**。仅在已经确认：CPU 文件为 512 个小端 bf16、设备对应 logits 从第 0 字节开始且至少包含相同的 512 个值时使用。布局不符就先修改提取规则，不能为得到数字强行截断任意文件。

将 `NPU_LOGITS_FILE` 设为实际 dump 的路径后执行；路径留空会在 Python 启动前停止：

```bash
python3 -I - "$RUN_DIR/reference/cpu-out.bin" "${NPU_LOGITS_FILE:?先核对实际输出文件与布局}" <<'PY'
import math
from pathlib import Path
import struct
import sys

reference_bytes = Path(sys.argv[1]).read_bytes()
device_bytes = Path(sys.argv[2]).read_bytes()
count = 512
size = count * 2
if len(reference_bytes) != size or len(device_bytes) < size:
    raise SystemExit("文件长度不满足本例前提，先核对输出布局")

def decode_bf16(data):
    words = struct.unpack("<512H", data[:size])
    return [struct.unpack("<f", struct.pack("<I", word << 16))[0] for word in words]

reference = decode_bf16(reference_bytes)
device = decode_bf16(device_bytes)
if not all(math.isfinite(value) for value in reference + device):
    raise SystemExit("出现 NaN 或 Inf，不能当成通过")
errors = [abs(actual - expected) for actual, expected in zip(device, reference)]
maximum = max(errors)
scale = max(max(abs(value) for value in reference), 1e-12)
print("count:", count)
print("max_abs_error:", maximum)
print("mean_abs_error:", sum(errors) / count)
print("max_error_normalized_by_reference_peak:", maximum / scale)
print("仅输出指标；没有自动判定满足模型或赛方容差。")
PY
```

最后一项是用参考峰值归一化的最大误差，不是每个元素的相对误差。参考值接近 0 时，直接逐元素相除会产生误导，应结合绝对误差和任务语义判断。

CPU 参考中 `exp`、`rsqrt` 等实现可能与 NPU 近似指令不同。不能自行设一个通用于所有模型的“1% 就合格”，也不能只看最终 token 是否相同。

<a id="troubleshooting"></a>
## 17. 常见错误按阶段排查

| 现象 | 先核对什么 | 不应直接做什么 |
| --- | --- | --- |
| `cargo: command not found` | 是否安装、当前用户、PATH、自定义安装位置 | 不直接假定只是 PATH，也不反复重复安装 |
| `rustc` 提示没有默认工具链 | 是否选择了 `--default-toolchain none`，是否需要 `+calculet` 或进入项目 | 不把 stable 自动当成 NPU 工具链 |
| `linker cc not found` | 本地基础编译/链接工具 | 不先改 NPU kernel |
| 仓库相对路径依赖找不到 | 三个仓库是否平级、是否确实在 calBLAS | 不覆盖或移动他人的源码目录 |
| HTTP 502、下载中断 | 服务、网络与下载结果，保留完整错误 | 不运行空脚本、错误网页或未完成的下载 |
| 工具链 target 不识别 | 实际使用的工具链与目标是否配套 | 不任意替换成主机 target 以“编译通过” |
| 只生成 CalVX，没有原生 ELF | 这一步是否只是 cargo 设备编译 | 不说已上板；按当前 docc 单独验证原生链路 |
| `tiny-pack` 的 `dead_code` | 是否正常结束、是否生成正确文件 | 不为了消提示做无关改动 |
| 缺少 `step`、程序入口或声明 | feature 是否启用、文件是否是本次构建 | 不把旧 kernel 产物当完整模型 |
| from-calvx 报不支持版本/指令 | 保留完整错误、SDK 版本和最小输入 | 不用未经证实的地址/参数绕过后端问题 |
| doctor 拒收或解码失败 | 清单、缺失文件、程序声明与配套工具版本 | 不带着结构失败上共享板反复试 |
| doctor 只有 ping/pong 同址警告 | 缓冲区生命周期、数据读取时机和单次限制 | 不直接开启多轮、并发；不手改清单“消警告” |
| `dort` 只列模型后退出 | 是否遗漏 `--model`，模型名是否来自包 | 不把退出码 0 当实际推理完成 |
| 找不到输入或输出张量 | 真实名字、shape、dtype 与调用模式 | 不盲用 `inputs[0]` 或 `in` 等默认名 |
| 部署显示成功，但输出不对 | 实际 section 落点、执行日志、输入与状态 | 不只贴一句 `deploy completed` |
| 板锁等待或超时 | 使用窗口、锁协议、其他任务归属 | 不删除锁、杀未知进程、重启服务 |
| 输出为空、全 0、NaN 或明显偏差 | 输入、权重布局、模式、同步、有效输出区域 | 不先开展性能优化或调整容差掩盖错误 |
| SSH 断开后变量消失 | 当前主机和用户、本次路径、可信环境记录 | 不在另一台机器直接沿用本地绝对路径 |

失败时的最小问题包应包含：操作阶段、完整命令、完整 stdout/stderr、退出状态、源码/工具版本、输入 shape/dtype、doctor 报告，以及当前是否已获准操作设备。公开分享前清除密码、token、私钥、个人数据及不应公开的服务器入口信息。

<a id="checklist"></a>
## 18. 命令风险速查与发布原则

### 18.1 操作边界速查

| 操作 | 典型命令 | 边界 |
| --- | --- | --- |
| 查看 shell 上下文 | `pwd`、`whoami`、`command -v` | 不证明设备权限 |
| 查看参数 | 已核对的 `--help` | 保存本机版本，不当作实际运行 |
| 安装依赖、SDK | 包管理器、安装脚本 | 只在自己的受控开发环境或经管理员授权时进行 |
| 构建设备代码 | `cargo build ... --target ...` | 通常是离线构建，不证明执行 |
| 运行 CPU helper | `cargo run -p tiny-pack ...` | 主机计算，不是 NPU 性能 |
| 生成包 | `docc calbin from-calvx` | 写本地输出，不代表设备已部署 |
| 离线检查 | `docc calbin doctor` | 检查结构，不检验模型数值 |
| 传文件、远程登录 | `scp`、`ssh` | 需要授权目标，不尝试未知账号或服务器 |
| 只部署 | `dort calbin run --deploy-only ...` | 仍改变设备状态，不能绕过资源协调 |
| 真机推理 | `dort calbin run ...` | 选择分配设备、保持板锁、明确单次限制 |
| 删除锁、停服务、复位、刷写 | 本手册不提供可复制命令 | 新手排障不采用这些动作作为捷径 |

### 18.2 每次实验的结论应写到哪一层

依次区分：**下载完成、安装可用、源码编译、原生生成、静态检查、设备部署、执行完成、数值正确、可重复正确、性能结果**。

结论应止于已有证据。例如“doctor 无拒收”不能改写成“真机测试通过”；一次单算子成功不能改写成整个真实模型完成迁移。

### 18.3 公开协作时保留什么

- 保留命令、固定输入约定、完整日志、版本、参考口径、已知警告和未验证项。
- 历史实验快照按项目既有编号新增，不覆盖已有 `schedule` 文件。
- 原始敏感日志在受控位置完整保留；公开脱敏副本应标明删改范围并单独计算哈希，不能声称与私有原件字节相同。
- 不提交密码、token、私钥、带凭据的 URL、共享账号环境文件或未获许可的大型权重。
- SDK 源码可访问不自动等于允许任意再分发；本文只附必要帮助记录和来源说明，不镜像 SDK 二进制或模型权重。

<a id="sources"></a>
## 19. 来源、证据与版本说明

### 19.1 本文直接使用的资料

| 证据 | 来源与验证范围 |
| --- | --- |
| [01-setup.md](01-setup.md) | 团队已发布的 tiny 操作与结果记录，是记录转述，不是本次重新上板 |
| [02-guide.md](02-guide.md) | 团队迁移方法与边界说明，不是厂商能力承诺 |
| [docc from-calvx 完整帮助](ref/NPU-guide-20261114/help/docc-calbin-from-calvx.txt) | 团队提供的终端输出转录，第 1～15 行包含所用语法和参数 |
| [docc doctor 完整帮助](ref/NPU-guide-20261114/help/docc-calbin-doctor.txt) | 第 1～7 行说明检查内容及失败条件 |
| [dort run 完整帮助](ref/NPU-guide-20261114/help/dort-calbin-run.txt) | 第 8～26 行是包、设备、模型与部署，第 28～77 行是输入输出模式，第 79～87 行是锁 |
| [完整历史 tiny doctor 报告](ref/NPU-guide-20261114/reports/tiny-doctor.txt#L1-L30) | 团队提供的完整输出转录，包含全部镜像、计数及三条警告；不是本次重新执行 |
| [本次公开入口取证记录](ref/NPU-guide-20261114/collection-attempts.txt) | 两次请求均为 curl 退出 22 / HTTP 502，未取得厂商最新快照 |
| [SOURCES.json](ref/NPU-guide-20261114/SOURCES.json) | 仓库基线、资料分类、转录方式和本次未执行的验证范围 |
| [MANIFEST.sha256](ref/NPU-guide-20261114/MANIFEST.sha256) | 上述归档文件的 SHA-256，可核对文件完整性，不代表 SDK 真伪或模型正确 |

帮助文本保留原记录的符号；文件的哈希针对这份转录归档，不代表已证明原终端原始字节完全一致。归档子目录的 `.gitattributes` 禁用该目录的自动换行转换，避免跨平台检出改变哈希；手动修改文件后不应覆盖旧清单来伪装成原始归档。帮助所对应的精确二进制版本没有从这几段输出中独立取得，因此不能把参数默认值推广到所有 SDK 发布版本。

### 19.2 厂商原始入口与后续核对方向

- [厂商公开 SDK 入口](http://115.159.82.89/)
- [npu 语法与完整程序声明](http://115.159.82.89/git/calculet/npu/src/branch/main/SYNTAX.md)
- [tiny 示例源码](http://115.159.82.89/git/calculet/calBLAS/src/branch/main/examples/tiny)
- [完整程序打包约定的 SDK 示例](http://115.159.82.89/git/calculet/calBLAS/src/branch/main/examples/minimax_h3/README.md)

这些是资料入口，不代表本次已成功取得最新内容。服务恢复或工具更新后，应补充实际版本及完整输出，再调整指南；不把记忆中的命令、目录名称或其他环境的报告当成本环境已经验证的事实。

<a id="nvidia-sources"></a>
### 19.3 前置 NVIDIA / CUDA 对照的依据

2026-11-14 补充对照时，通过 HTTPS 取得下列 NVIDIA 官方文档，核对相关定义，并保存短引文与源页面完整 SHA-256；没有执行表内的 CUDA 命令，也没有重新安装或运行 Calculet SDK。NVIDIA 资料只能证明 NVIDIA 侧定义，不能据此推出另一款 NPU 的接口或工具兼容。

| 编号与官方入口 | 核对内容 | 可复核的短原文 |
| --- | --- | --- |
| N1：[NVCC 文档](https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/index.html) | 版本选项、PTX 与 cubin 的设备侧输出 | [节选第 6～12 行](ref/NVIDIA-comparison-20261114/EXCERPTS.txt#L6-L12) |
| N2：[NVIDIA-SMI 文档](https://docs.nvidia.com/deploy/nvidia-smi/index.html) | GPU 枚举、驱动报告的 CUDA 能力与工具包版本的区别 | [节选第 14～20 行](ref/NVIDIA-comparison-20261114/EXCERPTS.txt#L14-L20) |
| N3：[CUDA 环境变量](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/environment-variables.html) | `CUDA_VISIBLE_DEVICES` 的可见性和枚举顺序 | [节选第 22～27 行](ref/NVIDIA-comparison-20261114/EXCERPTS.txt#L22-L27) |
| N4：[Compute Sanitizer 文档](https://docs.nvidia.com/compute-sanitizer/ComputeSanitizer/index.html) | memcheck 属于运行时检查，不是包清单检查 | [节选第 29～33 行](ref/NVIDIA-comparison-20261114/EXCERPTS.txt#L29-L33) |
| N5：[Nsight Systems 文档](https://docs.nvidia.com/nsight-systems/UserGuide/index.html) | `profile` 启动应用并进行分析 | [节选第 35～39 行](ref/NVIDIA-comparison-20261114/EXCERPTS.txt#L35-L39) |

新对照的 [SOURCES.json](ref/NVIDIA-comparison-20261114/SOURCES.json) 记录 URL、取回方式、完整 HTML 字节数和哈希；[MANIFEST.sha256](ref/NVIDIA-comparison-20261114/MANIFEST.sha256) 覆盖本目录的归档文件。完整页面仅用于本地复核，不在资料仓库中整页再分发；短引文按空白规范化保存，不宣称是完整原文镜像。前版 Calculet 帮助与历史证据保留原样。
