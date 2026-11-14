const $ = id => document.getElementById(id)
let controller, busy = false, lastStatus = '', active = ''
const labels = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const savedKey = 'calculet-fixture-job-id'
try { $('job-id').value = localStorage.getItem(savedKey) ?? '' } catch {}
function message(text) { $('message').textContent = text }
function lock(value) {
  busy = value
  $('submit').disabled = value || !$('model').options.length
  $('resume').disabled = value
  $('stop').disabled = !value
}
function remember(id) {
  $('job-id').value = id
  try { localStorage.setItem(savedKey, id) } catch {}
}
async function call(name, args = {}, signal) {
  const response = await fetch(`/bridge/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal })
  const result = await response.json()
  if (!response.ok) throw new Error(`${result.error?.code ?? response.status}：${result.error?.message ?? '请求失败'}`)
  $('tool-output').textContent = result.content.map(block => block.text ?? '').join('\n\n')
  return result.value
}
function draw(job) {
  remember(job.id)
  if (active !== job.id) { active = job.id; lastStatus = ''; $('history').replaceChildren() }
  $('status').textContent = labels[job.status] ?? job.status
  $('status').className = `pill ${job.status}`
  if (lastStatus !== job.status) {
    const line = document.createElement('li')
    line.textContent = `${new Date().toLocaleTimeString()} · ${labels[job.status] ?? job.status}`
    $('history').append(line); lastStatus = job.status
  }
  $('metadata').replaceChildren()
  for (const [label, value] of [['任务', job.id], ['模型', job.modelId], ['执行', 'simulation · 测试服务，未执行模型／NPU']]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd')
    dt.textContent = label; dd.textContent = value; $('metadata').append(dt, dd)
  }
  $('artifacts').replaceChildren()
  for (const item of job.artifacts) {
    const uri = new URL(item.uri, location.href)
    if (uri.origin !== location.origin) throw new Error('拒绝非本机测试服务的产物地址')
    const card = document.createElement('div')
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mimeType)) {
      const img = document.createElement('img'); img.alt = 'TEST 固定联调图，不是模型生成结果'; img.src = uri.href
      img.addEventListener('error', () => message('任务已完成，但图片读取失败。请检查产物服务并继续查询。'))
      card.append(img)
    } else if (['video/mp4', 'video/webm'].includes(item.mimeType)) {
      const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.src = uri.href; card.append(video)
    }
    const caption = document.createElement('p'); caption.className = 'artifact-caption'; caption.textContent = `${item.id} · ${item.mimeType} · 测试产物`
    const links = document.createElement('div'); links.className = 'artifact-actions'
    const open = document.createElement('a'); open.href = uri.href; open.textContent = '打开原图'; open.target = '_blank'; open.rel = 'noopener noreferrer'
    const download = document.createElement('a'); const target = new URL(uri); target.searchParams.set('download', '1'); download.href = target.href; download.download = 'test-fixture.png'; download.textContent = '下载测试产物'; download.className = 'download'
    links.append(download, open); card.append(caption, links); $('artifacts').append(card)
  }
  if (!job.artifacts.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = job.status === 'failed' ? '任务失败，没有产物' : '产物将在任务成功后出现'; $('artifacts').append(empty) }
}
async function track(id, signal) {
  const deadline = performance.now() + Number($('budget').value)
  while (true) {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) { message('本次跟踪已到时。后台任务继续运行，点击“继续跟踪”即可恢复。'); return }
    const result = await call('npu_wait_job', { jobId: id, maxWaitMs: Math.min(1000, remaining), pollIntervalMs: 250 }, signal)
    if (result.job) draw(result.job)
    if (result.queryError) { message(`查询中断：${result.queryError.message}。任务 ID 已保留，请继续查询，不必重新提交。`); return }
    if (result.completed) {
      message(result.job.status === 'succeeded' ? '测试任务完成。图片可预览、打开和下载；未执行模型或 NPU。' : result.job.error ? `${result.job.error.code}：${result.job.error.message}` : '后台任务已取消。')
      return
    }
    message('正在跟踪测试任务；停止等待不会取消后台任务。')
  }
}
async function run(action) {
  if (busy) return
  controller = new AbortController(); lock(true)
  try { await action(controller.signal) }
  catch (error) { message(error.name === 'AbortError' ? '已停止本次等待。后台任务没有取消，可用原任务 ID 继续查询。' : `${error.message}。已有任务 ID 会保留。`) }
  finally { controller = undefined; lock(false) }
}
$('generate-form').addEventListener('submit', event => {
  event.preventDefault()
  run(async signal => {
    message('正在提交测试任务…')
    const job = await call('npu_generate', { modelId: $('model').value, task: 'text-to-image', prompt: $('prompt').value, seed: Number($('seed').value) }, signal)
    draw(job); message('任务已提交，正在跟踪…'); await track(job.id, signal)
  })
})
$('resume').addEventListener('click', () => run(async signal => {
  const id = $('job-id').value.trim()
  if (!id) throw new Error('请先填写任务 ID')
  message('正在恢复查询…'); await track(id, signal)
}))
$('stop').addEventListener('click', () => controller?.abort())
try {
  const status = await call('npu_status')
  const { models } = await call('npu_list_models')
  if (status.executionKind !== 'simulation') throw new Error('此联调台只允许测试服务')
  for (const model of models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.displayName; $('model').append(option) }
  $('connection').textContent = '● 五项原生插件工具已注册 · 本机测试服务已接入'
  lock(false)
} catch (error) { $('connection').textContent = error.message; message('初始化失败，请检查本机测试服务。') }
