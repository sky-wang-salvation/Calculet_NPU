# DSH-SN4CK — DeepSeek Harness × Calculet NPU

## Release 插件安装

包名 `dsh-sn4ck`，品牌 **DSH-SN4CK**，版本 `0.2.0`。已有 DSH 时直接安装预编译 Release 资产，不需要运行本目录的源码构建命令：

```bash
dsh plugin --profile web add https://github.com/sky-wang-salvation/Calculet_NPU/releases/download/v0.2.0/dsh-sn4ck-0.2.0.tgz --ignore-scripts
```

```bash
dsh --profile web --dump-config
```

应看到 `# == dsh-sn4ck`、`id: sn4ck`、`name: dsh-sn4ck`。从旧名称升级时，在目标 profile 先移除 `dsh-calculet-npu`，并把本地私有覆盖层组件 ID 改为 `sn4ck`；不要重置已有 profile 或泄露令牌。

[Release 下载](https://github.com/sky-wang-salvation/Calculet_NPU/releases/tag/v0.2.0) · [完整安装与升级说明](docs/plugin-installation.md) · [功能、配置与安全](plugins/npu-bridge/README.md)

本轮仅发布 GitHub Release，未发布 npm；源码位于子目录，不使用仓库根的 `github:owner/repo#tag` 作为安装入口。MIT 仅覆盖原创插件与随包原创通用代码，第三方资料和 SDK 权利不变。

更新日期：2026-11-15（Asia/Shanghai）。参赛方向为原粒第五题的开发工具：在 SDK 已配置、材料与设备已获授权的前提下，将自然语言部署目标组织为任务契约、受控计划、执行与验收。

**当前首个能力范围是 SD3.5 首层 Q 投影 HYBRID 烟雾配置，不是全模型 NPU、任意模型迁移或正式画质验收。已有模型运行记录、插件离线测试与本轮真实联调必须分开看。**

## 工作流

```text
用户部署目标
  → npu_plan_deployment：固定 TaskSpec、检查支持范围、得到 ready/blocked 计划
  → npu_apply_deployment：以原计划摘要和稳定幂等键提交，服务独立核对授权
  → npu_get_deployment_job / npu_wait_deployment_job：阶段、证据与可恢复查询
  → 验收后登记能力
  → npu_list_models / npu_generate：使用已登记的固定能力
  → npu_get_job / npu_wait_job：交付实际产物和运行范围
```

规划不会启动模型，SDK 已配置不等于有权占用共享设备。服务和适配器缺失、计划过期、未授权或要求超出支持范围时应明确阻塞，不自动换 mock、改成 CPU 或放宽任务。

## 目录与阅读入口

| 入口 | 用途 |
| --- | --- |
| [插件源码与工具](plugins/npu-bridge/README.md) | 五项生成工具、四项部署工具、限制和测试方法 |
| [部署集成合同](docs/deployment-integration-contract.md) | TaskSpec、计划、作业、适配器边界与分工 |
| [第五题验收合同](docs/deployment-acceptance.md) | 本地实现、真实设备贡献、失败用例、复现和提交材料 |
| [生成后端合同](docs/backend-contract.md) | 兼容保留的 `calculet.npu/v1` 能力/生成/查询接口 |
| [Windows 历史联调](docs/windows-integration.md) | 原有五项生成工具的固定 TEST 图片联调台 |
| [宿主安装与 profile](docs/local-development.md) | 固定宿主版本、官方插件安装和本地配置 |
| [历史进度 schedule_01](docs/schedule_01.md) | 上一阶段22项测试和Windows宿主记录；不覆盖本轮状态 |
| [模型部署经验](../experiment/SD3.5_Medium/model_deploy_experience.md) | 真实 Q 投影与 HYBRID 生图案例、环境和证据边界 |

项目依赖固定为 `@deepseek-ai/dsh@0.2.2-rc.3`，使用官方 `defineTool`、Cordis 注册和 bundle/profile，不修改上游 Agent 循环。命令均在 `harness/` 下执行；依赖、配置、凭据与运行数据放 `node_modules/` 或 `.local/`，不提交。

## 源码开发与自动化检查

前提是 Node `>=24.9.0 <25` 和 npm。首次安装依赖时避免自动运行未知生命周期脚本；官方宿主的 spawn-helper 如需使用，应按[本机开发说明](docs/local-development.md)单独审阅和准备。

```bash
npm ci --ignore-scripts --cache .local/npm-cache
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

`npm test` 覆盖插件解析、传输、部署契约、等待和原生工具注册；`test:integration` 仍是原有固定图片夹具。测试中 `simulation` 只表示协议/适配器测试，不执行生成模型，也不能计入 NPU 成绩。

## 当前事实与边界

| 工作线 | 状态 |
| --- | --- |
| 原生插件 | 九项工具已实现：原五项生成工具加四项部署工具；编译、类型检查和插件/原联调回归已验证 |
| 部署合同 | 支持固定 SD3.5 HYBRID TaskSpec；拒绝未知模型、未支持参数和全NPU要求，不静默降级 |
| 模型历史实测 | 经验文档记录真实 NPU Q 投影及混合生成；其余主要模型计算在 CPU |
| 完整真实接入 | 需要团队实际程序、组件/环境绑定和服务联调证据；不能用历史模型结果替代本轮验证 |
| 自然语言规划 | 工具已注册；具体规划模型、运行位置和实际工具选择需单独验证 |
| 数值与画质 | 历史子图有误差指标，正式容差未批准；低步数预览不是正式画质通过 |
| 反馈学习 / RSI | 未实现、未验证，不作为第五题默认必选项 |

## 公开材料和运行限制

- 不公开未获许可的 SDK、权重、设备身份、认证链接或凭据。
- 不能用外部生成服务替代赛题的本地实现；说明规划、执行、计算分别在哪里发生。
- 不将非公开厂商资料发送外部 AI；使用和展示材料按赛事授权处理。
- 不重配厂商 venv，不停止其他队伍服务，不擅自刷写或复位设备。
- 独立工程师按获准方式复现、真实 NPU 贡献与完整任务验收，才是闭环完成依据。

旧讨论和旧进度用于保留决策演变，不作为当前能力清单。历史 H3 快照保留原文，不能与后续 SD3.5 结果混写。
