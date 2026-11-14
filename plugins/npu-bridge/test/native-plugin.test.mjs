import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as bridge from '../lib/index.js'

test('real Cordis registry loads four tools, applies defaults, and unloads cleanly', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(Tools).await()
  const fork = ctx.plugin(bridge, {})
  await fork.await()
  assert.deepEqual(ctx.tools.schemas().map(row => row.name).sort(),
    ['npu_status', 'npu_list_models', 'npu_generate', 'npu_get_job'].sort())
  const exec = { signal: new AbortController().signal }
  const status = await ctx.tools.get('npu_status').execute({}, exec)
  assert.equal(status.state, 'not_configured')
  assert.equal(status.configured, false)
  assert.deepEqual(await ctx.tools.get('npu_list_models').execute({}, exec), { source: 'not_configured', models: [] })
  await assert.rejects(ctx.tools.get('npu_generate').execute({
    modelId: 'absent', task: 'text-to-image', prompt: 'test',
  }, exec), error => error.code === 'BACKEND_NOT_CONFIGURED')
  await fork.dispose()
  assert.equal(ctx.tools.schemas().length, 0)
})
