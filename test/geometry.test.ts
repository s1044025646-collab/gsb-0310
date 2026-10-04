import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoute, pointAt, ValidationError } from '../dist/service.js';
import { normalizeLon, toVec3, vec3ToLLA } from '../dist/geometry.js';

const EPS = 1e-9;

test('赤道 0°→90°，半径 1：距离 π/2，中点 45°', () => {
  const r = computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 90 }, radius: 1, segments: 2 });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.distance! - Math.PI / 2) < EPS);
  assert.ok(Math.abs(r.angularDistanceDeg! - 90) < EPS);
  const mid = r.samples[1]!;
  assert.ok(Math.abs(mid.lon - 45) < EPS);
  assert.ok(Math.abs(mid.lat) < EPS);
  assert.ok(Math.abs(mid.distance - Math.PI / 4) < EPS);
  assert.equal(r.samples.length, 3);
  // 端点包含
  assert.equal(r.samples[0]!.t, 0);
  assert.equal(r.samples[2]!.t, 1);
});

test('179°→-179° 走 2° 短弧，不跨 358°', () => {
  const r = computeRoute({ from: { lat: 0, lon: 179 }, to: { lat: 0, lon: -179 }, radius: 1, segments: 1 });
  assert.ok(Math.abs(r.angularDistanceDeg! - 2) < EPS);
  assert.ok(Math.abs(r.distance! - (2 * Math.PI) / 180) < EPS);
});

test('边界经度 180 与 -180 视为同一点', () => {
  const a = computeRoute({ from: { lat: 10, lon: 180 }, to: { lat: 10, lon: -180 }, radius: 1, segments: 1 });
  assert.equal(a.status, 'ok-zero-distance');
  assert.equal(a.from.lon, -180);
  assert.equal(a.to.lon, -180);
});

test('同经线手算：赤道到北纬 60°，R=2 距离 2π/3', () => {
  const r = computeRoute({ from: { lat: 0, lon: 30 }, to: { lat: 60, lon: 30 }, radius: 2, segments: 4 });
  assert.ok(Math.abs(r.distance! - (2 * Math.PI) / 3) < EPS);
  // 等分段
  const ds = r.samples.slice(1).map((s, i) => s.distance - r.samples[i]!.distance);
  for (const d of ds) assert.ok(Math.abs(d - r.distance! / 4) < EPS);
});

test('半径倍增只改变距离，不改变坐标', () => {
  const r1 = computeRoute({ from: { lat: 20, lon: 10 }, to: { lat: 60, lon: 100 }, radius: 1, segments: 3 });
  const r2 = computeRoute({ from: { lat: 20, lon: 10 }, to: { lat: 60, lon: 100 }, radius: 2, segments: 3 });
  assert.ok(Math.abs(r2.distance! - 2 * r1.distance!) < EPS);
  r1.samples.forEach((s, i) => {
    assert.ok(Math.abs(s.lat - r2.samples[i]!.lat) < EPS);
    assert.ok(Math.abs(s.lon - r2.samples[i]!.lon) < EPS);
  });
});

test('反向路线距离相等、采样顺序相反', () => {
  const payload = { from: { lat: 15, lon: -30 }, to: { lat: 55, lon: 140 }, radius: 3, segments: 5 };
  const fwd = computeRoute(payload);
  const rev = computeRoute({ from: payload.to, to: payload.from, radius: 3, segments: 5 });
  assert.ok(Math.abs(fwd.distance! - rev.distance!) < EPS * Math.max(1, fwd.distance!));
  fwd.samples.forEach((s, i) => {
    const r = rev.samples[rev.samples.length - 1 - i]!;
    assert.ok(Math.abs(s.lat - r.lat) < EPS);
    assert.ok(Math.abs(s.lon - r.lon) < EPS);
  });
});

test('所有采样单位向量长度为 1', () => {
  const r = computeRoute({ from: { lat: -70, lon: 170 }, to: { lat: 80, lon: -10 }, radius: 1, segments: 10 });
  for (const s of r.samples) {
    const n = Math.hypot(s.unit.x, s.unit.y, s.unit.z);
    assert.ok(Math.abs(n - 1) < 1e-12);
  }
});

test('接近极点航线：数值稳定且纬度不越界', () => {
  const r = computeRoute({ from: { lat: 89.9999, lon: 170 }, to: { lat: 89.9999, lon: -170 }, radius: 1, segments: 4 });
  assert.equal(r.status, 'ok');
  for (const s of r.samples) {
    assert.ok(s.lat <= 90 && s.lat >= -90);
    assert.ok(s.lon >= -180 && s.lon < 180, `lon out: ${s.lon}`);
  }
});

test('从极点出发航向标记 undefined-at-pole', () => {
  const r = computeRoute({ from: { lat: 90, lon: 0 }, to: { lat: 0, lon: 0 }, radius: 1, segments: 1 });
  assert.equal(r.bearing.status, 'undefined-at-pole');
  assert.equal(r.bearing.valueDeg, null);
});

test('重复点：零距离、重复采样、航向未定义', () => {
  const r = computeRoute({ from: { lat: 30, lon: 30 }, to: { lat: 30, lon: 30 }, radius: 5, segments: 2 });
  assert.equal(r.status, 'ok-zero-distance');
  assert.equal(r.distance, 0);
  assert.equal(r.bearing.status, 'undefined-zero-distance');
  assert.equal(r.samples.length, 3);
});

test('对跖点返回歧义诊断，不任选弧', () => {
  const r = computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 180 }, radius: 1, segments: 2 });
  assert.equal(r.status, 'ambiguous-antipodal');
  assert.equal(r.samples.length, 0);
  assert.match(r.diagnostics![0]!, /歧义|无法唯一/);
});

test('非法输入拒绝', () => {
  const cases = [
    { from: { lat: 91, lon: 0 }, to: { lat: 0, lon: 0 }, radius: 1, segments: 1 },
    { from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 0 }, radius: 0, segments: 1 },
    { from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 0 }, radius: 1, segments: 0 },
    { from: { lat: NaN, lon: 0 }, to: { lat: 0, lon: 0 }, radius: 1, segments: 1 },
    { from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 0 }, radius: 1, segments: 1.5 },
  ];
  for (const c of cases) assert.throws(() => computeRoute(c), ValidationError);
});

test('point-at 返回单位向量与步骤', () => {
  const p = pointAt({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 90 }, radius: 1, t: 0.5 });
  assert.ok(Math.abs(p.lla.lon - 45) < EPS);
  assert.ok(Math.abs(Math.hypot(p.unit.x, p.unit.y, p.unit.z) - 1) < 1e-12);
  assert.ok(p.steps.length >= 4);
});

test('经度规范化与极点经度', () => {
  assert.equal(normalizeLon(180), -180);
  assert.equal(normalizeLon(-180), -180);
  assert.equal(normalizeLon(181), -179);
  const pole = vec3ToLLA(toVec3({ lat: 90, lon: 45 }));
  assert.equal(pole.lon, 0);
});
