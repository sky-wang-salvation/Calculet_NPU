# 本机 Harness 插件开发与交接

日期：2026-11-14。当前完成的是插件第一版和本机宿主安装，NPU 模型仍在独立测试。没有执行模型推理、训练、设备连接或自进化实验。

## 版本与安装方式

| 项目 | 固定值 |
| --- | --- |
| Node.js | 本机 `v24.22.3`，官方 LTS，下载后对照官方 SHASUMS 验证 |
| DeepSeek Harness | `@deepseek-ai/dsh@0.2.2-rc.3` |
| 上游源码依据 | tag `dsh-v0.2.2-rc.3`，commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced` |
| 官方插件安装工具 | pnpm `11.28.5` |
| 插件 | 本仓库 `harness/plugins/npu-bridge`，版本 `0.1.0` |
| 专用 profile | `calculet`，位于 `harness/.local/dsh-home/profiles/` |
| 本机界面 | `http://127.0.0.1:3080`，启动时提供本地认证地址 |

本机通过 npm 安装官方预构建发行包，包内附带对应模块源码；没有完成整个上游 monorepo 的源码检出/构建。没有更改系统 Node、全局 Harness 配置或现有账号。

当前 Mac 的 Node 位于工作区父目录 `.tools/node-v24.22.3-darwin-arm64/bin/`。双击 `harness/Start Calculet Harness.command` 会使用该 Node 启动并打开官方界面。已经运行时无需再启动第二份服务。首次聊天需要用户自行配置模型账号/API Key；当前隔离 profile 未配置模型凭据。

## 其他电脑复现

安装 Node 24.9 以上的 24.x 版本及 pnpm 11.28.5，然后从仓库根目录进入 `harness/` 运行：

```bash
cd harness
npm ci --cache .local/npm-cache
npm run build
npm run typecheck
npm test
node node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs
export DSH_HOME="$PWD/.local/dsh-home"
```

首次创建专用 profile：

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile calculet --from-default-profile web --dump-config
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile calculet add ./plugins/npu-bridge
```

`--from-default-profile` 只用于首次初始化，重复使用会重置 profile。日常启动和检查：

```bash
npm run harness:config
npm run harness
```

启动器固定使用 `harness/` 下的 `.local/dsh-home`，叠加 `scripts/local.patch.yml`。它关闭此 profile 的 session-log 上传和 telemetry exporter，保留本地运行。正常模型 API 调用会向所配置模型服务发送对话；非公开 SDK 资料仍须按赛事授权处理。

NPU 服务就绪后，将 `scripts/npu.patch.example.yml` 复制到 `.local/npu.patch.yml`，在该本地文件填写真实 `backendURL` 和可选 `apiToken`，重启即可。启动器自动应用这个覆盖层，其余字段仍按 schema 校验。不要把填过 Token 的文件上传。未填写地址时，插件仍保持“未接入”。

npm 11.19 提示部分依赖安装脚本未运行。本机已检查并运行官方 `dsh-subprocess-local/scripts/ensure-spawn-helper.mjs`（恢复随包附带的 spawn-helper 执行位）；Web 启动已验证。还没有验证 Harness shell/PTY 等通用工具，不能推断全部宿主功能都通过。

## 目录迁移说明（2026-11-14）

Harness 的文档、源码、启动脚本和 npm 配置已统一到 `harness/`。上文命令及相对路径均以该目录为工作目录。旧工作副本根目录下的 `.local/` 和 `node_modules/` 不会自动迁移；请在新目录重新安装依赖并初始化 profile。已有 profile 如需保留，应先备份，再迁移到 `harness/.local/dsh-home`，并按上文命令重新安装新路径下的插件。凭据与本地运行数据仍不提交。

## 官方开发方式的实际选择

| 官方机制 | 本项目采用方式 |
| --- | --- |
| 独立 ESM 插件 | 导出 `name`、`inject`、`Config`、`apply` |
| 工具扩展 | `defineTool` + `ctx.tools.register`，明确输入输出 schema |
| 配置 | 服务地址、Token、超时和限制通过 schema 提供，不硬编码设备账号 |
| 生命周期 | 工具注册由插件作用域持有，卸载自动清理 |
| 结构化错误 | 协议错误转换为 `HarnessError` 稳定错误码 |
| 安装 | bundle manifest + `cordis.patch.yml`，由 `dsh plugin add` 装入 profile |
| 交互展示 | 先使用官方通用工具结果；专用图片卡按需要再做 client 插件 |

参考固定版本官方文档：[第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/user/develop/basic/index.zh.md)、[工具](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/user/develop/basic/tool.zh.md)、[配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/user/develop/basic/config.zh.md)、[打包安装](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/user/develop/basic/publish.zh.md)、[CLI](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/apps/cli/docs/README.zh.md)。

## 验证范围

- TypeScript 编译和类型检查通过。
- 10 项测试通过：离线拒绝生成、回环 HTTP 合同、未就绪模型、输入边界、响应与任务验证、超时/取消/响应中断、真实 Cordis 注册/默认配置/卸载。
- 官方 `--dump-config` 能解析插件 bundle 与本机覆盖层。
- 本机官方 Web 页面已启动并通过 Chrome 自动化加载检查；插件管理页显示 `dsh-calculet-npu v0.1.0`，其组件 `calculet-npu` 为“运行中”。界面聊天尚未接入模型。

截图、启动日志、认证地址、配置状态和依赖保存在 `.local/` 或 `node_modules/`，被 `.gitignore` 排除。不要将这些目录加入发布提交。

## 下一位协作者从哪里继续

1. 先读 [进度审查](progress-review-20261114.md)，确认哪项模型有完整任务验收记录。
2. 和模型团队按 [接口草案](backend-contract.md) 对接一个实际能力；未就绪模型保留 `testing`。
3. 用户自行配置可用的规划模型后，验证一句自然语言需求触发完整工具调用和真实产物。
4. 选定一项真实用户任务，再实现反馈、改进指标和回退。当前没有自进化能力或 Built for Better 验收结果。
