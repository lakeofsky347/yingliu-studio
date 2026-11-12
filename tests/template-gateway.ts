import { createServer, type IncomingMessage } from 'node:http';
import { pngFixture } from './media-gateway.ts';

/** Test-only HTTP server imitating async provider shapes (DashScope, Kling, Replicate, Ark) and binary audio APIs. No paid service. */
export interface TemplateRequest { method: string; path: string; headers: IncomingMessage['headers']; body: unknown }
export async function startTemplateGateway(options: { pollsBeforeDone?: number; video?: Buffer; audio?: Buffer; failStatus?: boolean } = {}) {
  const requests: TemplateRequest[] = [], polls = new Map<string, number>(); let next = 0;
  const video = options.video ?? Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40)]);
  const audio = options.audio ?? Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part as Buffer);
    const text = Buffer.concat(parts).toString('utf8'); let body: unknown = undefined; try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    const url = new URL(req.url ?? '/', 'http://x'); requests.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body });
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const done = (id: string) => { const n = (polls.get(id) ?? 0) + 1; polls.set(id, n); return n > (options.pollsBeforeDone ?? 2); };
    if (url.pathname.startsWith('/files/')) { const kind = url.pathname.split('/')[2]; res.writeHead(200, { 'content-type': kind === 'video.mp4' ? 'video/mp4' : kind === 'image.png' ? 'image/png' : 'audio/mpeg' }); res.end(kind === 'video.mp4' ? video : kind === 'image.png' ? pngFixture : audio); return; }
    if (req.method === 'GET' && url.pathname === '/') return json(404, { message: 'root' });
    if (req.method === 'GET' && url.pathname.endsWith('/denied/')) return json(401, {});
    // DashScope style
    if (req.method === 'POST' && url.pathname.startsWith('/api/v1/services/aigc/')) { const id = 'ds-' + (++next); return json(200, { output: { task_id: id, task_status: 'PENDING' }, request_id: 'r' }); }
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/tasks/')) {
      const id = url.pathname.split('/').pop()!; if (options.failStatus) return json(200, { output: { task_id: id, task_status: 'FAILED', message: 'content blocked' } });
      if (!done(id)) return json(200, { output: { task_id: id, task_status: 'RUNNING' } });
      const isImage = requests.find(r => r.method === 'POST' && r.path.includes('text2image')) && !requests.some(r => r.method === 'POST' && r.path.includes('video-synthesis'));
      return json(200, { output: { task_id: id, task_status: 'SUCCEEDED', ...(isImage ? { results: [{ url: base + '/files/image.png' }] } : { video_url: base + '/files/video.mp4' }) }, usage: { video_count: 1 } });
    }
    // Replicate style (any modality: here audio/music)
    if (req.method === 'POST' && /^\/v1\/models\/.+\/predictions$/.test(url.pathname)) { const id = 'rp-' + (++next); return json(201, { id, status: 'starting' }); }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/predictions/')) { const id = url.pathname.split('/').pop()!; return done(id) ? json(200, { id, status: 'succeeded', output: base + '/files/music.mp3' }) : json(200, { id, status: 'processing' }); }
    if (req.method === 'POST' && /^\/v1\/predictions\/.+\/cancel$/.test(url.pathname)) return json(200, { status: 'canceled' });
    // Kling style
    if (req.method === 'POST' && url.pathname === '/v1/videos/text2video') return json(200, { code: 0, data: { task_id: 'kl-' + (++next), task_status: 'submitted' } });
    if (req.method === 'GET' && url.pathname.startsWith('/v1/videos/text2video/')) { const id = url.pathname.split('/').pop()!; return done(id) ? json(200, { data: { task_id: id, task_status: 'succeed', task_result: { videos: [{ id: 'v', url: base + '/files/video.mp4' }] } } }) : json(200, { data: { task_id: id, task_status: 'processing' } }); }
    // ElevenLabs / OpenAI speech style: binary audio
    if (req.method === 'POST' && (url.pathname === '/v1/sound-generation' || url.pathname === '/v1/audio/speech')) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(audio); return; }
    json(404, { error: 'not found ' + url.pathname });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
