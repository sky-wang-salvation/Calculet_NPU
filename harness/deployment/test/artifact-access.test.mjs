import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactAccess } from '../artifact-access.mjs';
import { normalizeConfig } from '../config.mjs';
import { harness, plan, apply, waitJob, request, TOKEN } from './helpers.mjs';

const origin = 'http://127.0.0.1:8766';
const image = { id: 'image', sha256: 'a'.repeat(64), mimeType: 'image/png' };

test('artifact signature binds origin, GET path, content identity, media type, and expiry', () => {
  let now = 1800000000000;
  const access = createArtifactAccess({ origin, ttlMs: 1000, clock: () => now });
  const uri = access.issue('job-one', image);
  const url = new URL(uri);
  assert.equal(url.origin, origin);
  assert.match(url.searchParams.get('signature'), /^[a-f0-9]{64}$/);
  assert.equal(url.searchParams.get('expires'), String(now + 1000));
  assert.equal(access.authorize(url, image), undefined);
  for (const [pathname, artifact] of [
    ['/v1/artifacts/job-two/image', image],
    ['/v1/artifacts/job-one/trace', { ...image, id: 'trace' }],
    [url.pathname, { ...image, sha256: 'b'.repeat(64) }],
    [url.pathname, { ...image, mimeType: 'application/json' }],
  ]) {
    const changed = new URL(uri); changed.pathname = pathname;
    assert.throws(() => access.authorize(changed, artifact), { code: 'INVALID_ARTIFACT_ACCESS' });
  }
  const otherOrigin = new URL(uri); otherOrigin.port = '8767';
  assert.throws(() => access.authorize(otherOrigin, image), { code: 'INVALID_ARTIFACT_ACCESS' });
  const anotherProcess = createArtifactAccess({ origin, ttlMs: 1000, clock: () => now });
  assert.throws(() => anotherProcess.authorize(url, image), { code: 'INVALID_ARTIFACT_ACCESS' });
  now += 1000;
  assert.throws(() => access.authorize(url, image), { code: 'ARTIFACT_URL_EXPIRED' });
});

test('artifact signature rejects missing, extra, duplicate, malformed, and modified credentials', () => {
  const now = 1800000000000;
  const access = createArtifactAccess({ origin, ttlMs: 1000, clock: () => now });
  const uri = access.issue('job-one', image);
  const mutations = [
    url => { url.search = ''; },
    url => { url.searchParams.delete('expires'); },
    url => { url.searchParams.delete('signature'); },
    url => { url.searchParams.set('signature', '0'.repeat(64)); },
    url => { url.searchParams.set('signature', 'short'); },
    url => { url.searchParams.set('expires', String(now + 2000)); },
    url => { url.searchParams.set('expires', 'Infinity'); },
    url => { url.searchParams.set('expires', '9007199254740992'); },
    url => { url.searchParams.append('expires', String(now + 1000)); },
    url => { url.searchParams.append('signature', '0'.repeat(64)); },
    url => { url.searchParams.set('apiToken', TOKEN); },
  ];
  for (const mutate of mutations) {
    const url = new URL(uri); mutate(url);
    assert.throws(() => access.authorize(url, image), { code: 'INVALID_ARTIFACT_ACCESS' });
  }
  assert.throws(() => normalizeConfig({ artifactUrlTtlMs: 999 }));
  assert.throws(() => normalizeConfig({ artifactUrlTtlMs: 900001 }));
});

test('signed URLs enable browser-style artifact GET without authorizing API access', async t => {
  let now = Date.now();
  const h = await harness(t, { clock: () => now, config: { artifactUrlTtlMs: 1000 } });
  const p = await plan(h.service);
  const submitted = await apply(h.service, p);
  const done = await waitJob(h.service, submitted.body.id);
  assert.equal(done.status, 'succeeded');
  const uri = done.artifacts.find(artifact => artifact.id === 'image').uri;
  assert.ok(!uri.includes(TOKEN));
  const url = new URL(uri);
  const browser = await fetch(uri, { headers: { origin: 'https://viewer.example' } });
  assert.equal(browser.status, 200);
  assert.equal(browser.headers.get('content-type'), 'image/png');
  assert.equal(browser.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(browser.headers.get('access-control-allow-origin'), '*');
  assert.equal(browser.headers.get('access-control-allow-credentials'), null);
  assert.equal(browser.headers.get('cache-control'), 'no-store');
  assert.equal(browser.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(browser.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await browser.arrayBuffer()).readUInt32BE(0), 0x89504e47);
  assert.equal((await fetch(`${url.origin}${url.pathname}`)).status, 401);
  assert.equal((await fetch(`${url.origin}${url.pathname}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  const missing = new URL(uri); missing.searchParams.delete('signature');
  assert.equal((await fetch(missing)).status, 401);
  const tampered = new URL(uri); tampered.searchParams.set('signature', '0'.repeat(64));
  assert.equal((await fetch(tampered)).status, 401);
  const otherArtifact = new URL(uri); otherArtifact.pathname = otherArtifact.pathname.replace(/\/image$/, '/trace');
  assert.equal((await fetch(otherArtifact)).status, 401);
  const otherJob = new URL(uri); otherJob.pathname = '/v1/artifacts/nonexistent/image';
  assert.equal((await fetch(otherJob)).status, 401);
  assert.equal((await fetch(`${url.origin}/v1/capabilities${url.search}`)).status, 400);
  assert.equal((await fetch(`${url.origin}/v1/capabilities`, { headers: { authorization: `Bearer ${url.searchParams.get('signature')}` } })).status, 401);
  assert.equal((await fetch(uri, { method: 'HEAD' })).status, 400);
  assert.equal((await fetch(uri, { method: 'POST' })).status, 400);
  now += 1001;
  const expired = await fetch(uri);
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, 'ARTIFACT_URL_EXPIRED');
  const refresh = await request(h.service, 'GET', `/v1/deployment-jobs/${done.id}`);
  assert.equal(refresh.status, 200);
  const refreshed = refresh.body.artifacts.find(artifact => artifact.id === 'image').uri;
  assert.notEqual(refreshed, uri);
  assert.equal((await fetch(refreshed)).status, 200);
});
