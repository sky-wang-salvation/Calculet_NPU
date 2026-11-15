#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const usage = 'Usage: sn4ck-npu-service [--config path-to-config.json]\n       sn4ck-npu-service --help | --version\n';

async function main() {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(`${usage}\nDSH-SN4CK requires Node 24.9+ (24.x). Binds only loopback.\nWithout an approved adapter, deployment plans remain blocked.\nThe service never installs SDKs, downloads models, or selects a test fixture.\nSee runtime/docs/plugin-installation.md and runtime/README.md in this package.\n`);
    return;
  }
  if (args.length === 1 && ['--version', '-V'].includes(args[0])) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${manifest.name} ${manifest.version}\n`);
    return;
  }
  if (!(args.length === 0 || args.length === 2 && args[0] === '--config' && args[1] && !args[1].startsWith('--'))) {
    throw new Error(usage.trim());
  }
  const { startService } = await import('../runtime/server.mjs');
  const service = await startService(args.length ? { configPath: path.resolve(args[1]) } : {});
  process.stdout.write(`${JSON.stringify({ service: 'calculet-deployment', url: service.url, execution: 'Requires authenticated plan and explicit approved adapter configuration.' })}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    service.close().catch(() => {
      process.stderr.write('Deployment service shutdown failed; reconcile private runtime state before restarting.\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  process.stderr.write(`${error.code ?? 'SERVICE_START_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});
