# 受控部署服务：SD3.5 Medium HYBRID smoke

本目录提供可审查的本地执行层：完整 TaskSpec 校验、绑定执行计划、持久异步队列、受控模型子进程协议与鉴权产物读取。它不是厂商 SDK，不自动安装模型、不联系远程生成服务，也不提供设备复位或取消功能。

**默认不能执行真机。** `config.example.json` 没有适配器、设备授权或合作锁。`test/fixtures/simulation-adapter.mjs` 只生成标有 SIMULATION 的合成测试 PNG，不能证明模型或 NPU 已执行。实际模型入口必须由模型团队交付，并经操作者批准；服务不会自动选用 fixture。

## 运行范围

| 项目 | v1 固定值 |
| --- | --- |
| 模型 / 能力档案 | sd35-medium / sd35-qproj-hybrid-smoke-v1 |
| 图片 / batch | 256×256 / 1 |
| 采样步数 / guidanceScale | 4 / 1 |
| T5 | 关闭 |
| NPU 范围 | transformer_blocks[0].attn.to_q，每步一次 |
| 其余模块 | 声明的文本编码器、其他 Transformer、scheduler、VAE decoder 在 CPU |
| 验收级别 | hybrid-smoke；coreMigrationComplete=false |

所有硬约束在服务端独立校验，未知字段、缺项、类型错误、不支持的组合均拒绝；prompt 只做文本传递，不能变成命令行参数。prompt 原始长度须为 1–8000 个 JavaScript 字符单元，规范化去掉两端空白，不能是空白或含 NUL；seed 是 uint32。

完整 HTTP 合同见 [部署集成合同](../docs/deployment-integration-contract.md)；模型入口精确文件合同见 [adapter-contract.md](adapter-contract.md)。

## 1. 从零准备和离线自检

前置条件：本仓库代码，以及可执行的 **Node.js 24**。本目录仅使用 Node 内置模块，不需要 npm install、Python、GPU、NPU、模型权重或私有 SDK。Windows 使用 Git Bash，Linux 使用 Bash；以下命令均从本仓库的 `Calculet_NPU_integration/harness` 目录执行，而不是另一份原始主仓库。

```bash
node --version
```

预期主版本是 24；没有 Node 时先从组织批准的发行渠道或 [Node.js 官网](https://nodejs.org/) 安装，再重新打开终端。无需为离线测试下载 SD3.5 权重。

```bash
node --test deployment/test/*.test.mjs
```

测试在 `deployment/test/.local/test-*` 创建隔离目录和回环 HTTP 服务，正常结束后清理；不会启动常驻服务或连接 NPU。覆盖 DSL、默认阻塞、计划过期、身份变化、幂等冲突、PNG/证据全链路、鉴权、请求限制、串行执行、超时、伪造/缺失结果、模式混淆、越界路径/符号链接、重启恢复和不重复执行。异常中断可能留下测试目录；确认对应测试进程结束后再清理，不能拿同名硬件数据目录套用清理命令。

静态导入和离线测试通过，不等于真实模型/SDK/共享设备已复现。最终真机验收需另行获得窗口并检查实际 trace、组件版本和原生入口结果。

## 2. 启动默认阻塞服务

服务 API 要求 Bearer Token，产物可使用该令牌或短期单产物签名 URL；缺少服务 token 或长度小于 32 字符时，API 返回 `503 AUTH_NOT_CONFIGURED`，不进入执行路径，也不接受产物签名。令牌只取自配置指定的环境变量，不写入计划、请求文件、公开响应或适配器环境。

在启动服务的 Git Bash/Bash 终端生成临时令牌：

```bash
export CALCULET_DEPLOY_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
```

```bash
node deployment/server.mjs --config deployment/config.example.json
```

预期启动日志只显示 `http://127.0.0.1:8766`，不包含令牌。示例配置的 storageDir 相对配置文件所在目录解析，即 `harness/.local/deployment`。没有配置文件时，CLI 默认 storageDir 为当前目录下 `.local/deployment`。

客户端需以安全方式获得**同一个**令牌；新开终端不会继承刚才 export 的值，重新生成不同令牌也不能访问已启动服务。不要把令牌写入 Git、公开日志、聊天截图或 URL。新终端须从团队的本地密钥管理方式恢复值，或在原终端会话内调用客户端。

```bash
curl --fail-with-body -H "Authorization: Bearer $CALCULET_DEPLOY_TOKEN" http://127.0.0.1:8766/v1/capabilities
```

预期 `executionKind=not_run`、`models=[]`。

```bash
curl --fail-with-body -H "Authorization: Bearer $CALCULET_DEPLOY_TOKEN" -H "Content-Type: application/json" --data-binary @deployment/task.example.json http://127.0.0.1:8766/v1/deployment-plans
```

预期返回 `status=blocked`、`ADAPTER_NOT_CONFIGURED` 和合法 planDigest；仅创建计划，不运行模型。终端 Ctrl-C 停止服务；未完成任务进入 `reconciling`，不因重启而重跑。

## 3. 嵌入与测试入口

```js
import { startService } from './deployment/server.mjs';

const service = await startService({
  config: {
    listen: { host: '127.0.0.1', port: 0 },
    storageDir: '/absolute/private/runtime',
    adapter: null,
  },
  env: { ...process.env, CALCULET_DEPLOY_TOKEN: localSecret },
});
// service.url is the actual origin, including an allocated ephemeral port.
try {
  // Authenticate every request; an adapter-free plan remains blocked.
} finally {
  await service.close();
}
```

`startService({configPath})` 从文件加载配置；`config` 和 `configPath` 同时给出时以文件为准。返回 `url`、`storageDir`、`server`、幂等异步 `close()`。测试可注入 `clock`；生产使用默认 Date.now。`server` 供集成测试观察，不应绕过 close 的恢复流程直接关闭。

## 4. 经批准的适配器配置

**本节是配置说明，不是设备使用授权。** SDK 已配置不能替代操作者批准窗口，也不能推断共享设备无人使用。真实适配器代码未知时保持 adapter=null，不臆造 SDK 调用。

adapter 为以下结构。全部文件路径必须为当前运行操作系统的绝对路径，不能把 Windows 路径直接复制进 Linux 配置。代码、权重与配置须放置在不可信进程不可写的位置；服务 storageDir 及父目录必须为操作者私有目录，Windows 需要相应 ACL。

```json
{
  "executionKind": "hardware",
  "executable": "/absolute/approved/python-or-node",
  "executableSha256": "REPLACE_WITH_ACTUAL_LOWERCASE_SHA256",
  "script": "/absolute/approved/model-adapter.py",
  "scriptSha256": "REPLACE_WITH_ACTUAL_LOWERCASE_SHA256",
  "args": [],
  "cwd": "/absolute/approved/runtime",
  "modelRoot": "/absolute/approved/model",
  "components": [
    { "path": "component-manifest.json", "sha256": "REPLACE_WITH_ACTUAL_LOWERCASE_SHA256" }
  ],
  "environment": {},
  "timeoutMs": 120000,
  "maxOutputBytes": 1048576
}
```

占位摘要不是有效配置，必须由操作者替换。组件清单不能为空，应覆盖全部影响执行的模型、编译产物、适配代码依赖和版本清单；只列一个文本清单不能自动证明清单引用的全部文件相同。服务只检查明确列出的文件，不做依赖扫描。大权重按流式读取计算摘要，会增加规划和启动前检查的 I/O；不要把它误判成模型执行。

固定 args 不得包含协议的 --request/--result 参数；服务将追加这两个参数。固定 environment 可配置已经批准的 SDK 运行变量，不能包含服务 token 变量。子进程只继承 PATH、SystemRoot、WINDIR、TEMP、TMP 和显式 environment，不继承其他服务环境变量；Python 的环境/虚拟环境路径必须由操作者明确配置。

若具体适配器只支持一组固定输入，可在 adapter 中增加可选的 `inputPolicy`。以下只演示结构，内容来自公开 simulation 测试示例，不代表任何真实基线已获准的输入：

```json
{
  "inputPolicy": {
    "prompt": "A red apple on a wooden table",
    "seed": 20261115
  }
}
```

此字段若存在，必须恰有 prompt 和 seed：prompt 是 1–8000 字符的非空、无 NUL 文本，与 TaskSpec 一样规范化两端空白；seed 是 uint32。null、缺项、未知字段或错误类型都拒绝启动。省略字段表示没有附加这项服务门禁，保持原有行为，但不能据此证明适配器实际支持任意输入；实际实现仍须独立检查自身能力，不能把请求参数仅回显为已执行参数。

策略只限制该适配器，不改变固定 profile 的 shape、全局插件参数或其他适配器。规范化策略进入计划绑定摘要；增加、修改或移除策略都使旧 ready 计划不能新执行。不匹配的计划以 `ADAPTER_INPUT_NOT_SUPPORTED` 阻塞；不匹配的新生成请求在创建作业及启动子进程之前返回同名错误（HTTP 409），不会隐式替换为固定输入。已有同键同请求的幂等重放只返回原任务，不创建或执行新任务。排队出队后和实际 spawn 前仍独立检查策略。已登记能力的 displayName/note 明示固定 prompt/seed 限制，不将该基线冒充任意文本生成能力。

真实固定输入值必须由操作者从获准的模型交接材料配置到私有运行文件；公开包不包含此类材料，默认示例继续 adapter=null。

硬件还需要顶层配置：

```json
{
  "operatorAuthorization": {
    "authorized": true,
    "operatorId": "approved-operator-id",
    "authorizationId": "approved-window-record-id",
    "resourceId": "the-actual-shared-device-resource",
    "windowStart": "2026-11-15T09:00:00.000Z",
    "windowEnd": "2026-11-15T09:30:00.000Z",
    "sharedDeviceAcknowledged": true
  },
  "resourceLockPath": "/absolute/shared-lock-directory/device.lock"
}
```

上述时间仅演示格式，不能原样视作当前授权。窗口必须已经开始，且剩余时间覆盖完整 timeoutMs；摘要读取完成后和真正 spawn 前都重新检查当前时间，执行定时器不延后原请求 deadline。时间使用 UTC ISO-8601。合作锁的父目录必须存在、无符号链接，lock 文件放在私有 storageDir **外部**，让其他遵守协议的使用者看见。不同服务不能给同一设备各自配置互不相关的锁。

控制端合作锁与板端 SDK 统一锁是两层责任，前者不能替代后者。私有 adapter request 的必填 `paths.controllerLockPath` 在 hardware 中传递服务配置并已纳入绑定的 resourceLockPath，在 simulation 中显式为 null；该值受 requestDigest 覆盖，不取自 HTTP 客户端。它是控制端路径，不自动证明与远端路径同一或不同。实际 bridge 必须按获准拓扑，在模型/SDK/worker启动前独立核对同主机、同一实际锁的重复持有冲突；无法核对时保守拒绝。不能通过删锁、改为 external、关闭 SDK 锁或另选不受共享约束的板锁路径绕过。该判定由模型专用 bridge 承担，本通用服务没有板端 SDK 身份或硬件使用权限。

计划摘要绑定固定配方、规范化 TaskSpec、执行模式、executable/script 摘要、工作/模型路径、组件清单摘要、固定参数、可选 inputPolicy、子进程环境摘要、执行预算、授权窗口与锁路径。凭据不公开。计划与申请执行之间以及排队出队后重验文件身份与门禁；改变硬约束需要新计划。

## 5. HTTP 行为与持久化

| 接口 | 行为 |
| --- | --- |
| POST /v1/deployment-plans | `{spec}`；201 ready/blocked，不启动进程 |
| POST /v1/deployment-jobs | `{planId,planDigest,idempotencyKey}`；202 作业快照 |
| GET /v1/deployment-jobs/{id} | queued/running/succeeded/failed/blocked/reconciling |
| GET /v1/capabilities | 只发布已成功登记且当前绑定仍有效的档案 |
| POST /v1/jobs | 兼容生成 v1；仅固定 profile 的 text-to-image、prompt、可选 seed |
| GET /v1/jobs/{id} | 兼容生成状态；内部 blocked/reconciling 映射 failed 并保留错误码 |
| GET /v1/artifacts/{jobId}/{artifactId} | 仅成功任务登记的受控产物；读取时再次检查路径和摘要 |

只有 `127.0.0.1` 和 `::1` 可以绑定。Host 必须等于服务公布的实际回环 authority。API 的浏览器 Origin 必须同源，不开放 API CORS；只有经过独立签名校验的产物 GET 可跨源读取。不支持重定向、路径前缀、API query 或任意文件路径；产物 query 只允许下述签名字段。反向代理不是本版支持的安全部署拓扑。

所有 POST 需 application/json（可带 charset=utf-8），不接受压缩请求。默认请求上限 64 KiB、结果 256 KiB、单件产物 32 MiB、请求体等待 10 秒；超限、非法 JSON、未知 API 均返回结构化错误。错误响应不回显子进程日志、任意 SDK 异常或 token。

部署 idempotencyKey 必填，1–128 个 ASCII 字母/数字/点/横线/下划线/冒号，首位为字母或数字。同键同请求返回原任务，包括失败或 reconciling；同键不同请求返回 409，不能重新绑定。先检查既有幂等记录，因此计划过期后仍能安全取回旧任务。并发相同键也只落盘一个任务。

生成 v1 不新增必填正文项；可通过 `Idempotency-Key` 请求头获得同样幂等保证。不带请求头的重复 POST 是不同任务，客户端不能自动重试未知结果。部署与生成共享幂等命名空间，复用相同键会冲突。

私有 storageDir 包含 `state.json`、单实例锁及 `jobs/<id>/`。状态以同目录临时文件、文件 fsync、原子 rename 更新；POSIX 另 fsync 父目录，Windows 不支持相同目录 fsync 保证。任务和幂等记录在返回 HTTP 成功之前持久化。最大 1000 个计划、1000 个任务、16 MiB 状态；达到上限返回 STORE_CAPACITY，不静默删除旧幂等键。需停服、核对设备和未完成任务后由操作者归档整份存储并选择新目录。

每个服务只有一个受控子进程在执行。队列默认最多 32 个未完成任务，等待上限 15 分钟；等待超时不会执行。客户端停止轮询或断开 HTTP 不取消后台任务，也不会自动再次提交。

成功不由 exit=0 或 PNG 单独决定：还要求请求身份、固定模式/范围、零回退和调用次数报告、非空 trace、相互绑定的证据索引、全部产物摘要、可解析 PNG 均一致。numericValidation=not_run 仍只允许 hybrid-smoke，不冒充正式数值/画质验收。证据 summary 明示 `validated_adapter_report`，不是独立设备认证。

浏览器图片请求不会自动携带插件的 Bearer Token。因此任务快照的每个 `artifacts[].uri` 都是短期、单产物绑定的 HMAC-SHA256 URL，例如 `/v1/artifacts/<jobId>/<artifactId>?expires=<epoch-ms>&signature=<hex>`。签名绑定专用用途、GET、服务 origin、完整路径、到期时间、产物 SHA-256 与 MIME，不能用于其他产物、任务或 API。服务 token 永不进入 URL。签名只由当前服务进程随机私钥生成，不写盘、不传给适配器；重启后旧链接失效，通过 Bearer 查询原任务获得新链接，不重新计算模型。

默认 `artifactUrlTtlMs=300000`（5 分钟），允许 1000–900000 ms。过期、参数缺失/重复/篡改、内容身份变化或不同路径的签名均拒绝。链接在期限内可重复读取指定文件，不是一次性下载口令；持有链接者能读取该文件，因此仍须避免发布至公开日志或外部网站。要刷新链接，带 Bearer 再次 GET 原任务；也可去掉 query 后用 Bearer 直接 GET 受控产物路径。

只有有效签名的 GET 产物响应设置 `Access-Control-Allow-Origin: *` 和 `Cross-Origin-Resource-Policy: cross-origin`，方便 `<img>`/下载读取；没有 credentials 授权，API 不继承该例外。所有产物仍重新检查受控路径与 SHA-256，并设置 no-store、nosniff、no-referrer 和限制性 CSP。离线测试覆盖 HTTP 访问策略，不代表已验证桌面客户端的 CSP、私网访问策略或实际 Markdown 图片渲染。

## 6. 故障恢复与限制

| 状态/错误 | 处理原则 |
| --- | --- |
| ADAPTER_NOT_CONFIGURED | 保持阻塞，等待真正入口和完整已批准配置 |
| PLAN_EXPIRED / *_DIGEST_MISMATCH | 核对改变来源，重新创建计划；不修改已有计划 |
| RESOURCE_BUSY | 联系设备操作者，不能因 PID 不见就删除设备锁 |
| ADAPTER_TIMEOUT / 输出超限 / 结果错误 | 不重试计算；保留私有日志和硬件锁，人工确认设备状态 |
| reconciling | 历史任务不自动执行；核对残留进程和真实设备后才允许新计划/新键 |
| ADAPTER_TERMINATION_UNCONFIRMED | 当前队列停止调度，需操作者处理；不假定设备已停止 |
| STATE_CORRUPT / STORE_UNAVAILABLE | 启动或继续调度失败关闭；不覆盖损坏状态创建空队列 |

正常停止会中断本服务拥有的适配器进程树、将遗留任务置为 reconciling。POSIX 使用独立进程组，Windows 使用系统 taskkill /T /F 并后备终止直接子进程。进程终止不等于设备内核停止；适配器不得后台 daemonize 或逃离进程树，服务也不是 OS 沙箱。

重启时 queued/running 一律进入 reconciling，不盲目重放。正常完成任务和幂等记录保留，能力在重新校验当前绑定和证据后可继续发布；有未完成工作被恢复时撤销旧能力。硬件失败/中断留下的合作锁不会自动清理，只有完整成功或确定未启动模型时才由其原持有者释放。

同一 storageDir 只允许一个进程。服务锁只有确认原 PID 不存在时才能在受串行启动保护的流程中回收；PID 仍存活、权限不明、锁损坏或 startup.lock 残留均失败关闭。手工处理锁前必须确认服务与设备状态，不能删除其他使用者的锁，不能用 reset 或杀其他进程替代排程协调。

本实现不验证适配器报告对应真实硬件的密码学证明，不证明资源锁以外的进程不存在，不自动检查权重许可，不支持模型安装、完整核心迁移、任意分辨率、视频、训练、操作系统沙箱、设备硬取消或多进程分布式队列。这些边界不能由离线 simulation 测试消除。
