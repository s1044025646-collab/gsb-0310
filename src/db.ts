/** SQLite 持久化：保存端点、半径、分段数、规则版本与完整结果快照 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { RouteReport } from "./route";

export interface RouteRow {
  id: number;
  createdAt: string;
  rulesVersion: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  radius: number;
  segments: number;
  report: RouteReport;
}

export class RouteStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        from_lat REAL NOT NULL,
        from_lon REAL NOT NULL,
        to_lat REAL NOT NULL,
        to_lon REAL NOT NULL,
        radius REAL NOT NULL,
        segments INTEGER NOT NULL,
        report_json TEXT NOT NULL
      )
    `);
  }

  save(report: RouteReport): number {
    const stmt = this.db.prepare(`
      INSERT INTO routes
        (created_at, rules_version, from_lat, from_lon, to_lat, to_lon, radius, segments, report_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      new Date().toISOString(),
      report.rulesVersion,
      report.from.lat, report.from.lon,
      report.to.lat, report.to.lon,
      report.radius, report.segments,
      JSON.stringify(report),
    );
    return Number(res.lastInsertRowid);
  }

  get(id: number): RouteRow | null {
    const row = this.db.prepare("SELECT * FROM routes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : null;
  }

  list(limit = 50, offset = 0): RouteRow[] {
    const rows = this.db
      .prepare("SELECT * FROM routes ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Record<string, unknown>[];
    return rows.map(toRow);
  }

  close(): void {
    this.db.close();
  }
}

function toRow(r: Record<string, unknown>): RouteRow {
  return {
    id: Number(r.id),
    createdAt: String(r.created_at),
    rulesVersion: String(r.rules_version),
    fromLat: Number(r.from_lat),
    fromLon: Number(r.from_lon),
    toLat: Number(r.to_lat),
    toLon: Number(r.to_lon),
    radius: Number(r.radius),
    segments: Number(r.segments),
    report: JSON.parse(String(r.report_json)) as RouteReport,
  };
}

export const DATA_DIR = path.join(process.cwd(), "data");
export const DEFAULT_DB_PATH = path.join(DATA_DIR, "routes.db");
