import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RouteResult } from './service.js';

export interface RouteRecord {
  id: number;
  created_at: string;
  from_lat: number;
  from_lon: number;
  to_lat: number;
  to_lon: number;
  radius: number;
  segments: number;
  rules_version: string;
  result: RouteResult;
}

export class RouteStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        from_lat REAL NOT NULL,
        from_lon REAL NOT NULL,
        to_lat REAL NOT NULL,
        to_lon REAL NOT NULL,
        radius REAL NOT NULL,
        segments INTEGER NOT NULL,
        rules_version TEXT NOT NULL,
        result TEXT NOT NULL
      );
    `);
  }

  save(result: RouteResult): number {
    const stmt = this.db.prepare(`
      INSERT INTO routes (from_lat, from_lon, to_lat, to_lon, radius, segments, rules_version, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      result.from.lat,
      result.from.lon,
      result.to.lat,
      result.to.lon,
      result.radius,
      result.segments,
      result.rulesVersion,
      JSON.stringify(result),
    );
    return Number(info.lastInsertRowid);
  }

  get(id: number): RouteRecord | null {
    const row = this.db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as any | undefined;
    if (!row) return null;
    return { ...row, result: JSON.parse(row.result) } as RouteRecord;
  }

  list(limit = 50, offset = 0): Array<Omit<RouteRecord, 'result'>> {
    const rows = this.db
      .prepare(
        'SELECT id, created_at, from_lat, from_lon, to_lat, to_lon, radius, segments, rules_version FROM routes ORDER BY id DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as any[];
    return rows as Array<Omit<RouteRecord, 'result'>>;
  }

  close(): void {
    this.db.close();
  }
}
