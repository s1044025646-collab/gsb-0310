import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { computeRoute } from '../dist/service.js';
import { RouteStore } from '../dist/db.js';

const dbPath = join(process.cwd(), 'data', 'demo.db');
rmSync(dbPath, { force: true });

let store = new RouteStore(dbPath);

function show(title: string, r: ReturnType<typeof computeRoute>) {
  console.log(`\n=== ${title} ===`);
  console.log(`状态=${r.status} 角距=${r.angularDistanceDeg?.toFixed(6)}° 距离=${r.distance?.toFixed(9)} 航向=${r.bearing.status}`);
  console.log('  i      t          lat            lon        distance');
  for (const s of r.samples) {
    console.log(
      `  ${s.index}  ${s.t.toFixed(3).padEnd(8)}  ${s.lat.toFixed(7).padStart(11)}  ${s.lon.toFixed(7).padStart(11)}  ${s.distance.toFixed(7)}`,
    );
  }
  for (const d of r.diagnostics ?? []) console.log('  诊断:', d);
}

console.log('规则版本 sphere-v1，半径单位与距离一致（演示取半径=1）');

const r1 = computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 90 }, radius: 1, segments: 4 });
const id1 = store.save(r1);
show(`赤道 0→90（期望距离 π/2=${(Math.PI / 2).toFixed(9)}，中点 45°），id=${id1}`, r1);

const r2 = computeRoute({ from: { lat: 0, lon: 179 }, to: { lat: 0, lon: -179 }, radius: 1, segments: 2 });
const id2 = store.save(r2);
show(`跨日期变更线 179→-179（期望 2° 短弧=${((2 * Math.PI) / 180).toFixed(9)}），id=${id2}`, r2);

const r3 = computeRoute({ from: { lat: 70, lon: -120 }, to: { lat: 85, lon: 60 }, radius: 1, segments: 4 });
const id3 = store.save(r3);
show(`接近极点航线 (70,-120)→(85,60)，id=${id3}`, r3);

const r4 = computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 0 }, radius: 1, segments: 2 });
store.save(r4);
show('重复点', r4);

const r5 = computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 180 }, radius: 1, segments: 2 });
store.save(r5);
show('对跖点（歧义诊断）', r5);

const r6 = computeRoute({ from: { lat: 20, lon: 10 }, to: { lat: 60, lon: 100 }, radius: 1, segments: 3 });
const r6b = computeRoute({ from: { lat: 20, lon: 10 }, to: { lat: 60, lon: 100 }, radius: 2, segments: 3 });
store.save(r6);
store.save(r6b);
console.log(`\n=== 半径倍增：距离 ${r6.distance!.toFixed(9)} -> ${r6b.distance!.toFixed(9)}（坐标不变）===`);

store.close();

// 模拟重启：重新打开同一个 SQLite 文件读取旧报告
store = new RouteStore(dbPath);
const reloaded = store.get(id1)!;
const ok =
  Math.abs(reloaded.result.distance! - r1.distance!) < 1e-12 &&
  reloaded.result.samples.length === r1.samples.length;
console.log(`\n=== 重启后读取 id=${id1}：距离仍为 ${reloaded.result.distance!.toFixed(9)}，校验 ${ok ? '通过' : '失败'} ===`);
store.close();
