#!/usr/bin/env node
import { join } from 'node:path';
import { RouteStore } from './db.js';
import {
  MAX_BATCH,
  ValidationError,
  computeRoute,
  pointAt,
} from './service.js';

function usage(): void {
  console.log(`用法: gc <命令> [参数]

命令:
  route   --from lat,lon --to lat,lon --radius R --segments N [--json]
  point   --from lat,lon --to lat,lon --radius R --t T
  batch   --file routes.json [--json]
  reverse --from lat,lon --to lat,lon --radius R --segments N
  history [--limit N] [--json]
  get     --id N [--json]
  export  --id N [--out file.json]

环境变量:
  GC_DB   数据库路径（默认 ./data/routes.db）
`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function parseLatLon(s: string): { lat: number; lon: number } {
  const parts = String(s).split(',').map((x) => Number(x.trim()));
  if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x))) {
    throw new ValidationError('INVALID_LAT', `坐标格式应为 lat,lon，收到: ${s}`);
  }
  return { lat: parts[0]!, lon: parts[1]! };
}

function pad(s: string | number, w: number): string {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function printRoute(result: ReturnType<typeof computeRoute>): void {
  console.log(`规则版本: ${result.rulesVersion}  状态: ${result.status}`);
  if (result.angularDistanceRad !== null) {
    console.log(
      `总角距: ${result.angularDistanceRad.toFixed(12)} rad (${result.angularDistanceDeg!.toFixed(9)}°)  总距离: ${result.distance!.toFixed(9)}`,
    );
  }
  console.log(
    `起始航向: ${result.bearing.valueDeg === null ? '未定义(' + result.bearing.status + ')' : result.bearing.valueDeg.toFixed(6) + '°'}`,
  );
  console.log('-'.repeat(78));
  console.log(`${pad('i', 4)} ${pad('t', 10)} ${pad('lat', 16)} ${pad('lon', 16)} ${pad('distance', 22)}`);
  console.log('-'.repeat(78));
  for (const s of result.samples) {
    console.log(
      `${pad(s.index, 4)} ${pad(s.t.toFixed(6), 10)} ${pad(s.lat.toFixed(9), 16)} ${pad(s.lon.toFixed(9), 16)} ${pad(s.distance.toFixed(9), 22)}`,
    );
  }
  for (const d of result.diagnostics ?? []) console.log(`诊断: ${d}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    return;
  }
  const args = parseArgs(rest);
  const dbPath = process.env.GC_DB ?? join(process.cwd(), 'data', 'routes.db');
  const store = new RouteStore(dbPath);

  try {
    if (cmd === 'route') {
      const result = computeRoute({
        from: parseLatLon(String(args.from)),
        to: parseLatLon(String(args.to)),
        radius: Number(args.radius),
        segments: Number(args.segments),
      });
      const id = store.save(result);
      if (args.json) console.log(JSON.stringify({ id, result }, null, 2));
      else {
        console.log(`已保存，id=${id}`);
        printRoute(result);
      }
    } else if (cmd === 'point') {
      const r = pointAt({
        from: parseLatLon(String(args.from)),
        to: parseLatLon(String(args.to)),
        radius: Number(args.radius ?? 1),
        t: Number(args.t),
      });
      if (args.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`位置: lat=${r.lla.lat.toFixed(9)}, lon=${r.lla.lon.toFixed(9)}`);
        console.log(`单位向量: (${r.unit.x.toFixed(9)}, ${r.unit.y.toFixed(9)}, ${r.unit.z.toFixed(9)})`);
        r.steps.forEach((s) => console.log(s));
      }
    } else if (cmd === 'batch') {
      const fs = await import('node:fs');
      const body = JSON.parse(fs.readFileSync(String(args.file ?? 'routes.json'), 'utf8'));
      const items: any[] = body.routes ?? body;
      if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('INVALID_SEGMENTS', '文件需含 routes 数组或本身为数组');
      }
      if (items.length > MAX_BATCH) throw new ValidationError('BATCH_TOO_LARGE', `每批最多 ${MAX_BATCH} 条`);
      const results = items.map((item, index) => {
        try {
          const result = computeRoute(item);
          const id = store.save(result);
          return { index, ok: true, id, result };
        } catch (err) {
          const e = err as ValidationError;
          return { index, ok: false, error: { code: e.code, message: e.message } };
        }
      });
      console.log(JSON.stringify({ count: results.length, results }, null, 2));
    } else if (cmd === 'reverse') {
      const payload = {
        from: parseLatLon(String(args.from)),
        to: parseLatLon(String(args.to)),
        radius: Number(args.radius),
        segments: Number(args.segments),
      };
      const fwd = computeRoute(payload);
      const rev = computeRoute({ ...payload, from: payload.to, to: payload.from });
      console.log('正向距离:', fwd.distance, '反向距离:', rev.distance);
      console.log('距离相等:', Math.abs((fwd.distance ?? 0) - (rev.distance ?? 0)) < 1e-9);
      console.log('反向采样首点:', rev.samples[rev.samples.length - 1]!.lat, rev.samples[rev.samples.length - 1]!.lon);
    } else if (cmd === 'history') {
      const recs = store.list(Number(args.limit ?? 20));
      if (args.json) console.log(JSON.stringify(recs, null, 2));
      else for (const r of recs) console.log(`#${r.id} [${r.created_at}] (${r.from_lat},${r.from_lon}) -> (${r.to_lat},${r.to_lon}) R=${r.radius} N=${r.segments} ${r.rules_version}`);
    } else if (cmd === 'get' || cmd === 'export') {
      const rec = store.get(Number(args.id));
      if (!rec) throw new ValidationError('NOT_FOUND', `id=${args.id} 不存在`);
      const json = JSON.stringify(rec.result, null, 2);
      if (cmd === 'export' && args.out) {
        const fs = await import('node:fs');
        fs.writeFileSync(String(args.out), json);
        console.log(`已导出到 ${args.out}`);
      } else if (args.json || cmd === 'export') {
        console.log(json);
      } else {
        console.log(`id=${rec.id} 创建于 ${rec.created_at}`);
        printRoute(rec.result);
      }
    } else {
      usage();
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  if (err instanceof ValidationError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
  } else if (err instanceof SyntaxError) {
    console.error('错误 [NUMERIC_FAILURE]: JSON 解析失败');
  } else {
    console.error('错误:', (err as Error).message);
  }
  process.exit(1);
});
