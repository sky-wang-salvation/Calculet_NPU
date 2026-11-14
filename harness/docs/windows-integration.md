# Windows 插件运行与联调

本轮基于 `d3a7422` 开发，发布前对齐远端 `dc4f4ad` 的 `harness/` 目录整理。新增有时限的任务等待、可读的产物结果和本机测试联调台。
测试服务是协议夹具，不执行模型、云端生成 API 或 NPU。正式模型后端仍待团队接入。

## 开发位置与环境

本电脑有效仓库位于 `E:\Codex\Calculet_NPU\.review-source\harness`，命令在该目录运行。
外层目录留有此前未完成克隆，不作为本轮运行目录。
本轮使用系统 Node 24.14.0、npm 11.9.0，Harness 固定 `0.2.2-rc.3`。
原来的 Mac `.command` 启动器不适用于 Windows；使用下面的 npm 命令。

## 安装与检查

```powershell
Set-Location E:\Codex\Calculet_NPU\.review-source\harness
npm ci --cache .local/npm-cache --no-audit --no-fund
npm run build
npm run typecheck
npm test
npm run test:integration
```

## 启动测试服务

终端一运行：

```powershell
npm run harness:test-service
```

打开 `http://127.0.0.1:3081/`。该进程只监听本机。
端口被占用时不能再启动第二份；如需改端口，设置 `CALCULET_TEST_PORT`，并同步修改后端配置。

页面通过原生 Cordis 注册的工具调用，并非另外实现一套客户端生成逻辑。
可验证：

1. 普通任务：排队、运行、成功，显示带 TEST 字样的固定图片，打开和下载。
2. 失败任务：显示 `FIXTURE_FAILURE`，没有成功产物。
3. 慢任务：5 秒跟踪到时后保留 ID，继续跟踪可拿到终态。
4. 停止等待：后台继续执行，稍后使用原 ID 恢复。
5. 刷新页面：保留最后任务 ID，可手动继续查询。

任务只存内存，重启服务会清空；保存任务最多 100 个，提交时清理超过一小时的记录。
联调台只允许测试模式。它有图片预览、视频元素支持，但测试服务本轮仅提供 PNG，不声称完成视频端到端验证。

## 官方 Harness 宿主

仅首次初始化和安装时执行：

```powershell
$env:DSH_HOME = Join-Path $PWD '.local/dsh-home'
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile calculet --from-default-profile web --dump-config
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile calculet add ./plugins/npu-bridge
```

`--from-default-profile` 重复执行会重置配置。当前本机已完成首次初始化和安装，日常不用重复执行。

本机 `.local/npu.patch.yml` 已指向 `http://127.0.0.1:3081/`。日后切换真实服务时修改此本地文件；服务地址不是 NPU SDK 设备地址。

终端二运行：

```powershell
npm run harness:config
npm run harness
```

使用终端打印的本地认证链接打开官方页面；认证地址不要公开提交。
插件管理页应显示 `dsh-calculet-npu` 已启用、组件 `calculet-npu` 运行中。
官方聊天的自然语言规划需要自行配置模型账号。本轮无须账号的联调台直接验证原生工具，不代表已经验证 LLM 的工具选择行为。

`Ctrl+C` 分别停止自己启动的服务。停止前确保没有仍需保留的内存测试任务。

## 交给模型团队的最小要求

按 `backend-contract.md` 实现能力、提交、查询和产物访问。
先接一项完整验收的模型能力。参数、分辨率、步数、帧数、上传、取消、幂等提交与正式鉴权仍需按真实模型确定；本轮不臆造这些能力。

代码入口：`plugins/npu-bridge/src/client.ts` 的 `waitJob`、`index.ts` 的工具注册、`presentation.ts` 的展示文本，以及 `scripts/test-service.mjs` 的测试服务。
