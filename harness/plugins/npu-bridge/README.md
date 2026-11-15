# DSH-SN4CK

**Native DeepSeek Harness tools for controlled Calculet NPU deployment and generation.**

DSH-SN4CK 将团队受控 NPU HTTP 服务的能力发现、生成、部署计划和异步证据查询注册为 DeepSeek Harness 原生工具。它使用官方 Cordis Bundle、配置 Schema、`defineTool` 和插件生命周期，不替换上游 Agent 循环。

| 标识 | 当前值 |
| --- | --- |
| 对外品牌 | DSH-SN4CK |
| npm 包名 | `dsh-sn4ck` |
| 插件内部 ID / Bundle 组件 ID | `sn4ck` |
| 发行版本 | `0.2.0` |
| 实测宿主 | `@deepseek-ai/dsh@0.2.2-rc.3` |
| Node.js | `>=24.9.0 <25` |

四项 DSH peer 依赖按要求声明为 `*`，不再把该 peer 元数据固定到某个 RC；开发依赖和验证宿主仍锁定版本。开放 peer 范围不等于已验证所有宿主版本。

## Quick Start / 快速安装

### GitHub Release（当前安装入口）

已有官方 DSH CLI 及其可用的 pnpm 插件安装器时，直接安装预编译归档：

```bash
dsh plugin --profile web add https://github.com/sky-wang-salvation/Calculet_NPU/releases/download/v0.2.0/dsh-sn4ck-0.2.0.tgz --ignore-scripts
```

```bash
dsh --profile web --dump-config
```

输出应包含 `# == dsh-sn4ck`、`id: sn4ck` 和 `name: dsh-sn4ck`。`web` 是目标 profile 示例；安装到现有的其他 profile 时替换名称，不需要重置用户 profile。管理 Desktop profile 时先按官方要求初始化，再完全退出 Desktop。

也可从 [v0.2.0 Release](https://github.com/sky-wang-salvation/Calculet_NPU/releases/tag/v0.2.0) 下载 `.tgz`、`.sha256` 和 `.manifest.json`，校验摘要后本地安装：

```bash
dsh plugin --profile web add ./dsh-sn4ck-0.2.0.tgz --ignore-scripts
```

包已经包含 `lib/*.js`、类型声明、`cordis.patch.yml`、通用 Node runtime 与必要说明，无需消费者克隆仓库或编译 TypeScript。Release `.tar.gz` 资产是同一 npm 归档字节的别名，不是 GitHub 自动生成的源码压缩包。

本仓库是多目录工程，根目录不是插件包，不能把 `github:sky-wang-salvation/Calculet_NPU#v0.2.0` 当作当前安装入口；使用 Release 资产 URL。

### npm registry（另行发布后才可用）

本次仅发布 GitHub Release，没有执行 npm publish。只有在团队另行获准、登录 npm 并完成对应版本发布后，下列包名安装命令才成立：

```bash
dsh plugin --profile web add dsh-sn4ck@0.2.0 --ignore-scripts
```

### 从旧名称升级

仅当目标 profile 中已安装旧包时先移除：

```bash
dsh plugin --profile web remove dsh-calculet-npu
```

再执行新包安装命令。旧私有覆盖层若使用 `id: calculet-npu`，需在本地改为 `id: sn4ck`，保留原后端地址与密钥；发布流程不会改写用户的 profile 或密钥文件。HTTP 的 `calculet.*` 协议、模型/能力档案标识以及 `CALCULET_DEPLOY_TOKEN` 环境变量没有因品牌更名而改变。

## Features / 核心能力

| 工具 | 实际行为 |
| --- | --- |
| `npu_status` | 检查配置及服务能力声明；未配置时明确返回未接入 |
| `npu_list_models` | 读取后端实际公布的能力；未配置时为空 |
| `npu_generate` | 提交声明就绪模型的受支持生成任务，不生成演示结果 |
| `npu_get_job` | 查询生成作业状态与受控产物 |
| `npu_wait_job` | 有时限地轮询已有作业；不取消或重复提交计算 |
| `npu_plan_deployment` | 从明确参数形成固定 TaskSpec，取得计划/阻塞项；规划不启动模型 |
| `npu_apply_deployment` | 用原计划摘要与稳定幂等键提交；服务独立复核权限和绑定 |
| `npu_get_deployment_job` | 查询部署阶段、证据、错误和恢复状态 |
| `npu_wait_deployment_job` | 限时等待部署终态；到时保留原作业 ID，不重新部署 |

首版只支持 `sd35-medium` / `sd35-qproj-hybrid-smoke-v1`：256×256、batch 1、4 steps、guidanceScale 1、无 T5、每步首层 `transformer_blocks[0].attn.to_q` 在 NPU。其余声明模块在 CPU，`coreMigrationComplete=false`，验收等级为 `hybrid-smoke`，不是全模型 NPU、正式精度或画质通过。

不支持的模型、shape、全 NPU 要求或隐式回退会明确拒绝，不静默修改用户硬约束。首版不提供任意模型安装、训练或自进化功能。

## Configuration / 配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `backendURL` | string | 空字符串 | 已验证的受控 HTTP(S) 服务根地址；不是 SDK 设备地址 |
| `apiToken` | secret string | 空字符串 | 后端 Bearer Token，使用宿主 secret 配置，不提交到 Git |
| `timeoutMs` | positive integer | `15000` | 单次 HTTP 请求超时，不是整个部署/生成作业预算 |
| `maxResponseBytes` | positive integer | `1048576` | 后端 JSON 响应上限 |
| `maxPromptChars` | positive integer | `8000` | 提示词长度上限 |

安装完成后 `backendURL` 默认留空，九项工具仍能注册，`npu_status` 明确返回 `not_configured`。安装成功不等于设备已经接入。

操作者在私有覆盖文件中配置组件，例如：

```yaml
- id: sn4ck
  config:
    backendURL: http://127.0.0.1:8766
    apiToken: REPLACE_WITH_THE_LOCAL_SERVICE_TOKEN
    timeoutMs: 15000
    maxResponseBytes: 1048576
    maxPromptChars: 8000
```

把占位符替换为本地受控令牌，不上传该文件。完整的空环境准备、服务 CLI `sn4ck-npu-service`、默认阻塞自检与终端恢复见 [安装指南](../../docs/plugin-installation.md)。

工具调用示例（结构化工具参数，不是 shell 命令）：

```json
{
  "tool": "npu_plan_deployment",
  "arguments": {
    "prompt": "A red apple on a wooden table, soft natural light",
    "seed": 20261115,
    "width": 256,
    "height": 256,
    "steps": 4,
    "enableT5": false
  }
}
```

缺少真实适配器的服务应返回 `blocked / ADAPTER_NOT_CONFIGURED`。可用计划还需要操作者核对原始 spec、计划摘要、执行范围及授权；收到 `reconciling` 时不能另造幂等键盲目重跑。自然语言自动选用这些工具需要另行配置获准的规划模型，直接调用工具的测试不替代该验证。

## Permissions & safety / 权限与安全

- **插件客户端**只向配置的后端发送受控 HTTP 请求，不直接访问厂商 SDK、不执行用户 shell、不自动下载模型或访问设备。
- **可选包内服务**仅绑定回环地址，在配置的私有目录持久化作业与证据；只有操作者明确绑定并批准的固定 executable/script 才能以参数数组、`shell:false` 启动。客户端不能选择任意程序或路径。
- 真机还需要 SDK/驱动已配置、合法权重、完整组件摘要、操作者窗口和共享设备协调。服务控制锁不替代板端 SDK 锁，不自动复位设备或停止其他使用者。
- Bearer Token 不进入产物 URL。产物采用短期、单文件绑定的签名链接；持有链接者在有效期内可读取该文件，因此同样不能公开传播。
- `hardware`、`simulation`、`not_run` 分开展示。适配器报告与文件摘要不是独立硬件认证，`METRICS_ONLY` 不能改写为正式数值通过。
- SDK、权重、私有模型交接、历史 PNG、local-references、凭据和 simulation fixture 都不进入发行包。开发测试中的 simulation 不计为 NPU 成绩。

## Bundle format / 挂载格式

当前实测官方 DSH 使用 patch-list，而不是旧式 `plugins:` 映射：

```yaml
- insert:
    - id: sn4ck
      name: dsh-sn4ck
```

清单通过 `package.json` 的 `dsh.bundle.patch` 引用，按 npm 包名挂载，不使用源码相对路径。发布的预编译归档移除开发生命周期 scripts；源码包仍提供 `build`、`prepare` 与 `prepublishOnly`，用于开发/另行发布流程。

## Development / 本地开发

从本仓库 `harness/` 目录执行，使用已锁定的 npm 依赖：

```bash
npm ci --ignore-scripts --cache .local/npm-cache --maxsockets=1
```

```bash
npm run build
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:deployment-bridge
```

```bash
npm run test:package:guards
```

```bash
npm run package:plugin
```

```bash
npm run test:package
```

最终插件归档位于 `harness/dist/dsh-sn4ck-0.2.0.tgz`。不要在 workspace 根目录直接执行 `pnpm pack` 并把私有 workspace 包当作插件；`package:plugin` 会在独立 staging 编译、复制完整 runtime 白名单、检查导入闭包/路径/敏感目录、生成清单和摘要，再验证实际 npm tarball。

安装测试使用独立 HOME/DSH_HOME、局部 pnpm 和模块解析边界，不读取用户全局 profile。测试不连接 NPU，也不调用规划模型。官方聊天的图片渲染、自然语言选择、真实设备数值/画质/性能和完整迁移均需另行验收。

## License / 许可

本项目原创插件、随包原创通用 runtime 及原创说明采用 [MIT](LICENSE)。[NOTICE](NOTICE.md) 明确排除第三方依赖、厂商/赛题资料、SDK、模型权重及私有交接内容；整个 Calculet_NPU 调研仓库不因此被重新许可。

[部署合同](../../docs/deployment-integration-contract.md) · [验收合同](../../docs/deployment-acceptance.md) · [生成协议](../../docs/backend-contract.md)
