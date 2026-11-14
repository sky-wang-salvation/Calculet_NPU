import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = resolve(root, '.local/dsh-home')
const cli = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const profile = 'calculet'
mkdirSync(dshHome, { recursive: true })
if (!existsSync(resolve(root, 'plugins/npu-bridge/lib/index.js'))) {
  throw new Error('Build the plugin first: npm run build')
}
if (!existsSync(resolve(dshHome, `profiles/${profile}/package.json`))) {
  throw new Error('Initialize and install the profile first; see harness/docs/local-development.md')
}
const args = process.argv.slice(2)
const inspecting = args.includes('--dump-config') || args.includes('--dump-config-schema')
const backendPatch = resolve(root, '.local/npu.patch.yml')
const child = spawn(process.execPath, [cli, '--profile', profile,
  '--patch', resolve(root, 'scripts/local.patch.yml'),
  ...(existsSync(backendPatch) ? ['--patch', backendPatch] : []), ...args,
  ...(inspecting ? [] : ['--host', '127.0.0.1', '--port', '3080']),
], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DSH_HOME: dshHome },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
