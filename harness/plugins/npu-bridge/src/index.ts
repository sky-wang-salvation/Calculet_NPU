import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { NpuClient } from './client.js'
import type { BackendConfig } from './client.js'
import { BridgeError, PROTOCOL_VERSION, TASKS } from './protocol.js'

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
    status: { type: 'string', required: true },
    modelId: { type: 'string', required: true },
    task: { type: 'string', required: true },
    executionKind: { type: 'string', required: true },
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

function renderJob(job: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(job) }]
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
}
