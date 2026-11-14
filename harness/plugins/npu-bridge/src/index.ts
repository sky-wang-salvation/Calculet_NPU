import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { NpuClient } from './client.js'
import type { BackendConfig } from './client.js'
import { BridgeError, PROTOCOL_VERSION, TASKS } from './protocol.js'
import { jobMarkdown, waitMarkdown } from './presentation.js'
import { deploymentPlanMarkdown, deploymentJobMarkdown, deploymentWaitMarkdown } from './deployment-presentation.js'
import { deploymentPlanSchema, deploymentJobSchema, deploymentWaitSchema } from './deployment-tool-schemas.js'
import type { Job } from './protocol.js'

export const name = 'calculet-npu'
export const inject = ['tools']

export interface Config extends BackendConfig {}

export const Config: Schema<Config> = Schema.object({
  backendURL: Schema.string().default('').description('已验证的本地或现场 NPU 服务地址；留空表示尚未接入。'),
  apiToken: Schema.string().role('secret').default('').description('NPU 服务访问令牌。'),
  timeoutMs: Schema.number().step(1).min(1).default(15000).description('单次后端请求超时，单位毫秒。'),
  maxResponseBytes: Schema.number().step(1).min(1).default(1048576).description('后端 JSON 响应大小上限。'),
  maxPromptChars: Schema.number().step(1).min(1).default(8000).description('生成提示词的长度上限。'),
})

const modelSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    displayName: { type: 'string', required: true },
    tasks: { type: 'array', items: { type: 'string' }, required: true },
    readiness: { type: 'string', required: true },
  },
} as const

const jobSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'], required: true },
    modelId: { type: 'string', required: true },
    task: { type: 'string', enum: TASKS, required: true },
    executionKind: { type: 'string', enum: ['hardware', 'simulation', 'not_run'], required: true },
    artifacts: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, uri: { type: 'string', required: true }, mimeType: { type: 'string', required: true },
      } },
    },
    error: { type: 'object', additionalProperties: false, properties: {
      code: { type: 'string', required: true }, message: { type: 'string', required: true },
    } },
  },
} as const

async function toolCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() }
  catch (cause) {
    if (cause instanceof BridgeError) throw new HarnessError(cause.message, cause.code)
    throw cause
  }
}

function renderJob(job: Job) {
  return [{ type: 'text' as const, text: jobMarkdown(job) }]
}

/** Register tools using the official registry and effect-owned plugin lifetime. */
export function apply(ctx: Context, config: Config): void {
  const client = new NpuClient(config)
  ctx.tools.register(defineTool({
    name: 'npu_status',
    description: '检查原粒 NPU 服务接入状态。没有配置服务时明确返回未接入，不会运行模型。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        configured: { type: 'boolean', required: true },
        state: { type: 'string', required: true },
        protocolVersion: { type: 'string', required: true },
        message: { type: 'string', required: true },
        backendId: { type: 'string' }, executionKind: { type: 'string' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      if (!client.configured) return {
        configured: false, state: 'not_configured', protocolVersion: PROTOCOL_VERSION,
        message: '插件已加载；NPU 服务尚未接入，尚未运行模型。模型迁移仍在独立测试中。',
      }
      return toolCall(async () => {
        const capabilities = await client.capabilities(exec.signal)
        return {
          configured: true, state: 'connected', protocolVersion: capabilities.protocolVersion,
          message: '已读取后端声明的能力。状态检查不代表已经完成一次模型推理。',
          backendId: capabilities.backendId, executionKind: capabilities.executionKind,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_list_models',
    description: '读取 NPU 服务实际公布的模型与支持任务。未接入时返回空列表，不把研究项目当作可用模型。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        source: { type: 'string', required: true },
        models: { type: 'array', items: modelSchema, required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      if (!client.configured) return { source: 'not_configured', models: [] }
      return toolCall(async () => ({ source: 'backend', models: (await client.capabilities(exec.signal)).models }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_generate',
    description: '向已接入且声明就绪的 NPU 模型提交图像或视频生成任务。只返回真实后端任务，不生成演示图片或虚构成功。',
    parameters: {
      modelId: { type: 'string', required: true, description: 'npu_list_models 返回的模型标识。' },
      task: { type: 'string', enum: TASKS, required: true },
      prompt: { type: 'string', required: true },
      seed: { type: 'integer' },
      inputArtifactId: { type: 'string', description: '图生视频时使用已上传至后端的图片产物标识。' },
    },
    output: { schema: jobSchema, render: (_args, value) => renderJob(value) },
    async execute(args, exec) { return toolCall(() => client.generate(args, exec.signal)) },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_get_job',
    description: '查询 NPU 生成任务进度和产物，保留 hardware、simulation、not_run 的区别。',
    parameters: { jobId: { type: 'string', required: true } },
    output: { schema: jobSchema, render: (_args, value) => renderJob(value) },
    async execute(args, exec) { return toolCall(() => client.getJob(args.jobId, exec.signal)) },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_wait_job',
    description: '有时限地轮询已有任务，直到成功、失败、取消或等待到时。到时或查询中断会保留任务 ID；不会取消后台任务，也不会重新提交生成。',
    parameters: {
      jobId: { type: 'string', required: true },
      maxWaitMs: { type: 'integer', description: '本次等待上限 1–60000 毫秒，默认 30000。到时可继续调用。' },
      pollIntervalMs: { type: 'integer', description: '查询间隔 10–10000 毫秒，默认 1000。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        jobId: { type: 'string', required: true }, completed: { type: 'boolean', required: true },
        timedOut: { type: 'boolean', required: true }, elapsedMs: { type: 'integer', required: true },
        job: jobSchema,
        queryError: { type: 'object', additionalProperties: false, properties: {
          code: { type: 'string', required: true }, message: { type: 'string', required: true },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: waitMarkdown(value) }],
    },
    async execute(args, exec) {
      return toolCall(() => client.waitJob(args.jobId, exec.signal, args.maxWaitMs, args.pollIntervalMs))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_plan_deployment',
    description: '把 SD3.5 部署目标转为 calculet.task/v1 任务契约并请求服务预检计划，不启动模型。当前只支持已配置 SDK 的 256×256、4步、无T5、首层Q投影NPU的HYBRID烟雾档案；不支持的要求明确拒绝，不静默降级。',
    parameters: {
      prompt: { type: 'string', required: true, description: '部署验证使用的真实生成要求。' },
      modelId: { type: 'string', description: '默认 sd35-medium；其他模型未适配。' },
      profileId: { type: 'string', description: '默认 sd35-qproj-hybrid-smoke-v1。' },
      seed: { type: 'integer', description: 'uint32；未指定时使用已公开默认值 20261115。' },
      width: { type: 'integer', description: '当前只支持 256；不支持的值会拒绝。' },
      height: { type: 'integer', description: '当前只支持 256。' },
      batch: { type: 'integer', description: '当前只支持 1。' },
      steps: { type: 'integer', description: '当前只支持 4。' },
      guidanceScale: { type: 'number', description: '当前只支持 1。' },
      enableT5: { type: 'boolean', description: '当前只支持 false。' },
      requireFullNpu: { type: 'boolean', description: '若用户要求完整核心NPU迁移，传 true，系统会明确拒绝当前混合配方。' },
      allowNpuComputeFallback: { type: 'boolean', description: '当前NPU计算段不允许CPU回退；已声明的CPU模块不属于回退。' },
    },
    output: { schema: deploymentPlanSchema, render: (_args, value) => [{ type: 'text', text: deploymentPlanMarkdown(value) }] },
    async execute(args, exec) { return toolCall(() => client.planDeployment(args, exec.signal)) },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_apply_deployment',
    description: '提交已核对的 ready 部署计划。此工具会创建有副作用的异步执行；服务端仍独立检查授权窗口、资源、计划摘要和绑定。只传原计划ID与摘要，不可自行批准权限。同一次提交或不确定结果的重试使用同一幂等键。',
    parameters: {
      planId: { type: 'string', required: true },
      planDigest: { type: 'string', required: true, description: '规划工具返回的完整SHA-256摘要，不可重写。' },
      idempotencyKey: { type: 'string', required: true, description: '本次操作的稳定唯一键；ASCII字母数字、点、横线或下划线，1–128字符，首位字母数字。' },
    },
    output: { schema: deploymentJobSchema, render: (_args, value) => [{ type: 'text', text: deploymentJobMarkdown(value) }] },
    async execute(args, exec) { return toolCall(() => client.applyDeployment(args, exec.signal)) },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_get_deployment_job',
    description: '查询部署阶段、证据和阻塞原因。成功仅表示HYBRID烟雾合同完成，不表示完整核心迁移、正式精度或画质通过。reconciling需操作者核对，不可盲目重跑。',
    parameters: { jobId: { type: 'string', required: true } },
    output: { schema: deploymentJobSchema, render: (_args, value) => [{ type: 'text', text: deploymentJobMarkdown(value) }] },
    async execute(args, exec) { return toolCall(() => client.getDeploymentJob(args.jobId, exec.signal)) },
  }))

  ctx.tools.register(defineTool({
    name: 'npu_wait_deployment_job',
    description: '有时限地查询已有部署任务，直到成功、失败、阻塞、待核对或等待到时。只发GET，不重复部署；停止等待不取消后台计算。',
    parameters: {
      jobId: { type: 'string', required: true },
      maxWaitMs: { type: 'integer', description: '本次等待1–60000毫秒，默认30000。' },
      pollIntervalMs: { type: 'integer', description: '查询间隔10–10000毫秒，默认1000。' },
    },
    output: { schema: deploymentWaitSchema, render: (_args, value) => [{ type: 'text', text: deploymentWaitMarkdown(value) }] },
    async execute(args, exec) { return toolCall(() => client.waitDeploymentJob(args.jobId, exec.signal, args.maxWaitMs, args.pollIntervalMs)) },
  }))
}
