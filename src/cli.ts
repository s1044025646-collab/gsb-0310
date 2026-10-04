/** CLI：route / point-at / batch / reverse / history / export / demo */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_DB_PATH, RouteStore } from "./db";
import { GeoError } from "./geo";
import { computeRoute, pointAt, RouteReport } from "./route";

function printReport(r: RouteReport, id?: number): void {
  console.log(`规则版本: ${r.rulesVersion}${id !== undefined ? `  航线ID: ${id}` : ""}`);
  console.log(`状态: ${r.status}  航向: ${r.bearingStatus}` +
    (r.initialBearingDeg !== null ? ` (${r.initialBearingDeg.toFixed(4)}°)` : ""));
  console.log(`总角距: ${r.centralAngleRad.toPrecision(12)} rad`);
  console.log(`总距离: ${r.totalDistance.toPrecision(12)} (半径=${r.radius})`);
  for (const d of r.diagnostics) console.log(`诊断: ${d}`);
  console.log("");
  console.log(pad("idx", 5) + pad("t", 8) + pad("lat(°)", 14) + pad("lon(°)", 14) + pad("累计距离", 16));
  console.log("-".repeat(57));
  for (const s of r.samples) {
    console.log(
      pad(String(s.index), 5) +
      pad(s.t.toFixed(4), 8) +
      pad(s.lat.toFixed(6), 14) +
      pad(s.lon.toFixed(6), 14) +
      pad(s.distance.toPrecision(10), 16),
    );
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

function parsePoint(s: string): { lat: number; lon: number } {
  const m = s.split(",").map(Number);
  if (m.length !== 2) throw new GeoError("INVALID_COORD", `坐标格式应为 "lat,lon"，收到: ${s}`);
  return { lat: m[0], lon: m[1] };
}

function arg(args: string[], name: string, def?: string): string {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  if (def !== undefined) return def;
  throw new GeoError("BAD_REQUEST", `缺少参数 --${name}`);
}

function runRoute(args: string[], store: RouteStore): void {
  const report = computeRoute({
    from: parsePoint(arg(args, "from")),
    to: parsePoint(arg(args, "to")),
    radius: Number(arg(args, "radius", "1")),
    segments: Number(arg(args, "segments", "8")),
  });
  const id = args.includes("--save") ? store.save(report) : undefined;
  printReport(report, id);
}

function runPointAt(args: string[]): void {
  const r = pointAt({
    from: parsePoint(arg(args, "from")),
    to: parsePoint(arg(args, "to")),
    t: Number(arg(args, "t")),
  });
  console.log(`t=${r.t}  位置: lat=${r.position.lat.toFixed(6)}°, lon=${r.position.lon.toFixed(6)}°`);
  console.log(`单位向量: [${r.unitVector.map((x) => x.toFixed(8)).join(", ")}]`);
  console.log("计算步骤:");
  for (const s of r.steps) console.log("  " + s);
}

function runBatch(args: string[], store: RouteStore): void {
  const file = arg(args, "file");
  const items = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
  if (!Array.isArray(items)) throw new GeoError("BAD_REQUEST", "批量文件必须是 JSON 数组");
  items.forEach((item, index) => {
    try {
      const report = computeRoute(item as Record<string, unknown>);
      const id = args.includes("--save") ? store.save(report) : undefined;
      console.log(`[${index}] ok  距离=${report.totalDistance.toPrecision(10)}  航向=${report.initialBearingDeg ?? "未定义"}${id !== undefined ? `  id=${id}` : ""}`);
    } catch (e) {
      const ge = e instanceof GeoError ? e : new GeoError("BAD_REQUEST", String(e));
      console.log(`[${index}] 失败  ${ge.code}: ${ge.message}`);
    }
  });
}

function runReverse(args: string[], store: RouteStore): void {
  const id = Number(arg(args, "id"));
  const row = store.get(id);
  if (!row) throw new GeoError("NOT_FOUND", `航线 ${id} 不存在`);
  const r = row.report;
  const rev = computeRoute({ from: r.to, to: r.from, radius: r.radius, segments: r.segments });
  const distDiff = Math.abs(rev.totalDistance - r.totalDistance);
  let maxDev = 0;
  for (let i = 0; i < r.samples.length; i++) {
    const a = r.samples[i];
    const b = rev.samples[r.samples.length - 1 - i];
    maxDev = Math.max(maxDev, Math.abs(a.lat - b.lat), Math.abs(a.lon - b.lon));
  }
  console.log(`正向距离: ${r.totalDistance.toPrecision(12)}`);
  console.log(`反向距离: ${rev.totalDistance.toPrecision(12)}  差值: ${distDiff.toExponential(3)}`);
  console.log(`采样逆序最大偏差: ${maxDev.toExponential(3)}°`);
  console.log(distDiff <= 1e-9 * Math.max(1, r.totalDistance) && maxDev <= 1e-6 ? "核对通过" : "核对失败");
}

function runHistory(args: string[], store: RouteStore): void {
  const rows = store.list(Number(arg(args, "limit", "20")));
  for (const r of rows) {
    console.log(`#${r.id}  ${r.createdAt}  (${r.fromLat},${r.fromLon}) -> (${r.toLat},${r.toLon})  R=${r.radius}  n=${r.segments}  ${r.rulesVersion}`);
  }
  if (rows.length === 0) console.log("(无历史记录)");
}

function runExport(args: string[], store: RouteStore): void {
  const id = Number(arg(args, "id"));
  const row = store.get(id);
  if (!row) throw new GeoError("NOT_FOUND", `航线 ${id} 不存在`);
  const out = arg(args, "out", `route-${id}.json`);
  fs.writeFileSync(out, JSON.stringify(row, null, 2), "utf8");
  console.log(`已导出: ${path.resolve(out)}`);
}

function runDemo(store: RouteStore): void {
  console.log("=== 演示 1: 赤道 lon 0 -> 90, R=1, 8 段 ===");
  const r1 = computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 90 }, radius: 1, segments: 8 });
  printReport(r1, store.save(r1));
  console.log(`\n期望: 总长度=π/2=${(Math.PI / 2).toPrecision(12)}, 中点经度=45°`);

  console.log("\n=== 演示 2: 跨日期变更线 lon 179 -> -179 (2° 短弧) ===");
  const r2 = computeRoute({ from: { lat: 10, lon: 179 }, to: { lat: 10, lon: -179 }, radius: 6371, segments: 4 });
  printReport(r2, store.save(r2));

  console.log("\n=== 演示 3: 接近极点 (89°N) ===");
  const r3 = computeRoute({ from: { lat: 89, lon: 0 }, to: { lat: 89, lon: 120 }, radius: 6371, segments: 6 });
  printReport(r3, store.save(r3));

  console.log("\n=== 演示 4: 退化与歧义 ===");
  const same = computeRoute({ from: { lat: 30, lon: 120 }, to: { lat: 30, lon: 120 }, radius: 1, segments: 4 });
  console.log(`相同点: 状态=${same.status}, 距离=${same.totalDistance}, 航向=${same.bearingStatus}, 诊断=${same.diagnostics[0]}`);
  try {
    computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 180 }, radius: 1, segments: 4 });
  } catch (e) {
    console.log(`对跖点: 拒绝 (${(e as GeoError).code}) ${(e as GeoError).message}`);
  }
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new RouteStore(process.env.ROUTE_DB ?? DEFAULT_DB_PATH);
  try {
    switch (cmd) {
      case "route": return runRoute(args, store);
      case "point-at": return runPointAt(args);
      case "batch": return runBatch(args, store);
      case "reverse": return runReverse(args, store);
      case "history": return runHistory(args, store);
      case "export": return runExport(args, store);
      case "demo": return runDemo(store);
      default:
        console.log(`用法: node dist/src/cli.js <命令> [参数]
  route    --from lat,lon --to lat,lon [--radius 6371] [--segments 8] [--save]
  point-at --from lat,lon --to lat,lon --t 0.5
  batch    --file items.json [--save]
  reverse  --id N
  history  [--limit 20]
  export   --id N [--out file.json]
  demo     运行内置演示`);
    }
  } catch (e) {
    if (e instanceof GeoError) {
      console.error(`错误 [${e.code}] ${e.message}`);
      process.exitCode = 2;
    } else {
      throw e;
    }
  } finally {
    store.close();
  }
}

main();
