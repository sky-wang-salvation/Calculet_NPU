# Calculet NPU 黑客松 · 选手快速开始

赛题文档：http://115\.159\.82\.89/

## 1\. 环境

- Linux x86\_64

- 已安装 rustup（https://rustup\.rs ，国内可用 [https://rsproxy\.cn](https://rsproxy.cn) ）

- git

## 2\. 安装工具链

```bash
curl -sSf http://115.159.82.89/install.sh | sh
```

装好后有一个名为 `calculet` 的工具链（rustc 1\.98\.1 \+ NPU 设备 target），以及 `docc`、`dort` 两个命令。

## 3\. 获取代码

三个仓库放在同一目录下：

```bash
for r in calBLAS calDNN npu; do git clone http://115.159.82.89/git/calculet/$r.git; done
```

|仓库|内容|
|---|---|
|npu|写 kernel 的基础库：存储空间、tile、原语、`#[npu::kernel]`（语法见 SYNTAX\.md）|
|calDNN|算子接口与图 API|
|calBLAS|算子库与模型例子（`examples/`），已有算子见 README|

## 4\. 编译第一个例子

```bash
cd calBLAS
cargo build -p tiny --lib --target dopamine-unknown-none-elf
ls target/dopamine-unknown-none-elf/npu/    # tiny.cvxo（CalVX 目标文件）、tiny.cvx（可读汇编）
```

仓库里已配置好工具链，进入目录后 cargo 会自动使用 `calculet`。

## 5\. 在自己的工程里引用

```toml
# .cargo/config.toml
[registries.calculet]
index = "sparse+http://115.159.82.89/git/api/packages/calculet/cargo/"

# rust-toolchain.toml
[toolchain]
channel = "calculet"

# Cargo.toml
[dependencies]
npu = { version = "0.1.0", registry = "calculet" }
caldnn = { version = "0.1.0", registry = "calculet" }
calblas = { version = "0.1.0", registry = "calculet" }
```

## 6\. 说明

- 代码仓库和包源都可以匿名访问，不需要账号。

- 只需要写 Rust；`.cvx` 只用来调试。

- 真机资源有限，请先在本地把设备遍编通。

- 提交方式与 FAQ 另行发布。

