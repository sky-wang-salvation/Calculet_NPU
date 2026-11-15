# DSH-SN4CK：归档安装与隔离验收

版本：`dsh-sn4ck@0.2.0`。本项目提供适用于官方 **DeepSeek Harness `0.2.2-rc.3`** 的 npm `.tgz` 插件归档；不是另一个 Harness 发行版，也不修改上游 Agent 循环。安装不要求克隆整个研究仓库。

**安装成功不等于 NPU 或模型已经运行。** 服务默认没有适配器，计划应返回 `blocked / ADAPTER_NOT_CONFIGURED`。本归档不包含 SDK、驱动、权重、真实模型适配器、凭据、测试夹具或规划模型账号。发布包的打包与干净安装检查不连接共享 NPU、不调用规划模型、不制造成功图片。

## 1. 交付内容和运行前提

| 项目 | 要求或交付 |
| --- | --- |
| Node.js | `>=24.9.0 <25`，使用 Node 24；当前验收环境为 Windows x64、Node 24.15.0 |
| 官方宿主 | 验证基准 `@deepseek-ai/dsh@0.2.2-rc.3`；开放 peer 范围不等于其他版本已验证 |
| 插件安装器 | 固定 pnpm `11.28.5`，只安装在项目目录，不修改全局 Node/npm/pnpm |
| 命令终端 | Linux/macOS Bash，或 Windows Git Bash；以下 shell 命令不是 PowerShell 语法 |
| 在线安装 | 首次需要访问 npm registry 取得官方宿主和依赖；`.tgz` 只包含团队插件，不包含上游依赖 |
| 归档 | `dsh-sn4ck-0.2.0.tgz`，配套 `.sha256` 和 `.manifest.json` |
| 包内入口 | 预编译 `lib/`、Cordis bundle patch、`bin/sn4ck-npu-service.mjs` |
| 包内部署运行时 | `runtime/` 下完整 Node 内置模块服务、无密钥配置示例、任务示例、契约和安装文档 |
| 真机前提 | 厂商 SDK/驱动已配置，真实适配器与组件摘要已绑定，权重许可及操作者批准窗口和共享设备协调另行成立 |

Release 归档已预编译并移除开发生命周期 scripts，不需要消费者编译 TypeScript。源码包保留 `prepare`/`prepublishOnly` 供开发和另行获准的 npm 发布使用。四项 DSH peer 依赖按要求声明为 `*`；测试宿主仍固定为0.2.2-rc.3，不把其他版本当成已验证。`runtime/MANIFEST.json` 记录包内文件摘要，外部 `.manifest.json` 记录归档摘要、完整清单和输入来源。摘要不证明来源可信，应从本仓库 Release 获取资产。

## 已有 DSH：直接安装 Release

```bash
dsh plugin --profile web add https://github.com/sky-wang-salvation/Calculet_NPU/releases/download/v0.2.0/dsh-sn4ck-0.2.0.tgz --ignore-scripts
```

```bash
dsh --profile web --dump-config
```

[Release v0.2.0](https://github.com/sky-wang-salvation/Calculet_NPU/releases/tag/v0.2.0) 提供 `.tgz`、同字节 `.tar.gz` 别名、校验和与清单。预期包含 `# == dsh-sn4ck`、`id: sn4ck`、`name: dsh-sn4ck`。替换 `web` 可安装到其他已有 profile；不要对已有 profile 使用重置模板选项。

旧包更名升级时仅在确认已安装旧包的目标 profile 移除：

```bash
dsh plugin --profile web remove dsh-calculet-npu
```

再安装新包。旧私有覆盖层的 `id: calculet-npu` 需在本地改为 `id: sn4ck`，后端地址与密钥不变，不能把含密钥文件提交。此更名不改变 `calculet.*` HTTP/文件协议或 `CALCULET_DEPLOY_TOKEN`。

本轮没有执行 npm publish。只有团队另行完成 npm 版本发布后，`dsh plugin --profile web add dsh-sn4ck@0.2.0` 才能作为 registry 安装入口。本仓库根目录不是插件包，不使用 `github:sky-wang-salvation/Calculet_NPU#v0.2.0` 直接安装；GitHub 自动生成的源码 zip 也不是预编译插件。

下节用于没有本地宿主环境的接收者，或需要完全隔离安装的工程师。

## 2. 从新目录安装官方宿主和插件

没有 Node 时，先通过组织批准渠道或 [Node.js 官方下载页](https://nodejs.org/en/download) 安装 Node 24，再重新打开终端。Node 自带 npm；Git Bash 可由组织批准的 Git for Windows 安装取得。无需先安装 Python、SDK 或下载模型就能完成本节的安装/阻塞自检。

```bash
node --version
```

```bash
npm --version
```

Node 输出须为符合上表范围的 `v24.x`。接收者选择一个**不存在的新目录**，避免覆盖其他项目或已有 profile：

```bash
mkdir sn4ck-harness-0.2.0
```

```bash
cd sn4ck-harness-0.2.0
```

从本仓库 Release 下载三件套到该目录（或由团队提供同一发行资产）：

```bash
curl --fail --location --output dsh-sn4ck-0.2.0.tgz https://github.com/sky-wang-salvation/Calculet_NPU/releases/download/v0.2.0/dsh-sn4ck-0.2.0.tgz
```

```bash
curl --fail --location --output dsh-sn4ck-0.2.0.sha256 https://github.com/sky-wang-salvation/Calculet_NPU/releases/download/v0.2.0/dsh-sn4ck-0.2.0.sha256
```

```bash
curl --fail --location --output dsh-sn4ck-0.2.0.manifest.json https://github.com/sky-wang-salvation/Calculet_NPU/releases/download/v0.2.0/dsh-sn4ck-0.2.0.manifest.json
```

Linux 和 Git Bash 可校验：

```bash
sha256sum -c dsh-sn4ck-0.2.0.sha256
```

预期归档名后为 `OK`。macOS 使用：

```bash
shasum -a 256 -c dsh-sn4ck-0.2.0.sha256
```

如果不匹配，停止安装并重新获取原始交付物，不修改摘要文件使其通过。随后初始化本地 npm 工程：

```bash
npm init -y
```

```bash
npm install --ignore-scripts --save-exact --no-audit --no-fund --maxsockets=1 --fetch-retries=2 --cache .local/npm-cache @deepseek-ai/dsh@0.2.2-rc.3 pnpm@11.28.5 ./dsh-sn4ck-0.2.0.tgz
```

`--ignore-scripts` 不运行任何第三方安装脚本；本包不需要这些脚本。此步骤验证包可被普通 npm 消费，但**还没有启用官方 Harness profile bundle**。宿主的通用 shell/PTY 等非本插件功能可能另外需要其官方运行前提，不能从本检查推断全部宿主功能已通过。

为当前目录创建专用 Harness 数据目录，并只把本地命令加入当前终端 PATH：

```bash
export DSH_HOME="$PWD/.local/dsh-home"
```

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
```

```bash
node node_modules/pnpm/bin/pnpm.cjs --version
```

预期 `11.28.5`。仅在上述**全新 DSH_HOME** 下首次初始化 Web 模板：

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile calculet --from-default-profile web --dump-config
```

`--from-default-profile` 会重置同名 profile；不能在已有用户 profile 上重复运行。日常检查和启动不带该选项。安装归档到专用 profile：

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile calculet add "$PWD/dsh-sn4ck-0.2.0.tgz" --ignore-scripts --network-concurrency=1 --child-concurrency=1 --store-dir "$PWD/.local/pnpm-store"
```

官方固定版本 CLI 的帮助和源码已确认该命令转交 pnpm，且支持本地 `.tgz`，不是把源代码目录链接进 profile。需要联网的只是缺失的宿主/插件 peer 依赖，归档本身不会上传。

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile calculet --dump-config
```

预期组合配置包含 `id: sn4ck`、`name: dsh-sn4ck`；profile 的 `package.json` 中 `dsh.profile.bundles` 包含 `dsh-sn4ck`。`--dump-config` 只证明 bundle 组合，不证明模型聊天、工具选择、PNG 浏览器鉴权或真机推理。

## 3. 启动包内服务：默认阻塞是安全结果

不需要研究仓库的任何相对路径；在上一节安装目录执行：

```bash
node node_modules/dsh-sn4ck/bin/sn4ck-npu-service.mjs --version
```

```bash
node node_modules/dsh-sn4ck/bin/sn4ck-npu-service.mjs --help
```

预期版本 `dsh-sn4ck 0.2.0`，帮助说明仅回环绑定和默认无适配器。npm 还生成本地 `sn4ck-npu-service` bin shim；直接使用 Node 路径可避免不同终端的 shim 差异。

创建本地目录并复制无密钥示例；只在新文件不存在时复制，不覆盖已有硬件配置：

```bash
mkdir -p .local
```

```bash
cp -n node_modules/dsh-sn4ck/runtime/config.example.json .local/deployment.config.json
```

```bash
cp -n node_modules/dsh-sn4ck/runtime/task.example.json .local/task.json
```

示例 `adapter`、`operatorAuthorization`、`resourceLockPath` 均为 `null`。默认状态目录相对配置文件所在目录解析，复制后的配置将使用安装目录的 `.local/deployment`，不写入 `node_modules/`。

在准备启动服务的终端生成仅用于本地检查的令牌：

```bash
export CALCULET_DEPLOY_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
```

```bash
node node_modules/dsh-sn4ck/bin/sn4ck-npu-service.mjs --config .local/deployment.config.json
```

预期日志公布 `http://127.0.0.1:8766`，不打印令牌。管理/查询 API 要求 Bearer Token；产物读取另支持服务签发的限时、单产物只读签名 URL。缺少或过短的服务令牌返回 `503 AUTH_NOT_CONFIGURED`，无授权请求返回 `401`。此终端由服务占用；客户端应通过本地受控密钥管理取得**同一个**令牌，在另一个终端进入安装目录后使用。不能在新终端生成另一个令牌并期望访问旧服务，也不能把令牌贴入公开聊天/截图或 URL。

以下命令在已经安全恢复同一 `CALCULET_DEPLOY_TOKEN` 的客户端终端执行：

```bash
curl --fail-with-body -H "Authorization: Bearer $CALCULET_DEPLOY_TOKEN" http://127.0.0.1:8766/v1/capabilities
```

预期 `executionKind=not_run`、`models=[]`。

```bash
curl --fail-with-body -H "Authorization: Bearer $CALCULET_DEPLOY_TOKEN" -H "Content-Type: application/json" --data-binary @.local/task.json http://127.0.0.1:8766/v1/deployment-plans
```

预期 `status=blocked`、`ADAPTER_NOT_CONFIGURED` 和合法 SHA-256 `planDigest`。不能以修改返回值、启用夹具或绕过授权来消除该阻塞。Ctrl-C 仅停止本服务；重启遗留任务进入 `reconciling`，不盲目重跑设备计算。

## 4. 把插件接到同一服务

bundle 默认 `backendURL` 留空，九项工具可注册但不自动使用演示或云端服务。操作者在安装目录创建私有文件 `.local/npu.patch.yml`，以实际本地令牌替换占位符：

```yaml
- id: sn4ck
  config:
    backendURL: http://127.0.0.1:8766
    apiToken: REPLACE_WITH_THE_SAME_LOCAL_SERVICE_TOKEN
- id: session-log-deepseek
  config:
    enabled: false
- id: session-telemetry-otel
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
```

该文件含密钥，必须置于私有目录，加入本地版本控制排除，不上传、不截图。下列运行命令叠加该私有配置并只绑定回环：

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile calculet --patch .local/npu.patch.yml --host 127.0.0.1 --port 3080
```

按宿主输出的本地认证地址打开页面，不公开认证 URL。`npu_status` 应显示已连接但 `not_run`，`npu_list_models` 为空；`npu_plan_deployment` 可得到同一缺适配器阻塞。`npu_apply_deployment` 不是用户授权替代品，服务会独立拒绝不可执行计划。

九项工具为 `npu_status`、`npu_list_models`、`npu_generate`、`npu_get_job`、`npu_wait_job`、`npu_plan_deployment`、`npu_apply_deployment`、`npu_get_deployment_job`、`npu_wait_deployment_job`。实际自然语言选择工具还需要操作者配置获准的规划模型并保留脱敏工具轨迹，不能由直接调用工具的测试代替。关闭遥测不阻止规划模型 API 本身发送上下文；私有 SDK 资料不得未经许可进入外部模型。

浏览器的 Markdown 图片请求不会自动带插件 Bearer Token。服务现在会为登记产物提供限时、单产物只读签名 URL，签名绑定产物身份和有效期，不含管理 API 的 Bearer Token；过期后需用授权查询取得新链接。签名 URL 本身也属于短期访问凭据，不公开传播。本安装检查只验证无适配器的阻塞路径，未验证真实模型图片卡展示；不得为显示图片把管理 token 加入 URL 或开放任意文件旁路。

## 5. 真实适配器与设备授权另行成立

第一版只有 `sd35-medium` / `sd35-qproj-hybrid-smoke-v1`：256×256、batch 1、4 steps、guidanceScale 1、关闭 T5；每步首层 `transformer_blocks[0].attn.to_q` 在 NPU，其余声明模块在 CPU，`coreMigrationComplete=false`，验收等级仅 `hybrid-smoke`。

接入真实服务前必须同时满足：

- 厂商 SDK/驱动已经在获授权设备环境配置；本包不下载、安装或修改它们。
- 真正模型适配器按 [adapter-contract.md](../deployment/adapter-contract.md) 接受 `--request`/`--result`，不是只包装未使用 prompt/seed 的历史程序。
- executable、script、组件/模型清单和全部影响执行的文件具有明确 SHA-256，并位于受控目录。
- 权重使用许可、操作者授权、实际共享设备协调、未过期且覆盖完整预算的使用窗口，以及外部合作锁均已成立。
- 适配器必须产生真实输出、trace 和相互绑定的证据；`METRICS_ONLY` 不改写为正式精度通过。

配置细节见包内 [服务说明](../deployment/README.md)、[部署集成合同](deployment-integration-contract.md)、[验收合同](deployment-acceptance.md)。没有真实入口或授权时继续保持 `adapter=null`。打包验收不需要、也不得为了测试而连接 NPU、复位设备、杀其他使用者进程或抢占资源锁。

## 6. 从源码生成交付包与重放隔离验收

以下入口只适用于源码仓库的 `harness/` 工作目录，不是下载包的运行依赖。安装源码依赖：

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
npm run test:integration
```

```bash
npm run test:deployment
```

```bash
npm run test:deployment-bridge
```

`test:deployment-bridge` 经过原生 Cordis 工具、实际 Node 服务和明确标注的 simulation 适配器，检查部署、持久作业、能力注册、再次生成及无管理 Bearer Token 的签名单产物读取；API 仍需鉴权。该测试不连接 NPU，fixture 也不会进入发行归档。

```bash
npm run test:package:guards
```

```bash
npm run package:plugin
```

```bash
npm run test:package
```

打包脚本在新 staging 目录重新编译，严格复制 allowlist，拒绝符号链接、路径越界、未知发布文件、二进制/凭据形状内容、缺失或越界导入、运行时第三方依赖、非空适配器默认配置；随后读取实际 npm tgz，再逐项比对摘要和内容。未打包 source map，避免携带源码绝对路径。白名单扫描和模式检查不是完整秘密检测审计；新增发布文件必须人工审查并更新白名单。

`test:package` 每次在 `.local/package-install-*` 建全新消费者 npm 工程、隔离 HOME/DSH_HOME/npmrc、局部 pnpm 和私有状态目录。因为目录按项目要求位于工作区内，所有运行验证额外通过 Node `registerHooks` 的 resolve/load 边界拒绝沙箱外文件模块；ESM、CommonJS 和传递依赖的反例检查证明不能回退到祖先工作区的 TypeScript。该边界也传递给包内服务和官方 CLI/pnpm 子进程。实际安装 tgz 后检查导出、九项原生工具与卸载、包内 CLI、鉴权、默认阻塞和不可应用计划；再通过未修改的官方 CLI `runCli` 及显式本地 pnpm 参数数组执行 `plugin add` 和 `--dump-config`，确认 bundle 被激活。使用该官方公开入口避免 Windows 环境误用全局 pnpm；没有使用 eval 或 shell 拼接用户输入。

成功结果保存在 `dist/dsh-sn4ck-0.2.0.installation.json`，完整命令及日志保存在该次 `.local/package-install-*`。任何一步失败会保留失败报告，不生成本次成功结论。归档字节改变时，打包器把旧安装报告另存为历史文件，将当前报告置为 `not_run`；必须重新执行安装测试并确认 SHA-256 匹配。测试结束时再次检查归档与 manifest 未被并行替换，旧字节的通过不能覆盖新包状态。

`npm run harness:deployment -- --config .local/deployment.config.json` 是源码目录的部署服务入口；下载包使用第3节 `sn4ck-npu-service`。部署服务只使用 Node 内置模块；包内运行时与源码服务是一份白名单复制快照，不依赖工作区外的脚本。

## 7. 终端恢复、网络故障和卸载

新开终端后，先回到安装目录，再恢复第2节 `DSH_HOME` 与本地 `PATH`。令牌通过本地密钥管理恢复同一个值，不能重新生成后继续访问旧服务。不要再次执行 `--from-default-profile`，不要把其他项目的 DSH_HOME 指向此目录。

网络出现 `ECONNRESET` 时保留已有文件，在同一目录重跑原安装命令；低并发和本地 cache 已在命令中明确设置。不要清空用户全局 cache、关闭 TLS 校验、使用 `--force` 忽略兼容性，或为修复插件安装而全局升级 Node/包管理器。官方 CLI 报 pnpm 未找到时，恢复本地 PATH，并用上文局部 pnpm 路径检查版本，不需要全局安装。

移除 profile 中插件：

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile calculet remove dsh-sn4ck
```

保留 `.local/` 中任务与证据用于核对；停止服务不代表设备计算已停止。涉及未知硬件状态、遗留锁或 `reconciling` 时由操作者处理，不把删除目录当作安全恢复。安装目录及其本地依赖的清理须在确认相关服务已停止、证据已归档后由操作者单独执行。
