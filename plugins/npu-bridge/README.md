# Calculet NPU bridge for DeepSeek Harness

这是可执行的第一版 Harness 插件：把后续 NPU 服务公布的生成能力变成 Agent 工具。已完成本机安装、编译、协议测试和官方 Cordis 工具注册验证；NPU 模型服务仍在独立测试，本插件没有执行模型推理。

固定宿主为 `@deepseek-ai/dsh@0.2.2-rc.3`，插件名为 `dsh-calculet-npu`。使用官方 bundle、配置 schema、`defineTool` 和 `ctx.tools.register`，没有改动上游 Agent 循环。

| 工具 | 行为 |
| --- | --- |
| `npu_status` | 未配置时返回 `not_configured`；接入后读取服务能力声明 |
| `npu_list_models` | 只列出后端公布的模型；未配置时返回空列表 |
| `npu_generate` | 仅向声明就绪的模型提交支持的任务 |
| `npu_get_job` | 查询后端任务和产物引用 |

预留文生图、文生视频、图生视频三种协议任务；**这不表示现在已有三种可用模型**。图生视频要求后端预先提供输入产物 ID，当前没有上传工具。训练、模型安装、作业取消、自进化和专用图片展示卡尚未实现。

配置 `backendURL` 留空即可验证加载；无需 NPU 服务，也不会退回其他生成服务。API Token 通过宿主 secret 配置保存，不写入仓库。默认单次 HTTP 请求超时 15 秒；长生成任务应立即返回任务句柄，随后轮询。

- [本机安装与验证](../../docs/harness/local-development.md)
- [后端接口草案](../../docs/harness/backend-contract.md)
- [GitHub 进度审查](../../docs/harness/progress-review-20261114.md)

从仓库根目录运行：

```bash
npm ci --cache .local/npm-cache
npm run build
npm run typecheck
npm test
```

HTTP 测试只使用回环地址上的测试夹具，不执行或模拟任何生成模型。测试返回的 `simulation` 标签只用于验证协议字段，不能计入 NPU 成绩。
