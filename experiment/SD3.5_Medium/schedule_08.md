# schedule_08｜最终阶段进展：服务薄桥离线交付与接管复核

归档日期：2026-11-15。本文为本轮工作的最终阶段快照，承接 [schedule_07](schedule_07.md)，不覆盖或改写任何历史记录。**最终收口等级为 `OFFLINE_PROTOCOL_ONLY`：独立服务薄桥已交付并完成离线接管复核，不代表全模型 NPU 迁移或新的真机生图闭环已经完成。**

## 1. 最终状态

| 工作项 | 截至本快照的结论 | 证据与限制 |
| --- | --- | --- |
| 最高已确认模型成果 | 历史 Q-only CPU/NPU HYBRID 四步烟雾生图。 | 真实 NPU 返回值进入每步去噪；不是本轮新增推理。 |
| 独立服务薄桥 | 已完成、封包、单独交付；保持终版字节不变。 | 使用标准 request/result 本地文件协议；未纳入核心 tgz。 |
| 薄桥离线检查 | **31/31 通过，0 失败、0 跳过。** | 包括真实 Node 摘要对照、临时合成 simulation 文件的生产结果校验器互通；不调用模型或设备。 |
| 生产请求侧补充验收 | **17/17 通过。** | 冻结服务生成 deployment/generation 请求，再调用终版桥的非执行校验入口。 |
| 主控独立复核 | 主控报告归档、清单及字节一致，并独立复跑 31 项与 17 项检查通过。 | 属于另一个会话的复核报告，不另算新测试数量或独立硬件认证。 |
| 新桥及参数化受控 payload 真机重验证 | `NOT_RUN`。 | 未启动模型，未连接 SSH / SDK / NPU；没有新增模型图片。 |
| 392 Linear 扩大覆盖 | 运行结局仍为 `UNKNOWN`。 | 实际覆盖、最终产物及当前设备释放状态未核验。 |
| 完整核心迁移、数值及画质验收 | 尚未完成。 | `coreMigrationComplete=false`；离线检查不能提高模型完成等级。 |

本轮发布只归档进展与精选脱敏证据；不重复下载模型、重跑历史参考、恢复 Docker、核查远端设备或清理未知遗留任务。

## 2. 历史真实生图基线保持不变

```text
真实 CLIP 文本编码（CPU）
    ↓ 真实去噪隐藏状态
首层 transformer_blocks[0].attn.to_q（NPU，逐步真实返回）
    ↓ Q 返回值进入 Attention 与后续去噪
其余 DiT / scheduler（CPU），共 4 步
    ↓
VAE（CPU）→ 历史 256×256 PNG
```

| 项目 | 已记录基线 |
| --- | --- |
| 模型 / revision | `stabilityai/stable-diffusion-3.5-medium` / `b940f670f0eda2d07fbb75229e779da1ad11eb80` |
| prompt | `A red apple on a wooden table, soft natural window light, realistic photograph` |
| seed / 分辨率 / batch | `20261115` / `256×256` / `1` |
| steps / guidance / T5 | `4` / `1.0` / 不加载 T5，保留两个真实 CLIP |
| NPU 计算 | 4 次真实 Q 请求，每次 16 个 M16 tile，共 64 个 tile |
| 计算段回退 | 该次 Q 计算段报告 CPU fallback 与 host implementation 均为 0 |
| 历史图片 SHA-256 | `40c42cc65c16dede5a84226692e0a983d68f948298bc0a5ba8dd603811f6258d` |
| 历史耗时 | 约 99.8 秒完整请求墙钟，含加载；不是纯 NPU kernel 时间或加速比 |
| 完成范围 | HYBRID 烟雾预览；其余 DiT、CLIP、scheduler、VAE 仍在 CPU |

历史证据、运行因果关系和原件索引见 [schedule_07](schedule_07.md) 及其[证据索引](ref/progress_20261115/evidence_index.json)。本次未重新生成或上传图片；四个旧 Q 请求的关闭回执不证明当前设备空闲，也不能用于扩大版。

## 3. 本轮新增：可交接的服务协议薄桥

### 3.1 接入链与固定输入

```text
受控服务生成完整 request.json 与 requestDigest
    ↓ 固定 executable / script / args；服务追加 --request 与 --result
独立 service_bridge.py
    ├─ 校验完整固定 spec、身份、摘要、目录与 controllerLockPath
    ├─ 校验新设备窗口与操作者 pin 的私有配置 / 锁拓扑绑定
    ├─ 本地引用受控 handoff，不复制 SDK / 参数 / 历史图片
    └─ 仅在真实新调用及输出核验完成后发布
           image.png + 脱敏 device-trace.json + evidence-index.json
           最后原子发布标准 result.json
```

图中真实执行分支是实现与交接合同，**本轮未执行**。运行仍需独立满足第 6 节全部前提。

| 合同项 | 终版行为 |
| --- | --- |
| 文件协议 | `calculet.adapter-request/v1` / `calculet.adapter-result/v1`；不修改 HTTP API。 |
| profile / recipe | `sd35-qproj-hybrid-smoke-v1` / `sd35-qproj-hybrid-smoke-v1.0`。 |
| 输入 | 仅支持第 2 节固定苹果 prompt、seed 及完整固定 spec；其他输入在生成子进程之前返回 `ADAPTER_INPUT_NOT_SUPPORTED`。 |
| 服务请求种类 | 接受 deployment / generation 身份，但两者都只能使用该固定模型输入。 |
| 摘要 | 删除 requestDigest 后递归排序键、数组保序、紧凑 UTF-8 JSON，按服务规则计算 SHA-256。 |
| 合作锁路径 | `paths.controllerLockPath` 必填且纳入 requestDigest；hardware 必须为可信服务配置生成的绝对路径。 |
| simulation / replay | 真实模型桥不实现；离线测试夹具不构成可运行的 simulation 生图功能。 |
| 资源控制 | 外层服务控制 watchdog 与进程树；桥和子进程不得 detach。 |
| 新鲜性 | 独立私有输出目录与新调用回执；禁止使用历史 PNG 冒充本任务输出。 |
| 产物发布 | 完整 trace 校验先于任何产物发布；同目录 fsync 临时文件通过原子不覆盖硬链接发布，再移除临时链接。任务存储须支持硬链接，不使用覆盖回退。 |

### 3.2 锁、授权和隐私边界

- 服务合作锁仅协调控制端任务，实际板锁仍由原受控 worker 经 SDK 获取与释放；薄桥不代持、不删除、不更换板锁，不使用 external 绕过。
- 路径字符串不同不证明锁域独立；缺少批准的拓扑信息或身份绑定时，模型 / worker 启动前失败关闭。
- SHA pin 只证明配置字节身份。操作者的拓扑声明、本机内核与 inode 检查，不能升级为自动核验远端事实或证明跨主机共享文件系统别名完全分离。
- SDK 配置完成、可 SSH 或历史已授权均不等于新的设备执行窗口。固定批准标志、请求授权、完整 timeout 覆盖与 deadline 等门禁必须同时满足。
- 私有 runtime、原始日志及受控 handoff 保留在操作者私有目录；公开产物仅使用白名单字段。源码或构建摘要不等于独立硬件认证。

## 4. 离线验证与主控复核

### 4.1 薄桥 31 项检查

实际记录为 `31/31`、0 失败、0 错误、0 跳过，耗时 2.540 秒。覆盖固定输入拒绝、完整字段、摘要篡改、窗口门禁、旧产物拒绝、路径与锁拓扑绑定、PNG 完整性 / 有界解压、trace 脱敏、标准 result 与 evidence-index 一致性等。

其中两个互通检查具有明确范围：

1. 使用真实 Node 递归 canonicalizer 与 Python 输出比对请求摘要。
2. 直接导入冻结生产 `validateResult`，校验临时合成、明确标记为 **simulation** 的 PNG / trace / evidence / result。夹具在测试后删除，实际硬件调用为 0；不证明模型结果、设备来源、画质或 HTTP 服务端到端成功。

代码审查发现并修复了“trace 验证失败前先留下图片”及“竞争发布可能覆盖目标”两处问题，并增加回归。默认不提供本地生产校验器路径时，执行 30 项、跳过 1 项可选互通；本次最终记录已提供该路径，因此 31 项全部实际执行。

### 4.2 生产请求侧 17 项补充验收

在独立临时环境中使用冻结服务的 `makeAdapterRequest` 构造完整请求，再调用保持字节不变的终版桥 CLI。结果为 `17/17`：

| 检查类别 | 预期且实得行为 |
| --- | --- |
| 完整 deployment / generation 请求 | `--validate-only` 退出 3，诊断 `VALIDATED_ONLY_NO_DEVICE_EXECUTION`；不生成 result 或图片。 |
| 缺失 controllerLockPath | 拒绝；不启动生成子进程。 |
| controllerLockPath 为 null、布尔、数字、数组、对象、空或相对路径 | 全部拒绝。 |
| 修改锁路径但不重算摘要 | `REQUEST_DIGEST_MISMATCH`。 |
| 其他 prompt / seed | `ADAPTER_INPUT_NOT_SUPPORTED`。 |
| 不提供固定设备批准标志 | `DEVICE_WINDOW_REQUIRED`；未提供 handoff / 私有 runtime。 |
| simulation 请求 | `UNSUPPORTED_EXECUTION_KIND`。 |
| 锁重叠或仅不同路径却无拓扑证明 | 拒绝且不删除合成锁文件。 |

这里的 authorization、模型清单和锁都是临时合成夹具，不是实际设备许可。该验证没有覆盖真实 HTTP 服务、watchdog、SDK、模型或远端锁事实。31 项与 17 项属于两组有重叠覆盖的离线检查，不表示 48 次独立推理。

### 4.3 主控独立接管

主控会话随后报告：独立核对 ZIP、manifest、8 项列入清单的文件与清单自身、旧 handoff pin 及生产 validator 身份全部一致；独立复跑 31 项检查和 17 项请求验收均通过，后者得到相同收据摘要。主控确认无 SSH / SDK / NPU 调用，并按 `OFFLINE_PROTOCOL_ONLY` 收口。

本公开记录将“本会话实际记录与本次字节复核”和“主控会话报告的独立复跑”分开，主控消息不冒充新的硬件证明，也不提供额外设备授权。

## 5. 终版交付身份与本次公开范围

| 对象 | 大小 / SHA-256 |
| --- | --- |
| 独立辅助 ZIP | `23,757` 字节，9 文件；`298dd9573237a1ca04d423960dc54cdde86ef82f9d2386af524de749a1b5a0be` |
| 辅助包 manifest | 覆盖 8 项，排除自身；`90fab353197d1479e3d0f31e9d1fdac118d6fc0b9e99ff9b009a1ffa2c086541` |
| 终版 service_bridge.py | `a8867a2befe3da10716b8b8f5878732e4284ddd8297cb40474ec3381e33df0b9` |
| 31 项离线检查摘要原件 | `f7687084150ecdb66280359ae0ad863c7ba3cae3b4862c320271f6d58e089128` |
| 17 项补充验收收据原件 | `745a19efd8d4a9c5c94ede423441ba79b8dc4fe1393d899a7d832e072ea438e2` |
| 补充验收源码 | `863ef252cba98220016acbb30cec4b3bd3dcc96a4338428fa8b1d1452b3c11b7` |
| 互通对照生产 adapter.mjs | `a62c4ba835a17eee09f1b40044300d8c2a52a0a12bec0a2727982aabfa807506` |

辅助包已经单独交付，不并入核心 tgz。它仅包含新写标准库胶水、占位示例、测试和离线记录，不含受控 payload、任何 PNG、模型、SDK、私有配置或 local-references；引用受控 handoff 不推定其公开再分发许可。

**本次 GitHub 提交仅含本快照与精选脱敏证据索引 / 校验清单，不上传上述 ZIP、受控 handoff、执行 payload、原始日志、图片、设备地址或凭据。** 原件摘要用于身份追溯，不表示公开材料足以独立重现实验。

薄桥退出码：`0` 仅用于真实新调用与完整成功结果；`2` 表示请求 / spec / 摘要 / 路径不符；`3` 表示非执行校验或窗口 / 拓扑门禁；`4` 表示受控子进程失败；`5` 表示本地、产物或新运行证据失败。离线校验返回 3 不是运行失败重试的许可，更不能改写为硬件成功。

## 6. 仍未完成的独立前提

| 前提 | 当前边界 |
| --- | --- |
| 原生 Linux 环境 | 新桥的真实执行环境未验证；本轮未恢复 Docker。 |
| 受控依赖与 worker stage | 仍需操作者批准路径、身份、环境与部署；不能用离线包存在代替运行前提。 |
| 真实锁拓扑 | 尚未现场核查；pin 与声明不等于远端实证，不能假定共享设备空闲。 |
| 新设备窗口 | 当前交付不授予窗口，不自动启动模型或连接设备。 |
| 392 Linear 遗留状态 | `UNKNOWN`，不宣称成功、已停止或设备已释放。 |
| 新桥完整闭环 | 需将同次服务 request、实际源码、NPU 返回值、关闭回执与新图片绑定，当前为 `NOT_RUN`。 |
| 模型能力与正式验收 | 不支持任意 prompt / seed；全核心 NPU、正式数值 / 画质 / 性能验收均未完成。 |
| 静态 calbin 路线 | 既有 `BLOCKED_NATIVE_IO_DOUBLE_BUFFER` 不因 eager 成功或本轮交接而解除。 |

这些是尚未满足的执行与验收条件，不是本次自动排定的任务。不得通过删锁、改锁域、修改共享 SDK / 驱动、设备复位或使用历史图片绕过。

## 7. 本快照证据入口

- [最终脱敏证据索引](ref/progress_final_20261115/evidence_index.json)：记录归档身份、两组离线检查、主控复核归因与未验证事项。
- [公开证据清单](ref/progress_final_20261115/MANIFEST.sha256)：仅覆盖此次公开证据文件，不宣称包含受控原件。
- [上一阶段快照](schedule_07.md)：历史 HYBRID 生成、392 候选及未决范围。

**最终阶段结论：历史 Q-only HYBRID 首图成立；服务薄桥的离线交付与接管复核完成并冻结。新桥真机闭环未运行、扩大覆盖仍 UNKNOWN、完整 NPU 迁移未完成。**
