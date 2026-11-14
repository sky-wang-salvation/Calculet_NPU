import type { Job } from './protocol.js'
import type { WaitResult } from './client.js'

const statuses = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ')

/** Text content is readable by the Agent and can be reused in its final reply. */
export function jobMarkdown(job: Job): string {
  const mode = job.executionKind === 'simulation' ? '测试／仿真模式，非 NPU 实测'
    : job.executionKind === 'hardware' ? '后端声明真机执行（需另核对 trace）' : '尚未执行'
  const lines = [
    `任务 ${escape(job.id)}：${statuses[job.status]}`,
    `模型：${escape(job.modelId)} · ${mode}`,
  ]
  if (job.error) lines.push(`错误 ${escape(job.error.code)}：${escape(job.error.message)}`)
  for (const artifact of job.artifacts) {
    // Parsed, same-origin HTTP(S) URLs only. Escape Markdown URL delimiters.
    const uri = artifact.uri.replace(/[()<>\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    lines.push(`[打开／下载 ${escape(artifact.id)} (${escape(artifact.mimeType)})](<${uri}>)`)
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(artifact.mimeType)) {
      lines.push(`![${escape(artifact.id)}](<${uri}>)`)
    }
  }
  if (['queued', 'running'].includes(job.status)) lines.push(`使用 npu_wait_job 或 npu_get_job，传入 jobId=${escape(job.id)} 继续跟踪。`)
  return lines.join('\n\n')
}

export function waitMarkdown(result: WaitResult): string {
  const notice = result.timedOut ? '本次等待已到时，后台任务没有因此取消。可用同一任务 ID 继续查询。'
    : result.queryError ? `查询中断：${escape(result.queryError.message)}。保留任务 ID 后重试查询，无需重新生成。`
      : '已到达终态（成功、失败或取消），请检查任务状态。'
  return `${notice}\n\n任务 ID：${escape(result.jobId)}\n\n${result.job ? jobMarkdown(result.job) : '本次未取得任务快照。'}`
}
