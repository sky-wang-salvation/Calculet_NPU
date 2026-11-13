# 01｜从零搭建 Calculet 环境，到 tiny 原生包静态检查

记录日期：2026-11-14。安装排障记录与后续编译、CPU 参考、打包、检查结果，均来自本次开发过程中提供的 Linux 容器终端记录；整理文档时未重新执行这些操作。

**本章已经实测到：生成测试权重、运行 CPU 参考、编译完整 CalVX 程序、生成原生 calbin，并通过 doctor 的硬性完整性检查。尚无真机访问入口，没有进行 NPU 执行、真机数值比对或性能测量。**

## 1. 先明确开发目标和完成边界

第一次上手先不改算子、不搬大模型，也不新建自己的 Rust 工程，先使用官方 `tiny` 示例跑通本地链路。

| 阶段 | 本次状态 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 安装 Rust 与 calculet 工具链 | 已完成 | 当前容器能找到并使用所需工具 | SDK 能在任意系统直接安装 |
| 默认 tiny 设备编译 | 已完成 | 能生成 `.cvxo` / `.cvx` | 已生成完整可执行模型或已上板 |
| 生成权重、运行 CPU 参考 | 已完成 | 有固定输入与可复现的比较基线 | NPU 数值正确 |
| 带 `step` 编译完整程序 | 已完成 | 完整程序能生成 CalVX | 本次 cargo 已生成原生 ELF |
| `docc` 原生生成与打包 | 已完成 | 生成了原生包；后续检查确认有 CCU ELF | 真机已成功部署或执行 |
| `docc calbin doctor` | 硬性检查通过，保留 3 条警告 | 无拒收项、稳态命令流可解码 | 连续推理安全、真机数值正确 |
| `dort` 真机执行与性能测量 | 未执行 | 仅查看了命令帮助 | 不能给出 NPU 正确性或性能结论 |

目标硬件由使用者确认是**两芯粒、每芯粒 16 核**。示例中的 `#[npu::program(chiplets = 2, cores = 2)]` 是 SDK 的程序配置；这里的 `cores` 与上述硬件核数的映射没有核实，不能直接把它改成 `16`，也不能由此断言设备不匹配或只使用了某个比例的算力。

## 2. 环境和目录约定

### 2.1 本次环境

- Linux x86_64 容器，使用 Bash。
- 有 `git`、`curl` 和基础编译、链接工具。
- 最初当前用户环境中没有可用的 `rustup`、`rustc`、`cargo`。
- 命令记录中的 shell 为容器内 `root`；不需要额外使用 `sudo`，这不意味着适合在宿主机上以 root 盲目安装。
- 以下路径以 `/data/tianjin_hackthon` 为例，可换成自己的工作目录。

本 GitHub 仓库用于保存资料与实验记录，**不是**下面三个 SDK 仓库的替代品。

### 2.2 环境自检

```bash
uname -m
```

本次输出为 `x86_64`。

```bash
command -v git curl
```

应能看到这两个命令的路径。

```bash
command -v rustup rustc cargo
```

本次安装前没有输出。此时先诊断有没有安装，不要直接假定只是 PATH 问题，诊断过程见第 12 节。

### 2.3 三个 SDK 仓库必须平级

```text
/data/tianjin_hackthon/
├── calBLAS/    算子实现、模型示例与本章的 Rust 工作区
├── calDNN/     算子接口、图 API
└── npu/        NPU 原语、存储与程序声明
```

原因是 `calBLAS/Cargo.toml` 使用了 `../calDNN`、`../npu` 这样的相对路径依赖，不能把三个仓库互相嵌套。

选择或创建父目录：

```bash
mkdir -p /data/tianjin_hackthon
```

```bash
cd /data/tianjin_hackthon
```

在父目录执行官方克隆命令：

```bash
for r in calBLAS calDNN npu; do git clone http://115.159.82.89/git/calculet/$r.git; done
```

如果目录已经存在，先确认是否就是自己的 SDK 检出，不要覆盖、删除或重置已有工作。

## 3. 安装 Rust 和 calculet 工具链

安装顺序是：**先有 rustup，再执行官方 calculet 安装脚本，最后确认当前 shell 的 PATH。**

### 3.1 先下载并审阅官方脚本

下面使用独立临时目录保存下载脚本，避免覆盖已有的 `/tmp` 文件；这是对原安装记录使用固定临时文件名的安全性调整，后续安装参数不变。

```bash
INSTALL_DIR="$(mktemp -d /tmp/calculet-setup.XXXXXX)"
```

```bash
curl -sSf http://115.159.82.89/install.sh -o "$INSTALL_DIR/install.sh"
```

```bash
cat "$INSTALL_DIR/install.sh"
```

初次排障时审阅的脚本为 16 行，没有使用 `sudo` 或删除命令；它要求先有 `rustup`，安装 `nightly-2026-11-13`，将其注册为 `calculet` 工具链，并将 `docc`、`dort` 链接到命令可见的位置。

**这些是当时脚本的事实，不是对未来版本的安全保证。** 每次安装都应审阅实际下载内容；HTTP 没有传输完整性保护，审阅脚本也不能验证其后续下载的二进制。优先在隔离环境使用主办方确认的分发渠道，不要把 HTTP 脚本直接管道到高权限 shell。

### 3.2 安装 rustup，不额外安装 stable

本次实际采用了 Rust 官方 HTTPS 安装入口，参数如下；只在确认信任该来源后执行：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
```

`--default-toolchain none` 表示暂不下载默认 stable 工具链，本次需要的是后续安装的定制 `calculet`。

### 3.3 让当前 shell 找到 cargo

已打开的 shell 不会自动刷新 PATH。可以加载 rustup 的环境文件：

```bash
source "$HOME/.cargo/env"
```

也可以重新打开终端；原安装记录通过下面这条命令显式更新 PATH：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

### 3.4 执行已经审阅的 calculet 脚本

在与第 3.1 节相同的 shell 中执行，以保留 `INSTALL_DIR` 变量：

```bash
sh "$INSTALL_DIR/install.sh"
```

检查安装结果：

```bash
rustup toolchain list
```

```bash
rustc +calculet --version
```

```bash
command -v docc dort
```

初次安装记录中工具链名为 `calculet`，编译器版本为 `1.98.1`；版本信息仅描述本次环境，复现时应记录自己的输出，不要混用旧 README 中的工具链与产物命令。

## 4. 编译第一个 tiny：先确认设备编译可用

进入 SDK 工作区。**从这里到第 11 节，除非另有说明，所有相对路径均以 `calBLAS` 根目录为基准。**

```bash
cd /data/tianjin_hackthon/calBLAS
```

仓库的 `rust-toolchain.toml` 配置了 `channel = "calculet"`，进入目录后 cargo 会选择该工具链。

```bash
cargo build -p tiny --lib --target dopamine-unknown-none-elf
```

不要自行更换 target 名称。这里编译的是 NPU 设备代码，不是普通 x86 可执行程序。

检查产物：

```bash
ls -lh target/dopamine-unknown-none-elf/npu/tiny.cvx target/dopamine-unknown-none-elf/npu/tiny.cvxo
```

- `tiny.cvxo`：CalVX 目标文件。
- `tiny.cvx`：可读 CalVX 汇编，便于检查；本章后续也按打包器输入约定复制使用，不要求手写汇编。

默认构建主要验证 kernel 的编译路径。完整程序入口需要第 7 节的 `step` feature，不能把这一步直接当作完整模型已经可运行。

### 4.1 如何理解“ELF 还没接上”的警告

本次出现了：

```text
warning: npu：ELF 要 docc 收 CalVX 1.0（还没接上），这次只出了 CalVX
```

它说明**这次 cargo 构建只生成了 CalVX，没有生成原生 ELF**。即使 target 名字包含 `elf`，也不能仅凭 `Finished` 宣称原生编译完成。

但这条警告**不等于单独调用 docc 必然失败**。本次第 9 节的独立打包成功，第 10 节又实际检查到了 4 个 CCU ELF，证实当前组合可以通过后续链路生成原生产物。

## 5. 生成固定测试权重

先创建一个新的测试目录：

```bash
mkdir target/tiny-check
```

本章中的测试、打包输入和打包输出目录均按首次创建设计；若目录或输出路径已存在，先检查内容并换用新名字，不要覆盖原有实验结果。

运行仓库自带的权重生成器：

```bash
cargo run -p tiny-pack --bin tiny-pack -- target/tiny-check
```

本次实际输出：

```text
wrote target/tiny-check/param_blk0.bin（6221824 字节 = 5.93 MiB）
wrote target/tiny-check/param_blk1.bin（6221824 字节 = 5.93 MiB）
```

两块权重对应两芯粒，使用固定种子生成，供功能与数值回归使用，不是训练好的语言模型权重。不要用生成的 token 是否像自然语言评价这个示例。

`TK`、`off`、`layer`、`down_zero`、`WEIGHTS` 等 `dead_code` 警告来自共享布局文件中的未使用项；本次生成器正常完成，不需要为消除这些警告修改 SDK。

## 6. 在 CPU 上生成参考输出

固定输入 token 为 `7`，并保存参考文件：

```bash
cargo run -p tiny-pack --bin tiny-ref -- target/tiny-check 7 target/tiny-check/cpu-out.bin
```

本次实际输出：

```text
token 7 ⇒ argmax 303（两半词表相同 ⇒ 前 256 名里的 47）
前 16 个 logits：[0.083984375, 0.32421875, 1.03125, -0.21972656, 0.17675781, -0.104003906, 1.0078125, -0.20703125, -1.109375, -0.75, 0.42578125, 0.79296875, -0.3515625, 0.052246094, 1.015625, 0.7578125]
专家号从 1 数、权重见 kernel；logits 的量级 -2.4062…2.5938
写出 target/tiny-check/cpu-out.bin（1024 字节 bf16）
```

`1024` 字节对应 `512` 个 bf16 值。这份测试权重下，两半词表的输出相同，`303` 对应另一半中的 `47`，不是出现了越界 token。

这些数值是本次特定源码、权重和输入组合的记录，不是所有 SDK 版本都必须打印的固定答案。`tiny-ref` 是 CPU 数值参考，不是保证与 NPU 逐位相等的金标准；后续要按数值误差比较，不能把整个文件字节相同作为唯一要求，也不能自行将某个经验容差当成赛方验收标准。

## 7. 启用 step，编译完整程序

`tiny` 没有可直接 `cargo run -p tiny` 的主机入口；它的 `lib.rs` 通过 `step` feature 引入完整程序。

```bash
cargo build -p tiny --lib --features step --target dopamine-unknown-none-elf
```

本次构建成功，但仍提示“只出了 CalVX”，含义与第 4.1 节一致。

检查文件是否已在本次构建中更新：

```bash
ls -lh target/dopamine-unknown-none-elf/npu/tiny.cvx target/dopamine-unknown-none-elf/npu/tiny.cvxo
```

本次带 `step` 的产物约为：

```text
tiny.cvx   110K
tiny.cvxo   19K
```

这只是当次文件大小，不是验收阈值。不能把早先不带 `step` 的旧文件拿去打包；文件不存在或时间未更新时，应先检查构建日志，不要继续。

## 8. 确认当前版本的打包命令

```bash
docc calbin from-calvx --help
```

本次工具显示的核心语法是：

```text
Usage: docc calbin from-calvx [OPTIONS] --out <OUT> <DIR>
```

同时提供 `--network`、`--max-seq-len`、`--ddr`、`--sram`、`--arg`、`--entries`、`--no-params` 等参数。本次使用默认配置完成打包，没有凭猜测补地址、修改入口或使用 `--no-params`。

输入约定来自 SDK 完整程序构建说明：目录内放名为 `step.cvx` 的完整程序，以及每芯粒的 `param_blk*.bin`。本次使用的是文本 `tiny.cvx` 的副本，不是把二进制 `.cvxo` 改后缀伪装成文本。

## 9. 生成原生 calbin

创建新的独立输入目录：

```bash
mkdir target/tiny-native-input
```

复制第 7 节刚生成的完整程序，按约定命名：

```bash
cp target/dopamine-unknown-none-elf/npu/tiny.cvx target/tiny-native-input/step.cvx
```

复制两芯粒的测试权重：

```bash
cp target/tiny-check/param_blk0.bin target/tiny-check/param_blk1.bin target/tiny-native-input/
```

此时目录为：

```text
target/tiny-native-input/
├── step.cvx
├── param_blk0.bin
└── param_blk1.bin
```

`cpu-out.bin` 是后续数值比对用的，不属于打包输入，不要复制进来。

确认输出路径没有已有实验结果后执行：

```bash
docc calbin from-calvx target/tiny-native-input --out target/tiny-native-output
```

本次实际输出：

```text
wrote target/tiny-native-output
```

检查生成目录：

```bash
ls -lah target/tiny-native-output
```

本次结构为：

```text
target/tiny-native-output/
├── model_memory_reserved_info.txt
├── param_blk0.bin
├── param_blk1.bin
└── tiny-native-input/
```

输出根目录名是 `tiny-native-output`，报告中的模型/子模型名则为 `tiny-native-input`，两者不要混淆。

## 10. 用 doctor 做离线完整性检查

先核对本地版本语法：

```bash
docc calbin doctor --help
```

本次帮助明确说明：检查清单解析、加载规则、被引用文件和稳态命令流；拒收项或流解码失败会返回失败，只有警告不会使检查失败。

执行检查：

```bash
docc calbin doctor target/tiny-native-output
```

本次报告中的主要事实：

| 项目 | 实际结果 |
| --- | --- |
| 模型名 | `tiny-native-input` |
| 模型类型 / 子模型类型 | `llm` / `llm_decode` |
| 设备类型 | `ks1` |
| 权重 | 两块，各 `6221824` 字节 |
| CCU ELF | 4 个，共 `166416` 字节 |
| CPU command stream | 4 个，共 `984` 字节 |
| `pld_` stream | 扫描到 4 个，共 `1064` 字节，报告说明不在清单中 |
| 张量 | 输入 2、输出 1、ICSR 2 |
| 文件总计 | 16 个，共 `12613529` 字节 |
| 检查结论 | 拒收 0 条、警告 3 条、解不开的稳态流 0 份 |

生成的 CCU 镜像为：

```text
ccu0_chip0.elf
ccu1_chip0.elf
ccu0_chip1.elf
ccu1_chip1.elf
```

这说明后续 `docc` 链路确实生成了原生 ELF；镜像数量不能用于推断“每芯粒 16 核”对应的物理计算单元利用率。

报告中的 `max_seq_len=32768`、DRAM/SRAM 保留区是包的配置与预留信息，不是 tiny 已验证的上下文能力，也不是实测设备内存占用或性能结果。

### 10.1 必须保留的 3 条警告

三个张量的 ping/pong 分别使用了相同地址：

| 张量 | ping 与 pong 的共同地址 |
| --- | --- |
| `in_input_ids` | `0xc05f0000` |
| `in_position_ids` | `0xc0600000` |
| `out_outputs_0` | `0xc0610000` |

这与 `dead_code` 不同：它们是实际的数据覆盖风险。前后两轮执行重叠，或上一轮结果尚未读取就被下一轮复用时，数据可能被覆盖。

因此本次结论应写为：**硬性完整性检查通过，但保留 3 条缓冲区复用警告，尚未验证真机或连续推理安全性。**

不能为了消警告而随意手改清单地址，也不能仅凭静态检查通过就启动循环、流水或并发推理。单次运行计划也只是避免主动进入多轮场景，不代表已经修复这些警告或证明单次真机运行正确。

## 11. 真机验证计划：尚未执行

本次没有设备访问入口。实际执行过的只有帮助命令：

```bash
dort calbin run --help
```

帮助指出 `run` 会部署、送入输入、等待完成并读取输出；`--deploy-only` 仍然会修改设备状态。**不要在没有授权、未确认分配设备的共享主机上尝试它们。**

### 11.1 获得设备后需要确认的条件

- 有主办方提供的登录/运行入口、设备访问权限与正确驱动环境；本地容器能编译不等于它能访问 NPU。
- 明确分配的设备下标，不默认选择 `0`，也不省略设备选择来尝试所有设备。
- 把完整的 `target/tiny-native-output` 目录放到运行主机的对应路径，不能只传 `.cvx` 或权重。
- 保留本次权重、CPU 参考和源码/工具链版本；确保真机与 CPU 使用的是相同的测试数据。
- 保留默认板锁；没有外部锁持有约定时不使用 `--board-lock external`。

### 11.2 单次运行候选模板，不是已实测命令

下面按本次 `dort --help` 与 `doctor` 报告组织。只有在已获授权的运行主机上，才能将环境变量 `NPU_DEVICE_INDEX` 设置为主办方分配的数字下标后尝试；未设置该变量时，Bash 会在执行 `dort` 前停止。

```bash
dort calbin run \
  --calbin target/tiny-native-output \
  --index "${NPU_DEVICE_INDEX:?先设置主办方分配的设备下标}" \
  --model tiny-native-input \
  --tokens 7 \
  --steps 1 \
  --in-tokens in_input_ids \
  --in-positions in_position_ids \
  --out-logits out_outputs_0 \
  --dump-layout \
  --dump-out target/tiny-board-output
```

- `--tokens 7` 与 CPU 参考的输入相同。
- `--steps 1` 按帮助只走一轮；它不是 ping/pong 同址问题的修复，也不证明这个 `llm_decode` 包具有通用 prefill 能力。
- 使用包中实际的 token、位置和 logits 张量名，而不是运行器默认名字。
- 不走 `--raw-in`：按帮助，LLM 路径会设置相关状态；本次整步程序不应通过裸字节模式绕过它。
- `--dump-layout` 用于检查设备上的实际部署落点，不只看一句“部署成功”。
- 帮助约定每步输出为 `<tag>-<步>.bin`；实际路径和运行行为需要真机日志确认，本次没有生成设备输出。

拿到输出后，再确认 logits 在输出张量中的位置和长度，提取与 CPU 参考对应的 `512` 个 bf16 值，检查有限性并做数值误差比较。不要直接将可能带额外空间的整个设备输出文件与 `1024` 字节 CPU 文件按长度或逐字节相等判定；容差由实际数值语义与主办方验收要求决定。

本章不提供 NPU 耗时、吞吐、精度通过率或真机运行成功结论；赛事提交方式仍需以组委会最新发布为准。

## 12. 安装问题的 debug 过程与 FAQ

### 12.1 主问题：`cargo: command not found`

本次不是先补 PATH 就结束，而是依次检查：

```bash
command -v cargo
```

```bash
ls -ld "$HOME/.cargo/bin" "$HOME/.rustup"
```

最初命令不可见，当前用户的两个目录也不存在，结合容器初始化情况，定位为当前环境没有安装 Rust，而不是已经安装后单纯未加载 PATH。若使用了自定义 `CARGO_HOME`、`RUSTUP_HOME` 或管理员提供的安装位置，还需要核对这些配置，不能仅凭默认目录不存在断言整台机器从未安装过 Rust。

随后读取 `rust-toolchain.toml` 与 `.cargo/config.toml`，确认项目选择定制 `calculet` 工具链与相应源；再审阅安装脚本，确认它依赖先有 `rustup`。因此采用 rustup → 加载 PATH → calculet 脚本的顺序，重跑默认 tiny 编译后成功。

初次排障记录的该次构建约为 32 秒；后续终端记录中，权重工具构建约 13.54 秒、CPU 参考工具构建约 14.45 秒、带 `step` 的设备构建约 9.96 秒。这些是当次开发机日志中的构建阶段耗时，**不是 NPU 推理性能**，不用于跨环境性能比较。

### 12.2 现象、原因与处理速查

| 现象 | 本次原因或边界 | 处理 |
| --- | --- | --- |
| 找不到三个 SDK 仓库 | 还没克隆 | 在同一父目录克隆，保持平级 |
| `cargo: command not found` | 初次容器环境没有 Rust | 先诊断安装位置，再安装 rustup 和 calculet |
| 装完 rustup，旧 shell 仍找不到 cargo | PATH 没刷新 | 加载 `$HOME/.cargo/env` 或重开终端 |
| 默认目录不存在 | 只能直接说明默认位置无安装 | 同时检查命令、环境变量与已知安装方式 |
| 提示“ELF 还没接上，只出了 CalVX” | cargo 这一步未生成原生 ELF | 验证 CalVX 产物，再独立运行 docc；本次该后续链路成功 |
| 想执行 `cargo run -p tiny` | tiny 本身无主机二进制入口 | 使用 `tiny-pack` / `tiny-ref`，完整设备入口启用 `step` |
| `tiny-pack` / `tiny-ref` 有 `dead_code` | 共享布局中存在未使用项 | 本次工具正常结束，无需为了消警告改代码 |
| `doctor` 有 ping/pong 同址警告 | 缺少独立的交替缓冲，存在覆盖风险 | 保留警告，不擅改地址；暂不进行连续或并发运行 |
| 硬件每芯粒 16 核，示例却写 `cores = 2` | 两种核数口径的映射未核实 | 保留示例配置，向 SDK 提供方确认 |
| 没有真机 | 不能验证设备执行和性能 | 本地做到原生包与静态检查，单独标注待验证项 |

## 13. 保留实验基线

复现时应记录自己的版本，而不是把其他人的历史提交号当作必须回退的版本。以下均在 `calBLAS` 根目录查看：

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

保留 `docc`、`dort` 的安装来源与本次帮助输出，归档本次权重、CPU 参考、带 `step` 的 CalVX、原生包和 doctor 报告。不要将 SDK 安装目录、二进制或权重直接提交到本资料仓库；本章只保存命令和必要的文本结果。

## 14. 资料入口

- [仓库内的选手快速开始](../Calculet%20NPU%20黑客松%20%C2%B7%20选手快速开始.md)
- [SDK 主页](http://115.159.82.89/)
- [npu 语法与程序声明](http://115.159.82.89/git/calculet/npu/src/branch/main/SYNTAX.md)
- [tiny 源码](http://115.159.82.89/git/calculet/calBLAS/src/branch/main/examples/tiny)
- [tiny 权重生成器与 CPU 参考](http://115.159.82.89/git/calculet/calBLAS/src/branch/main/examples/tiny/pack)
- [完整程序的 calbin 打包输入约定](http://115.159.82.89/git/calculet/calBLAS/src/branch/main/examples/minimax_h3/README.md)

SDK 文档与服务可能更新。遇到与本章不一致的输出，应保留当前版本和原始错误，按实际工具帮助与配套源码定位，不要拼接旧 README、不同版本的 target 或历史设备命令。
