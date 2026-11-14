# 受控模型适配器文件合同（v1）

此合同是团队部署服务与模型专用入口之间的本地文件协议，不是厂商 SDK API。服务不包含私有 SDK 调用，不通过远程生成服务替代本地计算。`test/fixtures/` 的程序只用于明确标注的 simulation 协议测试。

## 1. 进程入口及信任边界

操作者配置固定绝对路径的 executable、script、二者 SHA-256、固定 args、cwd、modelRoot、组件文件清单及摘要、执行环境、timeoutMs。服务使用 `spawn(executable, [script, ...args, '--request', requestPath, '--result', resultPath], {shell:false})`，客户端不能选择这些值。

具体入口若仅支持固定输入，操作者可配置 `adapter.inputPolicy={prompt,seed}`；该可选严格字段进入计划绑定，服务对不匹配的新执行失败关闭。省略字段保持通用行为，不证明实际模型支持任意输入。此配置不增加 request/result 字段，仍通过完整规范化 spec 传递输入；适配器必须校验自身真实支持的 prompt/seed，不能仅回显请求。真实基线输入和受限交接材料由操作者保存在私有运行目录，不纳入公开包。

每次执行由服务创建独立任务目录及 `artifacts/` 子目录，先原子写入 request.json，再调用入口。结果必须先写同目录临时文件再原子重命名为 result.json。stdout/stderr 只进入受限本地日志，不解析为控制协议。进程必须在期限内退出 0，且完整结果通过校验，才可能成功。

适配器不得 daemonize、派生脱离受控进程树的工作进程、修改 request.json、修改 SDK/驱动、复位设备或中止其他使用者。受控子进程不是 OS 沙箱；固定脚本及其依赖仍须由操作者审计，目录必须防止不可信同用户进程修改。清单应覆盖所有可影响执行的模型组件与代码依赖；服务只能校验已声明文件，不能推断清单完整性。

## 2. 请求文件

```json
{
  "schemaVersion": "calculet.adapter-request/v1",
  "requestId": "request-uuid",
  "jobId": "deployment-uuid",
  "jobKind": "deployment",
  "planId": "plan-uuid",
  "planDigest": "64-lowercase-hex-sha256",
  "recipeVersion": "sd35-qproj-hybrid-smoke-v1.0",
  "profileId": "sd35-qproj-hybrid-smoke-v1",
  "executionKind": "hardware",
  "spec": { "schemaVersion": "calculet.task/v1" },
  "scope": {
    "executionMode": "hybrid",
    "npuModules": ["transformer_blocks[0].attn.to_q"],
    "cpuModules": ["text_encoders", "transformer_except_npu_modules", "scheduler", "vae_decoder"],
    "coreMigrationComplete": false,
    "validationLevel": "hybrid-smoke"
  },
  "paths": {
    "jobDir": "/absolute/private/jobs/deployment-uuid",
    "artifactsDir": "/absolute/private/jobs/deployment-uuid/artifacts",
    "modelRoot": "/absolute/approved/model",
    "components": [{"path": "manifest.json", "sha256": "64-lowercase-hex-sha256"}],
    "controllerLockPath": "/absolute/shared-lock-directory/controller.lock"
  },
  "limits": {"timeoutMs": 120000, "deadlineAt": "2026-11-15T12:00:00.000Z"},
  "authorization": {
    "authorized": true,
    "operatorId": "approved-operator-id",
    "authorizationId": "approved-window-id",
    "resourceId": "approved-resource-id",
    "windowStart": "2026-11-15T11:55:00.000Z",
    "windowEnd": "2026-11-15T12:10:00.000Z",
    "sharedDeviceAcknowledged": true
  },
  "requestDigest": "64-lowercase-hex-sha256"
}
```

示例 spec 为节略，实际是完整、规范化 TaskSpec；固定参数为 256×256、batch=1、4 steps、guidanceScale=1、enableT5=false。`jobKind` 是 `deployment` 或 `generation`；后者仍用同一固定配方，只改变 prompt/seed。requestId 每次唯一。

`paths.controllerLockPath` 是所有请求必填的私有协议字段：hardware 必须为服务配置 `resourceLockPath` 的已规范化绝对路径，simulation 必须为 JSON null。服务使用已参与计划绑定、并在执行前重新检查的配置产生该字段，不接受 TaskSpec 或 HTTP 客户端自报路径；requestDigest 也覆盖该字段。硬件缺少该路径时不能构造可执行请求。该路径属于控制端文件系统命名空间，不表示远端板端 SDK 锁路径，也不能仅凭字符串不等就推断两者独立。

服务合作锁只串行协调控制端任务，不能替代实际板端 worker 的统一 SDK 板锁。板端 worker 仍按批准实现获取板锁并在设备关闭时释放。若服务与 worker 在同一板端主机且涉及同一实际锁，桥接必须在模型、SDK 或 worker 启动前保守拒绝重复持有拓扑；缺字段、身份或拓扑无法独立核对时不能假定不存在重叠。路径别名、同主机关系与锁身份须按操作者批准的拓扑配置核验，不能靠客户端声明；另一主机的相同路径字符串也不是同一锁的证明。

桥接不得通过删除已有锁、把板锁换到不受共享约束的路径、改用 external 或关闭 SDK 锁来绕过冲突。其他拓扑需要另行批准的独立协调方案；本文件协议扩展本身不授予板端使用权，也不证明设备空闲。

requestDigest 是删除 requestDigest 字段后，以 UTF-8 编码的递归键排序紧凑 JSON 的 SHA-256。数组保序，JSON 字符串采用 JSON.stringify 规则，无换行。适配器可以原样回传该摘要；如自行重算，非 ASCII 字符不能改为不同转义形式。服务还会重读 request.json，拒绝运行期间被修改的请求。

hardware 的 authorization 为配置中已校验的 operatorAuthorization 对象；simulation 必须为 null。上述标识、时间和路径只是格式示例，不是设备授权。它只记录执行门禁，不是设备空闲或硬件认证证明。硬件入口还必须遵守合作锁及实际操作者协调安排。

## 3. 成功结果（所有字段必填）

```json
{
  "schemaVersion": "calculet.adapter-result/v1",
  "requestId": "request-uuid",
  "jobId": "deployment-uuid",
  "requestDigest": "64-lowercase-hex-sha256",
  "profileId": "sd35-qproj-hybrid-smoke-v1",
  "status": "succeeded",
  "executionKind": "hardware",
  "executionMode": "hybrid",
  "scope": {
    "npuModules": ["transformer_blocks[0].attn.to_q"],
    "cpuModules": ["text_encoders", "transformer_except_npu_modules", "scheduler", "vae_decoder"],
    "coreMigrationComplete": false
  },
  "validation": {
    "level": "hybrid-smoke",
    "deviceExecution": {"status": "passed", "npuCallCount": 4, "npuFallbackCount": 0, "traceArtifactId": "trace"},
    "numericValidation": {"status": "not_run"},
    "imageValidation": {"status": "passed", "artifactId": "image", "width": 256, "height": 256}
  },
  "artifacts": [
    {"id": "image", "role": "image", "path": "artifacts/image.png", "mimeType": "image/png", "sha256": "64-lowercase-hex-sha256"},
    {"id": "trace", "role": "device_trace", "path": "artifacts/device-trace.json", "mimeType": "application/json", "sha256": "64-lowercase-hex-sha256"},
    {"id": "evidence", "role": "evidence_index", "path": "artifacts/evidence-index.json", "mimeType": "application/json", "sha256": "64-lowercase-hex-sha256"}
  ]
}
```

- 未知字段、错误类型、遗漏字段、不同 requestId/jobId/requestDigest/profileId、不同模式或 CPU/NPU 范围均拒绝。simulation 的 deviceExecution.status 必须为 `simulated`，executionKind 必须为 `simulation`；不得填 `passed`/`hardware`。simulation 的 npuCallCount=4 只代表四个虚拟步骤，实际 NPU 调用数为零，不能用于硬件成绩。
- hardware 的 deviceExecution.status 必须为 `passed`，报告每个采样步的 Q 投影执行，共 4 次，npuFallbackCount=0。trace 必须是非空 UTF-8 text/plain 或合法非空 JSON 对象/数组；原始 SDK trace 内容由适配器负责，服务不声称能独立认证其真实性。
- numericValidation.status 可以为 `not_run` 或 `passed`；`passed` 时必须另有 metricsArtifactId，指向 role=metrics、mimeType=application/json 的非空对象。`failed` 拒绝成功。hybrid-smoke 不要求正式数值验收，也不等于画质通过。
- imageValidation 只表示 PNG 文件可解码且尺寸正确，不表示画质合格。v1 要求非隔行 8-bit RGB/RGBA PNG；服务检查签名、块顺序/CRC、IHDR、解压长度、扫描行过滤器与 256×256 尺寸。
- 每项产物 id、role、path 唯一；必须恰有 image、device_trace、evidence_index，最多另有一份 metrics。路径必须为 `artifacts/` 下使用正斜杠的相对路径，不得包含 `..`、反斜杠、驱动器、绝对路径、Windows 保留文件名、尾随点、符号链接或多硬链接文件。所有文件都必须在对应任务目录内部并匹配 SHA-256。
- 失败时应非零退出，不写成功结果。服务不会把任何 stdout 文本或缺失结果转换为成功，也不自动重试硬件计算。

## 4. 证据索引文件

```json
{
  "schemaVersion": "calculet.evidence-index/v1",
  "jobId": "deployment-uuid",
  "requestDigest": "64-lowercase-hex-sha256",
  "executionKind": "hardware",
  "executionMode": "hybrid",
  "artifacts": [
    {"id": "image", "role": "image", "path": "artifacts/image.png", "mimeType": "image/png", "sha256": "64-lowercase-hex-sha256"},
    {"id": "trace", "role": "device_trace", "path": "artifacts/device-trace.json", "mimeType": "application/json", "sha256": "64-lowercase-hex-sha256"}
  ]
}
```

artifacts 必须与 result.artifacts 删除 evidence_index 项后的数组完全一致（包括次序），避免索引自引用。服务返回的 evidence 摘要标明 `source=validated_adapter_report`，deviceExecution/numericValidation/imageValidation 保留包含 status 的结构化对象，只代表适配器报告与受控文件一致；不可当作独立硬件认证。

适配器只提供受控相对文件路径，不得自行生成服务 URL 或接收服务签名私钥。公开任务响应的 artifacts URI 由服务生成短期单产物签名 URL；这不改变 request/result 文件合同。

## 5. 执行和恢复

服务串行执行任务；计划和执行时都校验身份，过期、变化或未授权均阻塞。hardware 必须具有完整 operatorAuthorization（authorized=true、operatorId、authorizationId、resourceId、windowStart、windowEnd、sharedDeviceAcknowledged=true）及固定绝对路径 resourceLockPath；剩余窗口必须覆盖完整 timeoutMs。缺失锁文件不等于设备空闲。

服务使用独占创建合作锁，不会自动删除已有设备锁。真实硬件执行后只有完整成功结果才自动释放锁；非零退出、结果错误、超时或服务中断均保留锁，要求操作者确认硬件状态后手工处理。正常退出前未曾启动模型的门禁失败可以释放本服务持有的锁。

遗留 queued/running 任务在重启后进入 reconciling，不自动重新执行；同一幂等键仍返回原任务。服务超时只限制受控进程树，不能保证设备内核已经停止，因此保留硬件锁。重新执行需要操作者处理残留工作、使用新计划和新幂等键。

本合同不假定既有模型脚本已经支持参数；模型接入会话需提供遵守合同的薄适配入口，再由操作者批准路径、摘要、组件清单与设备窗口。
