# 部署服务离线验证记录

## 结果

- Node.js：v24.15.0；运行平台：Windows 11 / win32。
- 集成分支：`feat/harness-deployment-closure`。
- 最终测试：**62 / 62 通过**，失败 0、取消 0、跳过 0、TODO 0。
- 总耗时：47,322.103 ms；退出码：0。
- 全部受控适配器执行都是 `simulation`，实际 NPU 调用数为零。

完整原始输出：[offline-tests.tap](offline-tests.tap)。测试命令、执行环境、各源码及结果文件 SHA-256：[manifest.json](manifest.json)。manifest 不包含自身和本说明，以避免自引用。

从本次会话工作目录执行的原始测试命令：

```bash
node --test --test-reporter=tap Calculet_NPU_integration/harness/deployment/test/contract.test.mjs Calculet_NPU_integration/harness/deployment/test/server.test.mjs Calculet_NPU_integration/harness/deployment/test/artifact-access.test.mjs Calculet_NPU_integration/harness/deployment/test/input-policy.test.mjs Calculet_NPU_integration/harness/deployment/test/controller-lock.test.mjs
```

## 覆盖范围

- 合法完整 DSL、规范化和重复校验；未知字段、缺项、错误类型及不受支持参数。
- 计划摘要/绑定/过期、无适配器阻塞、组件身份变化。
- 可选适配器 inputPolicy：严格字段/类型、规范化、固定prompt/seed匹配和阻塞、生成拒绝不落盘、不启动进程、策略增/改/删改变绑定、能力限制说明及spawn前独立拦截。
- 并发幂等去重、同键异请求冲突、持久键重放。
- simulation 部署、证据索引、PNG 校验与鉴权下载、可选数值指标、生成 v1。
- Bearer 鉴权、缺 token 失败关闭、原生 HTTP Host 校验、Origin、媒体类型、体积上限、非法 JSON。
- 短期单产物签名：无 Bearer 的指定文件 GET、跨源响应头；缺少/篡改/重复/过期签名、跨任务/产物/内容/MIME/origin 复用、进程密钥更换均拒绝；签名不能认证 API，刷新链接不重算模型。
- 非零退出、缺失或伪造 result、请求身份/摘要、执行模式/CPU-NPU 范围不符、回退或调用数异常。
- 不完整证据、空 trace、错误摘要、非法 PNG、越界/绝对路径、符号链接逃逸、缺文件、请求篡改。
- 单进程存储所有权、损坏状态拒绝、串行子进程、队列等待超时、子进程超时和输出限额。
- 服务停止、冷启动 queued/running 恢复为 reconciling、不重复执行、成功能力和链接在新端口恢复。
- 硬件门禁只验证拒绝路径：缺授权、缺合作锁、已有锁、过期窗口；摘要 I/O 之后及真正 spawn 前再次检查窗口。
- 私有 request.paths.controllerLockPath：hardware 来源为服务已绑定配置、两种摘要覆盖、客户端不能注入；simulation 必须显式 null、未取得硬件锁；缺失/错误 fixture 字段在产物生成前拒绝。硬件字段测试只构造/检查元数据，未启动硬件进程、SDK 或板端 worker。

所有 ESM 源码、测试和 fixture 另经 `node --check` 语法检查（退出码 0）。CLI 主入口的非法参数路径另以独立 Node 子进程确认返回结构化 `INVALID_ARGUMENTS` 和退出码 1；该检查没有启动服务或适配器。

## 检查中修正的项目

首轮 47 项中有 1 项 Host 测试失败：Node fetch 未按测试预期发送自定义 Host。测试改为 node:http 原始请求后验证通过，没有绕开服务器 Host 防护。初版 50 项全通过后，按集成审查补齐短期单产物签名访问，三个测试文件共 53 项全通过；随后加入具体适配器 inputPolicy 限制，四个测试文件共 58 项全通过；补齐控制锁路径文件协议后，最终五个测试文件共 62 项全通过。结构化 evidence 未降为字符串，成功状态 phase=complete 已有回归断言。

独立代码检查发现并修正：

1. 授权窗口检查不得使用耗时文件摘要检查前的旧时间；改为 I/O 之后取时，并在 spawn 前再校验，进程定时器保留原请求 deadline。补有不启动任何进程的回归测试。
2. 真实设备合作锁必须在成功状态与能力登记持久化之后释放，不能在落盘失败时丢失恢复门禁。已调整代码次序；未通过实际 NPU 运行或硬件存储故障注入验证此分支。

## 未验证边界

没有连接真实 NPU、读取私有 SDK 或模型权重、安装依赖、执行硬件授权窗口内的正向链路，也没有进行完整数值、图像质量或核心迁移验收。Linux/POSIX 进程组终止和目录 fsync 分支未在该 Windows 环境重放。子进程和设备锁不能证明设备内核已停止，不能排除不遵守合作锁的其他进程。签名产物测试是 HTTP 层验证，没有在桌面客户端实测 Markdown 渲染、CSP 或浏览器私网访问策略。

所有代码与文件合同都可供模型团队接入，但不能由本离线报告推导“真实模型已就绪”。真实适配器、完整文件清单、合法权重、实际设备协调与操作者授权窗口仍是必需前置条件。本工作没有提交、推送、stash、reset 或切换共享分支。
