import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DeploymentError, fail, newId } from './contract.mjs';

export function relativePath(value) {
  if (typeof value !== 'string' || value.length > 512 || !value.length || value.includes('\\') || value.includes(':')) fail('UNSAFE_PATH', 'Use a portable relative file path.');
  const segments = value.split('/');
  if (segments.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..' || part.endsWith('.')
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) fail('UNSAFE_PATH', 'The path contains an unsafe segment.');
  return value;
}

export function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function noSymlinks(target) {
  const resolved = path.resolve(target);
  const { root } = path.parse(resolved);
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links are not allowed in controlled paths.');
  }
  return resolved;
}

export async function ensureDirectory(target) {
  const resolved = path.resolve(target);
  const { root } = path.parse(resolved);
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_PATH', 'Expected a directory without symbolic links.');
  }
  return realpath(resolved);
}

export async function openFile(target, maxBytes = Infinity) {
  await noSymlinks(target);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) fail('UNSAFE_FILE', 'Expected a single-link regular file within the size limit.');
    return { handle, info };
  } catch (error) { await handle.close(); throw error; }
}

export async function readFileSafe(target, maxBytes) {
  const { handle, info } = await openFile(target, maxBytes);
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes) fail('UNSAFE_FILE', 'File exceeds the size limit.');
      chunks.push(chunk);
    }
    const after = await handle.stat();
    if (info.size !== bytes || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('FILE_CHANGED', 'File changed while being read.');
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

export async function hashFile(target) {
  const { handle, info } = await openFile(target);
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    const after = await handle.stat();
    if (bytes !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('FILE_CHANGED', 'File changed while hashing.');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export async function containedFile(root, relative) {
  relativePath(relative);
  const target = path.resolve(root, ...relative.split('/'));
  if (!isInside(root, target)) fail('UNSAFE_PATH', 'File is outside the controlled directory.');
  await noSymlinks(target);
  const actual = await realpath(target);
  if (!isInside(root, actual)) fail('UNSAFE_PATH', 'Resolved file is outside the controlled directory.');
  return actual;
}

export function parseJSON(bytes, code = 'INVALID_JSON') {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(code, 'Expected valid UTF-8 JSON.'); }
}

export async function atomicJSON(target, data) {
  await noSymlinks(path.dirname(target));
  try {
    if ((await lstat(target)).isSymbolicLink()) fail('UNSAFE_PATH', 'Refusing to replace a symbolic link.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${newId('write')}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, target);
    // Windows cannot fsync directories; the file is fsynced before same-directory rename.
    if (process.platform !== 'win32') {
      const dir = await open(path.dirname(target), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function createLock(target, data) {
  await noSymlinks(path.dirname(target));
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle?.close(); }
}

export async function releaseLock(target, token) {
  const data = parseJSON(await readFileSafe(target, 8192), 'LOCK_INVALID');
  if (data.token !== token) fail('LOCK_OWNERSHIP_CHANGED', 'Lock ownership changed; operator intervention is required.', 409);
  await unlink(target);
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function acquireServiceLock(root) {
  const guard = path.join(root, 'startup.lock');
  const target = path.join(root, 'service.lock');
  const token = newId('lock');
  try { await createLock(guard, { pid: process.pid, token }); }
  catch (error) { if (error.code === 'EEXIST') fail('SERVICE_LOCKED', 'Another startup or unreconciled startup lock exists.', 409); throw error; }
  try {
    try {
      const previous = parseJSON(await readFileSafe(target, 8192), 'LOCK_INVALID');
      if (pidAlive(previous.pid)) fail('SERVICE_LOCKED', 'The storage directory is owned by a live or unverified process.', 409);
      await releaseLock(target, previous.token);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await createLock(target, { pid: process.pid, token, startedAt: new Date().toISOString() });
    return () => releaseLock(target, token);
  } finally { await releaseLock(guard, token); }
}

export function publicError(error, fallback = 'INTERNAL_ERROR') {
  return error instanceof DeploymentError
    ? { code: error.code, message: error.message }
    : { code: fallback, message: 'The operation could not be completed; inspect private service logs.' };
}
