import type { DeploymentJob, DeploymentPlan } from './deployment.js'
import type { DeploymentWaitResult } from './client.js'

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ')

export function deploymentPlanMarkdown(plan: DeploymentPlan): string {
  const parameters = plan.spec.parameters
  const lines = [
    `部署计划 ${escape(plan.id)}：${plan.status === 'ready' ? '预检可执行，执行时仍需重新核对授权与资源' : '已阻塞，未启动模型执行'}`,
    `模型：${escape(plan.spec.modelId)}；能力档案：${escape(plan.spec.profileId)}`,
    `配置：${parameters.width}×${parameters.height}，batch ${parameters.batch}，${parameters.steps} 步，guidance ${parameters.guidanceScale}，T5 关闭，seed ${parameters.seed}。`,
    '计算范围：HYBRID。仅每步首层 Q 投影在 NPU，其他已声明模块在 CPU；不是完整核心迁移。',
    '验收目标：hybrid-smoke，不等同于正式数值或图像质量验收。',
    `步骤：${plan.steps.map(escape).join(' → ')}`,
    `计划摘要：${escape(plan.planDigest)}`,
    `过期时间：${escape(plan.expiresAt)}`,
  ]
  for (const blocker of plan.blockers) lines.push(`阻塞 ${escape(blocker.code)}：${escape(blocker.message)}`)
  if (plan.status === 'ready') lines.push('核对结构化 spec 与用户要求一致后，使用原 planId、planDigest 及稳定的 idempotencyKey 提交；修改要求需重新规划。')
  return lines.join('\n\n')
}

export function deploymentJobMarkdown(job: DeploymentJob): string {
  const kind = job.executionKind === 'hardware' ? '适配器报告真机执行，需核对对应运行证据'
    : job.executionKind === 'simulation' ? 'simulation：测试适配器，非模型或 NPU 实测' : '尚未执行'
  const lines = [
    `部署任务 ${escape(job.id)}：${escape(job.status)}；阶段：${escape(job.phase)}`,
    `计划：${escape(job.planId)}；${kind}`,
    '范围：HYBRID / hybrid-smoke；完整核心迁移：否。',
  ]
  if (job.error) lines.push(`错误 ${escape(job.error.code)}：${escape(job.error.message)}`)
  if (job.evidence) {
    const evidence = job.evidence
    lines.push(`证据来源：经服务校验的适配器报告，不是独立硬件认证。设备检查：${escape(evidence.deviceExecution.status)}；数值检查：${escape(evidence.numericValidation.status)}；图片文件检查：${escape(evidence.imageValidation.status)}。`)
    lines.push(job.executionKind === 'simulation' ? '四个模拟步骤；实际 NPU 调用为零。'
      : `适配器报告 Q 投影请求 ${evidence.deviceExecution.npuCallCount} 次、计算段回退 ${evidence.deviceExecution.npuFallbackCount} 次；不是 kernel launch 计数。`)
    lines.push('图片检查只表示文件和尺寸有效，不代表正式画质验收。数值检查的参考与批准合同需另看证据索引。')
  }
  for (const artifact of job.artifacts) {
    const uri = artifact.uri.replace(/[()<>\s]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    lines.push(`[打开 ${escape(artifact.id)} (${escape(artifact.mimeType)})](<${uri}>)`)
    if (artifact.mimeType === 'image/png') lines.push(`![${escape(artifact.id)}](<${uri}>)`)
  }
  if (job.status === 'reconciling') lines.push('执行结果需要核对。不要重新提交或自行重启设备任务；由操作者确认已有副作用和资源状态。')
  if (['queued', 'running'].includes(job.status)) lines.push('使用 npu_wait_deployment_job 或 npu_get_deployment_job 继续查询，不需要重复提交。')
  return lines.join('\n\n')
}

export function deploymentWaitMarkdown(result: DeploymentWaitResult): string {
  const notice = result.timedOut ? '本次等待到时，后台任务没有因此取消；可用原任务 ID 继续查询。'
    : result.queryError ? `查询中断：${escape(result.queryError.message)}；保留原任务 ID，不自动重新提交。`
      : '任务已结束或需要处理，请检查成功、失败、阻塞或待核对状态。'
  return `${notice}\n\n任务 ID：${escape(result.jobId)}\n\n${result.job ? deploymentJobMarkdown(result.job) : '本次没有取得任务快照。'}`
}
