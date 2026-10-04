import assert from "node:assert/strict";
import { test } from "node:test";
import { GeoError, normalizeLon, toLatLon, toVector } from "../src/geo";
import { computeRoute, pointAt } from "../src/route";

const TOL = 1e-9;

test("赤道 0 到 90 度：R=1 时长度为 pi/2，中点经度 45 度", () => {
  const r = computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 90 }, radius: 1, segments: 2 });
  assert.ok(Math.abs(r.totalDistance - Math.PI / 2) < TOL);
  assert.ok(Math.abs(r.samples[1].lon - 45) < 1e-9);
  assert.ok(Math.abs(r.samples[1].lat) < 1e-9);
  assert.equal(r.initialBearingDeg, 90);
});

test("同经线手算核对：距离 = 纬度差(弧度) x R", () => {
  const r = computeRoute({ from: { lat: 10, lon: 50 }, to: { lat: 40, lon: 50 }, radius: 6371, segments: 3 });
  const expected = (30 * Math.PI / 180) * 6371;
  assert.ok(Math.abs(r.totalDistance - expected) < 1e-6);
  assert.ok(Math.abs(r.initialBearingDeg!) < 1e-9);
});

test("跨日期变更线走 2 度短弧而非 358 度", () => {
  const r = computeRoute({ from: { lat: 0, lon: 179 }, to: { lat: 0, lon: -179 }, radius: 1, segments: 4 });
  assert.ok(Math.abs(r.totalDistance - 2 * Math.PI / 180) < TOL);
  assert.ok(r.samples[2].lon > 179 || r.samples[2].lon <= -179.5);
});

test("经度规范化到 [-180,180)，-0 消除", () => {
  assert.equal(normalizeLon(180), -180);
  assert.equal(normalizeLon(540), -180);
  assert.equal(normalizeLon(-180), -180);
  assert.equal(Object.is(normalizeLon(-360), -0), false);
});

test("极点经度规范为 0，极点出发航向未定义", () => {
  const r = computeRoute({ from: { lat: 90, lon: 77 }, to: { lat: 80, lon: 0 }, radius: 1, segments: 2 });
  assert.equal(r.from.lon, 0);
  assert.equal(r.bearingStatus, "undefined");
  assert.equal(r.initialBearingDeg, null);
  assert.ok(r.diagnostics.some((d) => d.startsWith("POLE_ORIGIN")));
});

test("相同点：零距离、重复采样、航向未定义", () => {
  const r = computeRoute({ from: { lat: 30, lon: 120 }, to: { lat: 30, lon: 120 }, radius: 5, segments: 4 });
  assert.equal(r.status, "degenerate");
  assert.equal(r.totalDistance, 0);
  assert.equal(r.bearingStatus, "undefined");
  assert.equal(r.samples.length, 5);
  for (const s of r.samples) {
    assert.equal(s.lat, 30);
    assert.equal(s.lon, 120);
    assert.equal(s.distance, 0);
  }
});

test("对跖点返回歧义诊断，不任意选弧", () => {
  assert.throws(
    () => computeRoute({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 180 }, radius: 1, segments: 4 }),
    (e: unknown) => e instanceof GeoError && e.code === "AMBIGUOUS_ANTIPODAL",
  );
});

test("反向路线：距离相等，采样顺序相反", () => {
  const input = { from: { lat: 31.2, lon: 121.5 }, to: { lat: 35.6, lon: 139.7 }, radius: 6371, segments: 10 };
  const a = computeRoute(input);
  const b = computeRoute({ from: input.to, to: input.from, radius: input.radius, segments: input.segments });
  assert.ok(Math.abs(a.totalDistance - b.totalDistance) < 1e-6);
  for (let i = 0; i < a.samples.length; i++) {
    const s1 = a.samples[i];
    const s2 = b.samples[a.samples.length - 1 - i];
    assert.ok(Math.abs(s1.lat - s2.lat) < 1e-9);
    assert.ok(Math.abs(s1.lon - s2.lon) < 1e-9);
  }
});

test("采样单位向量长度为 1，各段弧长相等", () => {
  const r = computeRoute({ from: { lat: -20, lon: 100 }, to: { lat: 45, lon: -30 }, radius: 2, segments: 7 });
  for (const s of r.samples) {
    const v = toVector(s);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
  }
  const segLen = r.totalDistance / 7;
  for (let i = 1; i < r.samples.length; i++) {
    assert.ok(Math.abs(r.samples[i].distance - r.samples[i - 1].distance - segLen) < 1e-9);
  }
});

test("半径倍增只改变距离，不改变坐标", () => {
  const base = { from: { lat: 10, lon: 20 }, to: { lat: -30, lon: 150 }, segments: 6 };
  const a = computeRoute({ ...base, radius: 1 });
  const b = computeRoute({ ...base, radius: 2 });
  assert.ok(Math.abs(b.totalDistance - 2 * a.totalDistance) < 1e-9);
  for (let i = 0; i < a.samples.length; i++) {
    assert.equal(a.samples[i].lat, b.samples[i].lat);
    assert.equal(a.samples[i].lon, b.samples[i].lon);
  }
});

test("point-at 返回单位向量与计算步骤", () => {
  const r = pointAt({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 90 }, t: 0.5 });
  assert.ok(Math.abs(Math.hypot(...r.unitVector) - 1) < 1e-12);
  assert.ok(Math.abs(r.position.lon - 45) < 1e-9);
  assert.ok(r.steps.length >= 4);
});

test("输入校验：非法纬度/经度/半径/分段数被拒绝", () => {
  const ok = { from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 }, radius: 1, segments: 2 };
  assert.throws(() => computeRoute({ ...ok, from: { lat: 91, lon: 0 } }), (e: unknown) => (e as GeoError).code === "INVALID_COORD");
  assert.throws(() => computeRoute({ ...ok, from: { lat: NaN, lon: 0 } }), (e: unknown) => (e as GeoError).code === "INVALID_COORD");
  assert.throws(() => computeRoute({ ...ok, radius: 0 }), (e: unknown) => (e as GeoError).code === "INVALID_RADIUS");
  assert.throws(() => computeRoute({ ...ok, radius: -3 }), (e: unknown) => (e as GeoError).code === "INVALID_RADIUS");
  assert.throws(() => computeRoute({ ...ok, segments: 0 }), (e: unknown) => (e as GeoError).code === "INVALID_SEGMENTS");
  assert.throws(() => computeRoute({ ...ok, segments: 2.5 }), (e: unknown) => (e as GeoError).code === "INVALID_SEGMENTS");
  assert.throws(() => computeRoute({ ...ok, segments: 100001 }), (e: unknown) => (e as GeoError).code === "LIMIT_EXCEEDED");
});

test("toLatLon(toVector(p)) 往返一致（容差）", () => {
  for (const p of [{ lat: 12.3, lon: -45.6 }, { lat: -89.9, lon: 179.9 }, { lat: 0, lon: 0 }]) {
    const q = toLatLon(toVector(p));
    assert.ok(Math.abs(q.lat - p.lat) < 1e-9);
    assert.ok(Math.abs(q.lon - p.lon) < 1e-9);
  }
});
