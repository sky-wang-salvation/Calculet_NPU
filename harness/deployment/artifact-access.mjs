import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJSON, fail, identifier } from './contract.mjs';

export function createArtifactAccess({ origin, ttlMs, clock = Date.now }) {
  const key = randomBytes(32);
  const sign = (pathname, expires, artifact) => createHmac('sha256', key).update(canonicalJSON({
    purpose: 'calculet.artifact-read/v1', method: 'GET', origin, pathname, expires,
    contentSha256: artifact.sha256, mimeType: artifact.mimeType,
  })).digest('hex');
  return {
    issue(jobId, artifact) {
      const pathname = `/v1/artifacts/${identifier(jobId)}/${identifier(artifact.id)}`;
      const expires = String(clock() + ttlMs);
      return `${origin}${pathname}?expires=${expires}&signature=${sign(pathname, expires, artifact)}`;
    },
    authorize(target, artifact) {
      const entries = [...target.searchParams];
      const expires = target.searchParams.get('expires');
      const signature = target.searchParams.get('signature');
      if (target.origin !== origin || entries.length !== 2
        || target.searchParams.getAll('expires').length !== 1 || target.searchParams.getAll('signature').length !== 1
        || typeof expires !== 'string' || !/^[1-9][0-9]{0,15}$/.test(expires)
        || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)
        || !Number.isSafeInteger(Number(expires)) || !artifact) {
        fail('INVALID_ARTIFACT_ACCESS', 'A valid artifact-specific signed URL or API Bearer token is required.', 401);
      }
      const expected = sign(target.pathname, expires, artifact);
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
        fail('INVALID_ARTIFACT_ACCESS', 'The signed URL does not authorize this artifact identity.', 401);
      }
      const now = clock();
      if (Number(expires) <= now || Number(expires) > now + ttlMs) {
        fail('ARTIFACT_URL_EXPIRED', 'This artifact URL expired or is outside its validity window; query the job with API authorization for a new URL.', 401);
      }
    },
  };
}
