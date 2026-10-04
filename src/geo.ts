/**
 * 球面大圆几何核心。
 * 模型：球形地球，半径 R（公开长度单位，由调用方指定）。
 * 角度一律为度；经纬度输入后规范化为 lat∈[-90,90], lon∈[-180,180)。
 * 极点（|lat|=90）经度规范为 0。
 */

export const RULES_VERSION = "sphere-v1";

/** 角距小于该值（弧度）视为同一点 */
export const EPS_SAME_POINT = 1e-12;
/** 角距与 π 之差小于该值（弧度）视为对跖歧义 */
export const EPS_ANTIPODAL = 1e-9;
/** 纬度与 ±90 之差小于该值（度）视为在极点，起始航向未定义 */
export const EPS_POLE_DEG = 1e-9;

export const MAX_SEGMENTS = 10000;
export const MAX_BATCH = 100;

export type Vec3 = [number, number, number];

export interface LatLon {
  lat: number;
  lon: number;
}

export type ErrorCode =
  | "INVALID_COORD"
  | "INVALID_RADIUS"
  | "INVALID_SEGMENTS"
  | "INVALID_T"
  | "AMBIGUOUS_ANTIPODAL"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "BAD_REQUEST";

export class GeoError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** 经度规范化到 [-180, 180) */
export function normalizeLon(lon: number): number {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  // 处理 -180 与 180 边界：180 -> -180
  if (l === 180) l = -180;
  return l === 0 ? 0 : l; // 消除 -0
}

/** 校验并规范化坐标；极点经度规范为 0 */
export function normalizePoint(p: unknown, name: string): LatLon {
  if (typeof p !== "object" || p === null) {
    throw new GeoError("INVALID_COORD", `${name} 必须是 {lat, lon} 对象`);
  }
  const { lat, lon } = p as Record<string, unknown>;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
    throw new GeoError("INVALID_COORD", `${name} 的 lat/lon 必须是有限数`);
  }
  if (lat < -90 || lat > 90) {
    throw new GeoError("INVALID_COORD", `${name}.lat=${lat} 超出 [-90, 90]`);
  }
  let nLon = normalizeLon(lon);
  if (Math.abs(Math.abs(lat) - 90) < EPS_POLE_DEG) {
    nLon = 0; // 极点经度规范值
  }
  return { lat, lon: nLon };
}

export function validateRadius(radius: unknown): number {
  if (!isFiniteNumber(radius) || radius <= 0) {
    throw new GeoError("INVALID_RADIUS", "radius 必须是正的有限数");
  }
  return radius;
}

export function validateSegments(segments: unknown): number {
  if (!Number.isInteger(segments) || (segments as number) < 1) {
    throw new GeoError("INVALID_SEGMENTS", "segments 必须是 >= 1 的整数");
  }
  if ((segments as number) > MAX_SEGMENTS) {
    throw new GeoError("LIMIT_EXCEEDED", `segments 超过上限 ${MAX_SEGMENTS}`);
  }
  return segments as number;
}

export function validateT(t: unknown): number {
  if (!isFiniteNumber(t) || t < 0 || t > 1) {
    throw new GeoError("INVALID_T", "t 必须是 [0,1] 内的有限数");
  }
  return t;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** 经纬度（度）→ 单位三维向量（地心直角坐标，z 轴指北极） */
export function toVector(p: LatLon): Vec3 {
  const lat = p.lat * D2R;
  const lon = p.lon * D2R;
  const c = Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}

/** 单位三维向量 → 规范化经纬度（度） */
export function toLatLon(v: Vec3): LatLon {
  const len = Math.hypot(v[0], v[1], v[2]);
  const x = v[0] / len, y = v[1] / len, z = v[2] / len;
  const lat = Math.asin(Math.max(-1, Math.min(1, z))) * R2D;
  let lon = Math.atan2(y, x) * R2D;
  lon = normalizeLon(lon);
  if (Math.abs(Math.abs(lat) - 90) < EPS_POLE_DEG) {
    return { lat: Math.sign(lat) * 90, lon: 0 };
  }
  return { lat, lon };
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * 稳定角距：atan2(|a×b|, a·b)，范围 [0, π]。
 * 避免短距离时 acos 点积损失精度。
 */
export function centralAngle(a: Vec3, b: Vec3): number {
  return Math.atan2(norm(cross(a, b)), dot(a, b));
}

/** 球面线性插值（slerp），t∈[0,1]，sigma 为总角距（弧度） */
export function slerp(a: Vec3, b: Vec3, sigma: number, t: number): Vec3 {
  const sinS = Math.sin(sigma);
  const wa = Math.sin((1 - t) * sigma) / sinS;
  const wb = Math.sin(t * sigma) / sinS;
  return [
    wa * a[0] + wb * b[0],
    wa * a[1] + wb * b[1],
    wa * a[2] + wb * b[2],
  ];
}

/**
 * 起始航向（度，0=北，顺时针）。
 * 返回 null 表示未定义（同点或从极点出发）。
 */
export function initialBearing(from: LatLon, to: LatLon): number | null {
  if (Math.abs(Math.abs(from.lat) - 90) < EPS_POLE_DEG) return null;
  const la1 = from.lat * D2R, la2 = to.lat * D2R;
  const dLon = (to.lon - from.lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  if (x === 0 && y === 0) return null;
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
