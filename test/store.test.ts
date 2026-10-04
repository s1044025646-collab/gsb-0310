import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { RouteStore } from "../src/db";
import { computeRoute } from "../src/route";

test("保存后重启（重新打开数据库）可读取原路线，数值不变", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-test-"));
  const dbPath = path.join(dir, "routes.db");
  const report = computeRoute({
    from: { lat: 31.2, lon: 121.5 }, to: { lat: 35.6, lon: 139.7 },
    radius: 6371, segments: 8,
  });
  const store1 = new RouteStore(dbPath);
  const id = store1.save(report);
  store1.close();

  const store2 = new RouteStore(dbPath);
  const row = store2.get(id);
  store2.close();
  assert.ok(row);
  assert.equal(row!.radius, 6371);
  assert.equal(row!.rulesVersion, report.rulesVersion);
  assert.deepEqual(row!.report, report);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("更改半径产生新报告，旧记录不受影响", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-test-"));
  const store = new RouteStore(path.join(dir, "routes.db"));
  const base = { from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 90 }, segments: 4 };
  const id1 = store.save(computeRoute({ ...base, radius: 1 }));
  const id2 = store.save(computeRoute({ ...base, radius: 2 }));
  const r1 = store.get(id1)!;
  const r2 = store.get(id2)!;
  assert.notEqual(id1, id2);
  assert.ok(Math.abs(r1.report.totalDistance - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(r2.report.totalDistance - Math.PI) < 1e-9);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
