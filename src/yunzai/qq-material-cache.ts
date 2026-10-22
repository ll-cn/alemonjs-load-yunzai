import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultCode } from 'alemonjs';
import type { MediaResource, useMedia } from 'alemonjs';

const MAX_BYTES = 10 * 1024 * 1024;
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const OWN_LIMIT = 50;

type Client = Pick<ReturnType<typeof useMedia>[0], 'upload' | 'list' | 'delete'>;
type Entry = { hash: string; resource: MediaResource; sends: number; lastUsed: number; expiresAt: number };
type State = { version: 1; botId: string; entries: Entry[] };
type Image = { hash: string; bytes: Buffer; ext: string };

/** Only explicit platform rejections are safe to retry; never retry an uncertain send. */
export function materialErrorCode(value: any): number | undefined {
  if (Array.isArray(value)) {
    if (value.some(item => item?.code === ResultCode.Ok)) {
      return undefined;
    }

    return value.map(materialErrorCode).find(code => code !== undefined);
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const code = Number(value.code);

  if (code >= 40035001 && code <= 40035010) {
    return code;
  }

  return materialErrorCode(value.data) ?? materialErrorCode(value.response?.data) ?? materialErrorCode(value.cause) ?? materialErrorCode(value.message);
}

function unwrap<T>(result: { code: number; data: T }): T {
  if (result.code !== ResultCode.Ok || !result.data) {
    throw Object.assign(new Error('QQ material operation failed'), { cause: result });
  }

  return result.data;
}

/** Content identity, not filenames or URLs: a changed panel must be uploaded again. */
export async function readMaterialImage(source: string): Promise<Image> {
  let bytes: Buffer;

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(20_000) });

    if (!response.ok || !response.body) {
      throw new Error('Image download failed');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;

    try {
      while (true) {
        const part = await reader.read();

        if (part.done) {
          break;
        }
        length += part.value.length;
        if (length > MAX_BYTES) {
          throw new Error('Markdown image exceeds 10 MiB');
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      await reader.cancel();
    }
    bytes = Buffer.concat(chunks);
  } else if (source.startsWith('file://')) {
    const path = fileURLToPath(source);
    const info = await stat(path);

    if (!info.isFile() || info.size > MAX_BYTES) {
      throw new Error('Invalid Markdown image file');
    }
    bytes = await readFile(path);
  } else {
    const data = source.replace(/^base64:\/\//, '').replace(/^data:image\/[a-z+.-]+;base64,/i, '');

    if (data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error('Invalid or oversized Markdown image data');
    }
    bytes = Buffer.from(data, 'base64');
  }
  if (!bytes.length || bytes.length > MAX_BYTES) {
    throw new Error('Markdown image exceeds 10 MiB');
  }
  const ext = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'jpeg'
      : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
        ? 'gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'webp'
          : undefined;

  if (!ext) {
    throw new Error('Markdown image format must be PNG, JPEG, GIF or WebP');
  }

  return { hash: createHash('sha256').update(bytes).digest('hex'), bytes, ext };
}

/** Per-bot persistent metadata only. All prepare/send/evict work is serialized in this process. */
export class QQMaterialCache {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: string,
    private readonly warn: (message: string) => void,
    private readonly now = Date.now
  ) {}

  async run<T>(botId: string, task: (session: QQMaterialSession) => Promise<T>, client: Client): Promise<T> {
    const previous = this.queues.get(botId) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        const filename = join(this.directory, `${createHash('sha256').update(botId).digest('hex')}.json`);
        const state: State = { version: 1, botId, entries: [] };

        try {
          if ((await stat(filename)).size > 1024 * 1024) {
            throw new Error('Oversized material cache');
          }
          const saved = JSON.parse(await readFile(filename, 'utf8')) as State;

          if (saved.version !== 1 || saved.botId !== botId || !Array.isArray(saved.entries) || saved.entries.length > OWN_LIMIT) {
            throw new Error('Invalid material cache');
          }
          state.entries = saved.entries.filter(entry => {
            return (
              /^[a-f0-9]{64}$/.test(entry.hash) &&
              validResource(entry.resource, botId) &&
              Number.isSafeInteger(entry.sends) &&
              entry.sends >= 0 &&
              Number.isFinite(entry.lastUsed) &&
              Number.isFinite(entry.expiresAt)
            );
          });
        } catch (error: any) {
          if (error?.code !== 'ENOENT') {
            this.warn('QQ 素材缓存无法读取，将仅管理本次新建的素材');
          }
        }
        const save = async () => {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          const temp = `${filename}.${randomUUID()}.tmp`;

          await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
          await rename(temp, filename);
        };

        return await task(new QQMaterialSession(state, client, save, this.now, this.warn));
      });

    this.queues.set(botId, work);
    try {
      return await work;
    } finally {
      if (this.queues.get(botId) === work) {
        this.queues.delete(botId);
      }
    }
  }
}

function validResource(resource: MediaResource, botId: string): boolean {
  return (
    resource?.kind === 'media-resource' &&
    resource.type === 'image' &&
    resource.usage === 'markdown' &&
    resource.owner?.platform === 'qq-bot' &&
    resource.owner.botId === botId &&
    Boolean(resource.id) &&
    /^qqbot-media:\/\/image\/v1\/[A-Za-z0-9_-]+$/.test(resource.reference)
  );
}

class QQMaterialSession {
  constructor(
    private readonly state: State,
    private readonly client: Client,
    private readonly save: () => Promise<void>,
    private readonly now: () => number,
    private readonly warn: (message: string) => void
  ) {}

  private async list(): Promise<{ total: number; resources: Map<string, MediaResource> }> {
    const resources = new Map<string, MediaResource>();
    let cursor: string | undefined;
    let total = 0;
    const cursors = new Set<string>();

    do {
      const page = unwrap(await this.client.list({ usage: 'markdown', cursor }));

      for (const resource of page.Items) {
        if (!validResource(resource, this.state.botId)) {
          throw new Error('Invalid material listing');
        }
        resources.set(resource.id, resource);
      }
      total = Math.max(total, page.Total ?? resources.size);
      cursor = page.NextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) {
        throw new Error('Invalid material pagination');
      }
      if (cursor) {
        cursors.add(cursor);
      }
    } while (cursor);
    // Do not adopt or delete resources created by other plugins.
    this.state.entries = this.state.entries.filter(entry => resources.has(entry.resource.id));
    for (const entry of this.state.entries) {
      const expiresAt = resources.get(entry.resource.id)?.expiration?.expiresAt;

      if (expiresAt) {
        entry.expiresAt = expiresAt;
      }
    }

    return { total: Math.max(total, resources.size), resources };
  }

  private async remove(entry: Entry): Promise<void> {
    const result = await this.client.delete(entry.resource);

    if (result.code !== ResultCode.Ok && materialErrorCode(result) !== 40035008) {
      unwrap(result);
    }
    this.state.entries = this.state.entries.filter(item => item !== entry);
    await this.save();
  }

  async prepare(sources: string[]): Promise<{ references: string[]; entries: Entry[] }> {
    // Validate every image before any upload or eviction; deduplicate within a message.
    if (sources.length > OWN_LIMIT) {
      throw new Error('Too many Markdown images in one reply');
    }
    const images: Image[] = [];
    let bytes = 0;

    for (const source of sources) {
      const image = await readMaterialImage(source);

      bytes += image.bytes.length;
      if (bytes > 20 * 1024 * 1024) {
        throw new Error('Markdown reply image data exceeds 20 MiB');
      }
      images.push(image);
    }
    const wanted = new Set(images.map(image => image.hash));
    let listing: Awaited<ReturnType<QQMaterialSession['list']>> | undefined;
    const used: Entry[] = [];

    for (const image of images) {
      let entry = this.state.entries.find(item => item.hash === image.hash && item.expiresAt > this.now() + 60_000);

      if (!entry) {
        listing ??= await this.list();
        entry = this.state.entries.find(item => item.hash === image.hash && item.expiresAt > this.now() + 60_000);
        if (!entry) {
          await this.save(); // Verify persistence is writable before allocating remote quota.
          const stale = this.state.entries.find(item => item.hash === image.hash);

          if (stale) {
            await this.remove(stale);
            listing.total--;
          }
          while (this.state.entries.length >= OWN_LIMIT || listing.total >= 100) {
            const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
            const victim = this.state.entries
              .filter(item => !wanted.has(item.hash))
              .sort((a, b) => Number(b.lastUsed < cutoff) - Number(a.lastUsed < cutoff) || a.sends - b.sends || a.lastUsed - b.lastUsed)[0];

            if (!victim) {
              throw new Error('QQ material quota is occupied by other resources');
            }
            await this.remove(victim);
            listing.total--;
          }
          // A fresh filename bypasses the SDK's own stale cache after external deletion.
          const resource = unwrap(
            await this.client.upload({
              type: 'image',
              usage: 'markdown',
              data: image.bytes.toString('base64'),
              name: `ly-${image.hash.slice(0, 16)}-${randomUUID()}.${image.ext}`
            })
          );

          if (!validResource(resource, this.state.botId)) {
            throw new Error('Invalid material upload result');
          }
          const window = Math.min(WINDOW_MS, (resource.expiration?.windowSeconds ?? WINDOW_MS / 1000) * 1000);

          entry = { hash: image.hash, resource, sends: 0, lastUsed: 0, expiresAt: resource.expiration?.expiresAt ?? this.now() + window };
          this.state.entries.push(entry);
          listing.total++;
          await this.save();
        }
      }
      used.push(entry);
    }

    return { references: used.map(entry => entry.resource.reference), entries: [...new Set(used)] };
  }

  async success(entries: Entry[]): Promise<void> {
    for (const entry of entries) {
      entry.sends++;
      entry.lastUsed = this.now();
      entry.expiresAt = this.now() + Math.min(WINDOW_MS, (entry.resource.expiration?.windowSeconds ?? WINDOW_MS / 1000) * 1000);
    }
    // A persistence failure must not turn a successful send into a retry.
    try {
      await this.save();
    } catch {
      this.warn('QQ 消息已发送，但素材使用记录保存失败');
    }
  }

  async invalidate(entries: Entry[]): Promise<void> {
    for (const entry of entries) {
      await this.remove(entry);
    }
  }
}
