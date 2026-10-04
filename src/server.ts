/** HTTP API：单条航线、按比例取点、批量、反向核对、历史、导出 */
import * as http from "node:http";
import { DEFAULT_DB_PATH, RouteStore } from "./db";
import { ErrorCode, GeoError, MAX_BATCH } from "./geo";
import { computeRoute, pointAt, RouteReport } from "./route";

const REVERSE_TOL = 1e-9;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, status: number, code: ErrorCode, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) reject(new GeoError("LIMIT_EXCEEDED", "请求体过大"));
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new GeoError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function statusOf(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND": return 404;
    case "AMBIGUOUS_ANTIPODAL": return 422;
    case "LIMIT_EXCEEDED": return 413;
    default: return 400;
  }
}

function reverseCheck(report: RouteReport) {
  const reversed = computeRoute({
    from: report.to, to: report.from,
    radius: report.radius, segments: report.segments,
  });
  const distOk = Math.abs(reversed.totalDistance - report.totalDistance) <=
    REVERSE_TOL * Math.max(1, report.totalDistance);
  let maxDev = 0;
  for (let i = 0; i < report.samples.length; i++) {
    const a = report.samples[i];
    const b = reversed.samples[report.samples.length - 1 - i];
    const dev = Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lon - b.lon));
    if (dev > maxDev) maxDev = dev;
  }
  const samplesOk = maxDev <= 1e-6;
  return {
    distanceEqual: distOk,
    distanceDiff: Math.abs(reversed.totalDistance - report.totalDistance),
    samplesReversed: samplesOk,
    maxSampleDeviationDeg: maxDev,
    pass: distOk && samplesOk,
    reversedReport: reversed,
  };
}

export function createServer(store: RouteStore): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/routes") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const report = computeRoute(body);
        const id = store.save(report);
        return sendJson(res, 201, { ok: true, id, report });
      }
      if (req.method === "POST" && url.pathname === "/api/routes/batch") {
        const body = (await readBody(req)) as { items?: unknown };
        if (!Array.isArray(body.items)) {
          return sendError(res, 400, "BAD_REQUEST", "需要 items 数组");
        }
        if (body.items.length > MAX_BATCH) {
          return sendError(res, 413, "LIMIT_EXCEEDED", `批量上限 ${MAX_BATCH} 条`);
        }
        const results = body.items.map((item, index) => {
          try {
            const report = computeRoute(item as Record<string, unknown>);
            const id = store.save(report);
            return { index, ok: true as const, id, report };
          } catch (e) {
            const ge = e instanceof GeoError ? e : new GeoError("BAD_REQUEST", String(e));
            return { index, ok: false as const, error: { code: ge.code, message: ge.message } };
          }
        });
        return sendJson(res, 200, { ok: true, results });
      }
      if (req.method === "POST" && url.pathname === "/api/point-at") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return sendJson(res, 200, { ok: true, result: pointAt(body) });
      }
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "routes" && parts.length === 2) {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return sendJson(res, 200, { ok: true, routes: store.list(limit, offset) });
      }
      if (parts[0] === "api" && parts[1] === "routes" && parts.length >= 3) {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) return sendError(res, 400, "BAD_REQUEST", "id 必须是整数");
        const row = store.get(id);
        if (!row) return sendError(res, 404, "NOT_FOUND", `航线 ${id} 不存在`);
        if (req.method === "GET" && parts.length === 3) {
          return sendJson(res, 200, { ok: true, route: row });
        }
        if (req.method === "GET" && parts[3] === "export") {
          const data = JSON.stringify(row, null, 2);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="route-${id}.json"`,
          });
          return res.end(data);
        }
        if (req.method === "POST" && parts[3] === "reverse-check") {
          return sendJson(res, 200, { ok: true, check: reverseCheck(row.report) });
        }
      }
      return sendError(res, 404, "NOT_FOUND", "路由不存在");
    } catch (e) {
      if (e instanceof GeoError) return sendError(res, statusOf(e.code), e.code, e.message);
      return sendError(res, 500, "BAD_REQUEST", String(e));
    }
  });
}

export function startServer(port?: number): Promise<number> {
  const store = new RouteStore(process.env.ROUTE_DB ?? DEFAULT_DB_PATH);
  const server = createServer(store);
  const wanted = port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
  return new Promise((resolve) => {
    server.listen(wanted, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : wanted;
      console.log(`API 服务已启动: http://127.0.0.1:${actual}  (数据库: ${process.env.ROUTE_DB ?? DEFAULT_DB_PATH})`);
      resolve(actual);
    });
  });
}

if (require.main === module) {
  void startServer();
}
