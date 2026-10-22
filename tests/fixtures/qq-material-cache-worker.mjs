import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
mock.module('alemonjs', { namedExports: { ResultCode: { Ok: 2000 } } });
const { QQMaterialCache, materialErrorCode, readMaterialImage } = await import('../../lib/yunzai/qq-material-cache.js');
const directory = await mkdtemp(join(tmpdir(), 'yunzai-qq-cache-'));
let now = 1_800_000_000_000;
const warnings = [];
const cache = () => new QQMaterialCache(directory, message => warnings.push(message), () => now);
const image = n => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(String(n))]).toString('base64');
const ok = data => ({ code: 2000, data });
const resource = (botId, id) => ({ kind: 'media-resource', type: 'image', usage: 'markdown', id, reference: `qqbot-media://image/v1/${id}`,
  owner: { platform: 'qq-bot', botId }, expiration: { mode: 'sliding', windowSeconds: 7776000 } });
const clients = new Map();
function client(botId) {
  if (clients.has(botId)) return clients.get(botId);
  const remote = new Map();
  const calls = { uploads: [], deletes: [], lists: 0 };
  let seq = 0;
  const api = {
    async upload(input) {
      assert.match(input.name, /\.[a-z]+$/);
      const entry = resource(botId, `image-${++seq}`);
      remote.set(entry.id, entry);
      calls.uploads.push(input);
      return ok(entry);
    },
    async list() { calls.lists++; return ok({ Items: [...remote.values()], Total: remote.size }); },
    async delete(entry) { calls.deletes.push(entry.id); remote.delete(entry.id); return ok({}); }
  };
  const value = { api, calls, remote };
  clients.set(botId, value);
  return value;
}
const run = (store, botId, sources, success = true) => store.run(botId, async session => {
  const prepared = await session.prepare(sources);
  if (success) await session.success(prepared.entries);
  return prepared.references;
}, client(botId).api);
try {
  let store = cache();
  const first = await run(store, 'a', [image(1)]);
  assert.deepEqual(await run(store, 'a', [`base64://${image(1)}`]), first);
  assert.equal(client('a').calls.uploads.length, 1);
  assert.equal(client('a').calls.lists, 1, 'cache hit requires neither listing nor upload');
  store = cache();
  assert.deepEqual(await run(store, 'a', [image(1)]), first, 'reuse after restart');
  const state = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), 'utf8'));
  assert.equal(state.entries[0].sends, 3);
  assert.ok(!JSON.stringify(state).includes('preview_url'));
  assert.ok(!JSON.stringify(state).includes(image(1)));
  await run(store, 'a', [image(2)]);
  assert.equal(client('a').calls.uploads.length, 2, 'different bytes require a new resource');
  await run(store, 'b', [image(1)]);
  assert.equal(client('b').calls.uploads.length, 1, 'bot ownership is isolated');
  await Promise.all(Array.from({ length: 5 }, () => run(store, 'concurrent', [image(7)])));
  assert.equal(client('concurrent').calls.uploads.length, 1, 'simultaneous same-image sends upload once');

  await run(store, 'dedup', [image(1), image(1)]);
  assert.equal(client('dedup').calls.uploads.length, 1);
  await run(store, 'failed', [image(1)], false);
  await store.run('failed', async session => {
    const prepared = await session.prepare([image(1)]);
    assert.equal(prepared.entries[0].sends, 0, 'failed sends do not count or renew TTL');
  }, client('failed').api);
  now += 91 * 24 * 60 * 60 * 1000;
  await run(store, 'failed', [image(1)]);
  assert.equal(client('failed').calls.uploads.length, 2, 'expired references are replaced');
  assert.notEqual(client('failed').calls.uploads[0].name, client('failed').calls.uploads[1].name);

  for (let i = 0; i < 50; i++) { now++; await run(store, 'bounded', [image(i)]); }
  for (let i = 0; i < 3; i++) await run(store, 'bounded', [image(0)]);
  const hotId = [...client('bounded').remote.keys()][0];
  await run(store, 'bounded', [image(51)]);
  assert.equal(client('bounded').remote.size, 50);
  assert.equal(client('bounded').calls.deletes.length, 1);
  assert.ok(client('bounded').remote.has(hotId), 'frequently used image is retained');

  const full = client('full');
  for (let i = 0; i < 100; i++) full.remote.set(`foreign-${i}`, resource('full', `foreign-${i}`));
  full.api.list = async ({ cursor }) => {
    full.calls.lists++;
    const resources = [...full.remote.values()];
    return ok({ Items: cursor ? resources.slice(50) : resources.slice(0, 50), Total: 100, NextCursor: cursor ? undefined : 'next' });
  };
  await assert.rejects(run(store, 'full', [image(1)]), /quota/);
  assert.equal(full.calls.lists, 2, 'quota accounting reads every page');
  assert.equal(full.calls.deletes.length, 0, 'never evict another plugin resource');
  assert.equal(full.calls.uploads.length, 0, 'do not allocate over server limit');
  await assert.rejects(run(store, 'invalid', ['aGVsbG8=']), /format/);
  assert.equal(client('invalid').calls.uploads.length, 0);
  await assert.rejects(readMaterialImage(Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')), /oversized|exceeds/);
  await assert.rejects(run(store, 'invalid', Array(51).fill(image(1))), /Too many/);
  assert.equal(materialErrorCode([{ code: 4000, message: { code: 40035009 } }]), 40035009, 'SDK puts send errors in message');
  assert.equal(materialErrorCode([{ code: 2000 }, { code: 4000, data: { code: 40035009 } }]), undefined, 'partial success must not retry');
  assert.equal(materialErrorCode({ message: 'timeout' }), undefined);
  const fetchBefore = globalThis.fetch;
  let remoteImage = Buffer.from(image(1), 'base64');
  try {
    globalThis.fetch = async () => new Response(remoteImage);
    const originalHash = (await readMaterialImage('https://example.com/panel')).hash;
    remoteImage = Buffer.from(image(2), 'base64');
    assert.notEqual((await readMaterialImage('https://example.com/panel')).hash, originalHash, 'same URL with changed bytes is a different image');
    remoteImage = Buffer.alloc(10 * 1024 * 1024 + 1);
    await assert.rejects(readMaterialImage('https://example.com/large'), /exceeds/);
  } finally {
    globalThis.fetch = fetchBefore;
  }
  console.log('QQ material cache passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
