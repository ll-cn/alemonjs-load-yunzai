import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('done without reply retains exact event routing until TTL or Worker exit', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/bridge-context-worker.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bridge context lifecycle passed/);
});

test('QQ media is split from Markdown and buttons in replies and direct sends', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/qq-media-worker.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /QQ media split passed/);
});

test('QQ material cache reuses content, persists statistics and respects quotas', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/qq-material-cache-worker.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 20_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /QQ material cache passed/);
});

test('QQ bridge embeds material references with buttons and safely recovers invalid resources', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/qq-markdown-worker.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 20_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /QQ Markdown material bridge passed/);
});
