import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { AccountStatus, RpaAccount } from '../../src/domain/ops';
import type { RpaAccountClient } from '../application/ports';
import { GuardBlocked, type RpaExecutor, type RpaSendContext, type RpaSendResult } from '../application/rpa-executor';

// 账号池的局域网通信：主控通过 HTTP 把发送指令交给执行端，执行端用本机客户端发，防封规则在执行端按自己的账号计算。
// 只在局域网里用，每个请求都要带执行端的配对口令。

const TOKEN_HEADER = 'x-travelbot-token';
const MAX_BODY_BYTES = 60 * 1024 * 1024;
type WireImage = { ext: string; data: string };
type SendBody = { groupName: string; text: string; images?: WireImage[]; context?: RpaSendContext };
type SendReply = { ok: true; result: RpaSendResult } | { ok: false; error: string; blocked?: boolean };

/** 执行端：监听局域网端口，接收主控的检查和发送请求。 */
export class RpaAgentServer {
  private server: Server | null = null;
  private current: { port: number; token: string } | null = null;
  private lastError = '';

  constructor(private readonly executor: RpaExecutor, private readonly imageDir: string) {}

  get listening() { return Boolean(this.server?.listening); }
  get error() { return this.lastError; }

  /** 按设置启动或停止；端口和口令没变时不重启。 */
  apply(enabled: boolean, port: number, token: string) {
    if (!enabled || !token) { this.stop(); return; }
    if (this.server && this.current?.port === port && this.current.token === token) return;
    this.stop();
    this.lastError = '';
    const server = createServer((req, res) => {
      void this.handle(req, token).then(({ status, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      });
    });
    server.on('error', (error: any) => { this.lastError = error?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请换一个端口` : (error?.message || String(error)); this.server = null; });
    // 发送可能要等群间隔，单个请求最长 10 分钟
    server.requestTimeout = 10 * 60 * 1000;
    server.listen(port, '0.0.0.0');
    this.server = server;
    this.current = { port, token };
  }

  stop() {
    this.server?.close();
    this.server = null;
    this.current = null;
  }

  private async handle(req: IncomingMessage, token: string): Promise<{ status: number; body: unknown }> {
    if (!sameToken(String(req.headers[TOKEN_HEADER] ?? ''), token)) return { status: 401, body: { ok: false, error: '配对口令不对' } };
    const url = new URL(req.url ?? '/', 'http://agent');
    try {
      if (req.method === 'GET' && url.pathname === '/status') return { status: 200, body: await this.executor.check(url.searchParams.get('group') || undefined) };
      if (req.method === 'POST' && url.pathname === '/send') return { status: 200, body: await this.send(JSON.parse(await readBody(req)) as SendBody) };
      return { status: 404, body: { ok: false, error: '未知请求' } };
    } catch (error: any) {
      return { status: 400, body: { ok: false, error: error?.message || String(error) } };
    }
  }

  private async send(body: SendBody): Promise<SendReply> {
    if (!body?.groupName || typeof body.text !== 'string') return { ok: false, error: '请求缺少群名或内容' };
    mkdirSync(this.imageDir, { recursive: true });
    const paths = (body.images ?? []).map(image => {
      const ext = /^\.(png|jpe?g|gif|webp|bmp)$/i.test(image.ext) ? image.ext.toLowerCase() : '.png';
      const path = join(this.imageDir, `${randomUUID()}${ext}`);
      writeFileSync(path, Buffer.from(image.data, 'base64'));
      return path;
    });
    try {
      return { ok: true, result: await this.executor.send(body.groupName, body.text, paths, body.context ?? {}) };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error), blocked: error instanceof GuardBlocked };
    } finally {
      for (const path of paths) { try { unlinkSync(path); } catch { /* 临时图片删不掉不影响 */ } }
    }
  }
}

/** 主控这边的远程账号：把请求转给局域网里的执行端。 */
export class RemoteRpaAccount implements RpaAccountClient {
  constructor(private readonly account: RpaAccount) {}

  async check(groupName?: string): Promise<AccountStatus> {
    const query = groupName ? `?group=${encodeURIComponent(groupName)}` : '';
    return await this.request<AccountStatus>(`/status${query}`, { method: 'GET' }, 15000);
  }

  async send(groupName: string, text: string, images: string[], context: RpaSendContext): Promise<RpaSendResult> {
    const wire: WireImage[] = images.map(path => ({ ext: extname(path), data: readFileSync(path).toString('base64') }));
    const reply = await this.request<SendReply>('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupName, text, images: wire, context }) }, 10 * 60 * 1000);
    if (!reply.ok) throw reply.blocked ? new GuardBlocked(reply.error) : new Error(reply.error);
    return reply.result;
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const { host, port, token, name } = this.account;
    let response: Response;
    try {
      response = await fetch(`http://${host}:${port}${path}`, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error: any) {
      throw new Error(`连不上执行端“${name}”（${host}:${port}），请确认那台电脑开着、程序已切到执行端，并且在同一个局域网：${error?.cause?.code || error?.message || '网络错误'}`);
    }
    if (response.status === 401) throw new Error(`执行端“${name}”拒绝了请求：配对口令不对`);
    try { return await response.json() as T; } catch { throw new Error(`执行端“${name}”返回了无法识别的结果（HTTP ${response.status}）`); }
  }
}

/** 本机的局域网 IPv4 地址，执行端把它告诉主控。 */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((item): item is NonNullable<typeof item> => Boolean(item && item.family === 'IPv4' && !item.internal)).map(item => item.address);
}

function sameToken(given: string, expected: string) {
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('请求太大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
