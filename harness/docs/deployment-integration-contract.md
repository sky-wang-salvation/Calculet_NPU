# 部署闭环的首版集成合同

本合同用于当前 SDK 已配置前提下的部署工作流。`calculet.npu/v1` 的生成接口保持兼容；新增部署接口为 `calculet.deploy/v1`。本文件描述目标实现，不是已完成真机验收的声明。

## 1. 适用范围和执行边界

- 首个模型为 `sd35-medium`，固定能力档案为 `sd35-qproj-hybrid-smoke-v1`。
- 只支持已记录的 256×256、batch=1、4 steps、guidanceScale=1、关闭 T5 的 HYBRID 配置。每步首层 Q 投影在 NPU，其余已声明模块在 CPU；`coreMigrationComplete=false`。
- SDK、驱动、权重许可和设备使用授权由操作者提供，不自动安装厂商 SDK，不复位设备，不停止其他服务。
- 真实模型适配器必须由操作者配置且绑定摘要。缺少入口、权重/组件清单、批准的使用窗口或必要资源时返回阻塞，不生成测试图片冒充成功。
- 测试使用单独、明确标注 `simulation` 的受控适配器。测试不代表模型或 NPU 运行。
- 第一版的验收等级只有 `hybrid-smoke`。它不等同于正式数值验收、图像质量合格或完整核心迁移；指标与验收状态分别返回。

## 2. TaskSpec

`POST /v1/deployment-plans` 的请求为 `{ "spec": TaskSpec }`。

```json
{
  "schemaVersion": "calculet.task/v1",
  "intent": "deploy-and-validate",
  "modelId": "sd35-medium",
  "profileId": "sd35-qproj-hybrid-smoke-v1",
  "parameters": {
    "prompt": "A red apple on a wooden table, soft natural window light, realistic photograph",
    "seed": 20261115,
    "width": 256,
    "height": 256,
    "batch": 1,
    "steps": 4,
    "guidanceScale": 1,
    "enableT5": false
  },
  "constraints": {
    "executionMode": "hybrid",
    "requireFullNpu": false,
    "allowNpuComputeFallback": false
  },
  "acceptance": { "level": "hybrid-smoke" }
}
```

要求：拒绝未知字段、错误类型和不支持的组合；prompt 为 1–8000 字符的非空文本，seed 是 uint32。接口接收完整 TaskSpec，插件负责从原生工具参数明确填入已公开的默认值；服务端仍独立校验，不信任客户端。所有硬约束变化都必须产生新的计划，不得执行时静默降级。

## 3. 部署接口与响应

### 3.1 创建计划

`POST /v1/deployment-plans` 只做输入、配置和文件身份检查，不启动模型进程。回应：

```json
{
  "protocolVersion": "calculet.deploy/v1",
  "id": "plan-opaque-id",
  "status": "blocked",
  "planDigest": "64-lowercase-hex-sha256",
  "spec": {},
  "steps": [
    "preflight",
    "prepare",
    "run_validation",
    "collect_evidence",
    "register_capability"
  ],
  "blockers": [{ "code": "ADAPTER_NOT_CONFIGURED", "message": "Configure an approved adapter first." }],
  "expiresAt": "ISO-8601-time",
  "scope": {
    "executionMode": "hybrid",
    "npuModules": ["transformer_blocks[0].attn.to_q"],
    "coreMigrationComplete": false,
    "validationLevel": "hybrid-smoke"
  }
}
```

示例中的 `spec` 由服务返回规范化后的完整 TaskSpec；`planDigest` 实际必须为合法 SHA-256，不接受占位文本。`status` 为 `ready` 或 `blocked`。计划摘要覆盖规范化 spec、固定配方版本和关键运行绑定；凭据不包含在可展示内容中。到执行时再次检查过期、身份与资源授权。

### 3.2 应用计划

`POST /v1/deployment-jobs`：

```json
{
  "planId": "plan-opaque-id",
  "planDigest": "64-lowercase-hex-sha256",
  "idempotencyKey": "caller-generated-stable-key"
}
```

服务应立即返回部署作业（通常 HTTP 202）。同键同请求返回同一作业；同键不同请求返回冲突；不要在模型生成中途占住 HTTP 请求。服务端独立验证授权，不能凭客户端声称同意而增加权限。

### 3.3 查询部署作业

`GET /v1/deployment-jobs/{jobId}` 与创建作业返回同一结构：

```json
{
  "protocolVersion": "calculet.deploy/v1",
  "id": "deployment-job-id",
  "planId": "plan-opaque-id",
  "profileId": "sd35-qproj-hybrid-smoke-v1",
  "status": "queued",
  "phase": "queued",
  "executionKind": "not_run",
  "executionMode": "hybrid",
  "coreMigrationComplete": false,
  "validationLevel": "hybrid-smoke",
  "artifacts": [],
  "createdAt": "ISO-8601-time",
  "updatedAt": "ISO-8601-time"
}
```

- `status` 为 `queued | running | succeeded | failed | blocked | reconciling`。
- `phase` 为 `queued | preflight | prepare | run_validation | collect_evidence | register_capability | complete | failed | blocked | reconciling`。
- `executionKind` 为 `not_run | simulation | hardware`。
- `artifacts` 使用已有 `{id, uri, mimeType}` 格式，同源受控 URL。
- `failed | blocked | reconciling` 必须带 `error: {code, message}`。
- 成功必须有实际验收输出和证据索引，不能仅由进程 exit=0 或存在图片决定。
- 可选 `evidence` 为结构化摘要，具体字段见 `deployment/adapter-contract.md`：包含 `source=validated_adapter_report`、`level=hybrid-smoke`、`deviceExecution`、`numericValidation`、`imageValidation` 三个检查对象，以及证据索引产物 ID。三个检查对象都有 `status`，设备对象另有请求/回退计数和 trace 引用，图片对象另有尺寸与产物引用。它是适配器报告经服务校验后的结果，不是独立硬件认证。
- 等待取消只结束轮询，不承诺取消后台计算。首版不提供设备取消接口。

## 4. 兼容已有生成工具

真实服务还应实现现有 `GET /v1/capabilities`、`POST /v1/jobs` 和 `GET /v1/jobs/{id}`。只有成功登记的当前能力档案才发布为可调用，`modelId` 使用 `sd35-qproj-hybrid-smoke-v1`，`task` 只允许 `text-to-image`。

- 生成配置固定为该档案，只开放现有接口的 prompt 和 seed。未验证分辨率等不可经 prompt 偷渡为执行参数。
- 生成调用使用已绑定的适配器，不重做无关安装，不用 fixture 回退。
- `hardware` 与 `simulation` 不能互换；测试能力不能混入真实设备成绩。
- 全局 capability 的 executionKind 与任务一致。能力就绪必须伴随使用范围说明，不宣称正式画质或整模型精度已验收。

## 5. 运行服务和适配器边界

实现建议：Node 24 ESM、原生 HTTP、无新数据库依赖的原子文件存储，单进程串行队列。存储目录和资源锁属于运行配置；计划、作业和幂等记录落盘。重启时遗留 queued/running 作业进入 `reconciling`，不盲目重启设备计算。任务数据与凭据放 `.local/`，不提交。

适配器由操作者配置固定 executable、固定脚本、脚本 SHA-256、模型目录、允许的工作目录与执行预算。禁止客户端选择可执行文件、脚本路径或任意 shell；使用参数数组且 `shell:false`。计划与执行之间重验关键身份。

调用边界为独立适配器命令：固定命令后追加 `--request <job/request.json> --result <job/result.json>`。具体请求/结果细节由 `deployment/adapter-contract.md` 记录，并在实施后由主控与模型接入会话对齐；不得先假设私有模型程序已支持此参数。

最低结果合同：固定 schemaVersion、请求/任务身份、执行模式、CPU/NPU 范围、数值与图片检查状态，以及位于该任务目录内的产物相对路径和 SHA-256。服务拒绝越界路径、符号链接逃逸、缺失文件、摘要不符、模式不符和不完整的成功证据。

硬件配置必须有明确的操作者授权与未过期使用窗口；这只是执行门禁，不等于自动获得共享设备排程权。支持合作锁也不能证明不遵守锁的其他进程不存在。不允许通过缺少锁文件自动推断设备空闲。

服务合作锁与 SDK 板锁属于不同层。已交接的 Q-only worker 在板端获取统一板锁，每次 Q 请求持有到设备关闭；控制端的服务合作锁不能替代它。服务若在同一板端主机预先持有同一实际锁，再启动需要获取该锁的 worker，会发生重复加锁冲突。这种拓扑必须在接入时明确拒绝或通过获批准的独立协调方案解决，不能删锁、改用 external 或换一个不受共享约束的板锁路径。

## 6. 文件所有权与分工

- 部署服务会话：只写 `harness/deployment/**`，包括契约、服务、配方、示例配置、独立测试及适配器合同。
- 主控会话：维护 `harness/plugins/npu-bridge/**` 的部署客户端、工具与测试，根 `harness/package.json` 脚本，相关公开说明和最终联调。
- 模型会话：整理已有实际执行代码及模型专用适配入口，不修改上述两组文件，不披露私有 SDK 或凭据。

所有会话不提交、不推送、不切换共享分支，不连接真实设备。模拟测试必须如实标注；真机验证等待已有授权条件和交接材料齐备。
