import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { RouteStore } from './db.js';
import {
  MAX_BATCH,
  ValidationError,
  computeRoute,
  pointAt,
} from './service.js';

export interface AppContext {
  store: RouteStore;
}

function pickFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(preferred ?? 0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('无法获取端口')));
      }
    });
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: any, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function errorBody(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

export function createApp(ctx: AppContext): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, service: 'great-circle', rules: 'sphere-v1' });
      }

      if (req.method === 'POST' && path === '/routes') {
        const body = await readJson(req);
        const result = computeRoute(body);
        const id = ctx.store.save(result);
        return send(res, 200, { ok: true, id, result });
      }

      if (req.method === 'POST' && path === '/point-at') {
        const body = await readJson(req);
        return send(res, 200, { ok: true, ...pointAt(body) });
      }

      if (req.method === 'POST' && path === '/routes/batch') {
        const body = await readJson(req);
        const items: any[] = Array.isArray(body?.routes) ? body.routes : [];
        if (items.length === 0) {
          return send(res, 400, errorBody('INVALID_SEGMENTS', 'routes 必须是非空数组'));
        }
        if (items.length > MAX_BATCH) {
          return send(res, 400, errorBody('BATCH_TOO_LARGE', `每批最多 ${MAX_BATCH} 条`));
        }
        // 逐项约定：保留输入顺序，单项失败不影响其他项。
        const results = items.map((item, index) => {
          try {
            const result = computeRoute(item);
            const id = ctx.store.save(result);
            return { index, ok: true, id, result };
          } catch (err) {
            const e = err as ValidationError;
            return { index, ok: false, error: { code: e.code ?? 'NUMERIC_FAILURE', message: e.message } };
          }
        });
        return send(res, 200, { ok: true, count: results.length, results });
      }

      if (req.method === 'POST' && path === '/routes/reverse-check') {
        const body = await readJson(req);
        const forward = computeRoute(body);
        const reversed = computeRoute({
          from: body.to,
          to: body.from,
          radius: body.radius,
          segments: body.segments,
        });
        const fwdId = ctx.store.save(forward);
        const revId = ctx.store.save(reversed);
        const sameDistance =
          forward.distance !== null &&
          reversed.distance !== null &&
          Math.abs(forward.distance - reversed.distance) <= 1e-9 * Math.max(1, forward.distance);
        const fwdSamples = forward.samples.map((s) => `${s.lat.toFixed(9)},${s.lon.toFixed(9)}`);
        const revSamples = [...reversed.samples]
          .reverse()
          .map((s) => `${s.lat.toFixed(9)},${s.lon.toFixed(9)}`);
        const sameOrder = fwdSamples.every((v, i) => v === revSamples[i]);
        return send(res, 200, {
          ok: true,
          forwardId: fwdId,
          reverseId: revId,
          checks: { distanceEqual: sameDistance, samplesReversed: sameOrder },
          forward,
          reverse: reversed,
        });
      }

      if (req.method === 'GET' && path === '/routes') {
        const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return send(res, 200, { ok: true, routes: ctx.store.list(limit, offset) });
      }

      const idMatch = path.match(/^\/routes\/(\d+)$/);
      if (req.method === 'GET' && idMatch && url.searchParams.get('format') === 'json') {
        const rec = ctx.store.get(Number(idMatch[1]));
        if (!rec) return send(res, 404, errorBody('NOT_FOUND', '路线不存在'));
        return send(res, 200, rec.result);
      }
      if (req.method === 'GET' && idMatch) {
        const rec = ctx.store.get(Number(idMatch[1]));
        if (!rec) return send(res, 404, errorBody('NOT_FOUND', '路线不存在'));
        return send(res, 200, { ok: true, record: rec });
      }

      return send(res, 404, errorBody('NOT_FOUND', '未知路径'));
    } catch (err) {
      if (err instanceof ValidationError) {
        return send(res, 400, errorBody(err.code, err.message));
      }
      if (err instanceof SyntaxError) {
        return send(res, 400, errorBody('NUMERIC_FAILURE', '请求体不是合法 JSON'));
      }
      return send(res, 500, errorBody('NUMERIC_FAILURE', (err as Error).message));
    }
  });
}

async function main(): Promise<void> {
  const dbPath = process.env.GC_DB ?? join(process.cwd(), 'data', 'routes.db');
  const store = new RouteStore(dbPath);
  const preferred = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = await pickFreePort(preferred);
  const server = createApp({ store });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[great-circle] 球面大圆航线服务已启动: http://127.0.0.1:${port}`);
    console.log(`[great-circle] 数据库: ${dbPath}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
