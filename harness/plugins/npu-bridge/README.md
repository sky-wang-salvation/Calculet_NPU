# Calculet NPU bridge for DeepSeek Harness

原生插件将受控 NPU 服务的生成与部署能力暴露为 Harness 工具。固定宿主为 `@deepseek-ai/dsh@0.2.2-rc.3`，包名 `dsh-calculet-npu`。采用官方 bundle、配置 schema、`defineTool` 和 Cordis 注册，不修改上游 Agent 循环。

## 工具

| 工具 | 行为 |
| --- | --- |
| `npu_status` | 未配置时返回未接入；接入后读取能力声明，不代表实际推理完成 |
| `npu_list_models` | 列出后端公布的能力，未配置时为空 |
| `npu_generate` | 向声明就绪的模型提交支持的生成任务 |
| `npu_get_job` | 查询生成任务状态和产物 |
| `npu_wait_job` | 有时限地查询生成任务，不取消或重复提交 |
| `npu_plan_deployment` | 根据明确参数形成固定 TaskSpec，取得计划及阻塞项，不启动模型 |
| `npu_apply_deployment` | 提交原计划ID、摘要及稳定幂等键；服务独立核对权限与绑定 |
| `npu_get_deployment_job` | 查询部署阶段、证据与错误，区分失败、阻塞和待核对 |
| `npu_wait_deployment_job` | 限时等待部署任务；到时保留ID，不重新部署 |

## 部署支持范围

第一版只支持 `sd35-medium` / `sd35-qproj-hybrid-smoke-v1`：256×256、batch 1、4 steps、guidance 1、无T5、每步首层Q投影在NPU。其余声明模块在CPU；`coreMigrationComplete=false`，验收等级为 `hybrid-smoke`。

规划工具默认 seed 为20261115；prompt和seed通过结构化参数传递，prompt按服务合同去掉首尾空白。它会把完整spec返回供核对，不会把未支持分辨率、全NPU要求、额外T5或未知字段静默忽略。当前不支持任意模型安装、自动算子迁移、训练或正式画质发布。

计划必须在服务端重新核对之后才能执行。工具中的 `ready` 不代替设备授权；客户端也不能通过一个布尔字段提升权限。收到结果未知或 `reconciling` 时，应核对原任务，不另造幂等键盲目重跑。

详见[部署接口合同](../../docs/deployment-integration-contract.md)和[第五题验收合同](../../docs/deployment-acceptance.md)。

## 配置与结果

`backendURL` 留空时九项工具可以注册，但不会自动使用演示或云端后端。`apiToken` 通过宿主 secret 配置保存，不写入仓库。默认单次 HTTP 请求超时15秒；长任务需立即返回任务句柄，之后轮询。

客户端检查协议版本、任务/计划身份、固定范围、产物同源地址和等待期间的一致性。成功部署要求输出PNG、JSON证据索引及结构化验收状态；这些检查不构成独立硅片执行认证，真机结果仍需原始证据。

展示会标明 `simulation`、`hardware`（服务/适配器声明，需核对证据）或 `not_run`。数值 `METRICS_ONLY` 与正式验收通过不能混用。PNG附Markdown图片引用；部署服务提供短期、仅绑定单个产物的签名URL，不将API令牌放入链接。普通GET读取已由跨层测试覆盖，服务重启或链接过期后需重新查询任务获取新链接。官方聊天中的实际图片呈现仍需单独验证。

## 原有固定图片联调台

`npm run harness:test-service` 启动的仍是旧生成协议夹具，打开 `http://127.0.0.1:3081/` 可测试原五项生成链路工具。它只提供TEST图片和预设成功/失败/慢任务，始终为simulation，任务只在内存中。它不实现新增部署端点，也不是模型后端。

## 检查

在仓库 `harness/` 下运行：

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

插件测试包含部署DSL、响应一致性、异步跟踪及九项原生工具注册；原联调测试读取固定PNG，不执行模型或NPU。官方聊天的自然语言选择还需实际配置获准规划模型并验证，不能以直接调用注册工具代替。

[宿主安装与profile](../../docs/local-development.md) · [生成后端合同](../../docs/backend-contract.md) · [历史Windows联调](../../docs/windows-integration.md)
