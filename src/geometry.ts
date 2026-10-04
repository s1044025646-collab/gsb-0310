/**
 * 球形地球模型核心几何。
 *
 * 约定：
 * - 角度输入输出一律为「度」。
 * - 经度输出规范化到半开区间 [-180, 180)。
 * - 极点（纬度 ±90）经度统一规范为 0。
 * - 半径与距离使用同一种长度单位（调用方负责，如米/公里）。
 */

export const RULES_VERSION = 'sphere-v1';

/** 对跖/近对跖歧义阈值（弧度）：夹角 >= π - ANTIPODAL_EPS 视为短弧不唯一。 */
export const ANTIPODAL_EPS = 1e-9;
/** 零距离阈值（弧度）：夹角 <= ZERO_EPS 视为重合点，航向未定义。 */
export const ZERO_EPS = 1e-12;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export interface LLA {
  lat: number;
  lon: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 经度规范化到半开区间 [-180, 180)：180° 规范为 -180°。 */
export function normalizeLon(lon: number): number {
  let x = lon % 360;
  if (x >= 180) x -= 360;
  else if (x < -180) x += 360;
  return x === 0 ? 0 : x;
}

/**
 * 规范化一个经纬度点。
 * 纬度为 ±90（极点）时经度公开规范值为 0。
 */
export function normalizeLLA(p: LLA): LLA {
  const atPole = Math.abs(Math.abs(p.lat) - 90) < 1e-12;
  return {
    lat: atPole ? (p.lat < 0 ? -90 : 90) : p.lat,
    lon: atPole ? 0 : normalizeLon(p.lon),
  };
}

export function toVec3(p: LLA): Vec3 {
  const lat = p.lat * DEG;
  const lon = p.lon * DEG;
  const cl = Math.cos(lat);
  return {
    x: cl * Math.cos(lon),
    y: cl * Math.sin(lon),
    z: Math.sin(lat),
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vlen(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * 稳定的两单位向量夹角（弧度，范围 0..π）。
 * 使用 atan2(|a×b|, a·b)，避免短距离时 acos 点积损失有效数字。
 */
export function angleBetween(a: Vec3, b: Vec3): number {
  const c = cross(a, b);
  const sinTheta = Math.hypot(c.x, c.y, c.z);
  const cosTheta = dot(a, b);
  return Math.atan2(sinTheta, cosTheta);
}

export type BearingStatus = 'defined' | 'undefined-zero-distance' | 'undefined-at-pole';

export interface BearingResult {
  status: BearingStatus;
  /** 初始航向（度，正北顺时针，[0,360)）；未定义时为 null。 */
  valueDeg: number | null;
}

/**
 * 初始航向（正北顺时针方位角）。
 * 从极点出发时所有方向均为南/北，按公开语义标记 undefined-at-pole。
 */
export function initialBearing(from: LLA, to: LLA, theta: number): BearingResult {
  if (theta <= ZERO_EPS) return { status: 'undefined-zero-distance', valueDeg: null };
  if (Math.abs(Math.abs(from.lat) - 90) < 1e-12) {
    return { status: 'undefined-at-pole', valueDeg: null };
  }
  const phi1 = from.lat * DEG;
  const phi2 = to.lat * DEG;
  const dLon = ((to.lon - from.lon) * DEG);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  let brng = Math.atan2(y, x) * RAD;
  brng = (brng + 360) % 360;
  return { status: 'defined', valueDeg: brng };
}

/**
 * 单位球面短弧插值。
 * omega 为两端点夹角；t∈[0,1]。对短弧（omega<π）使用 slerp，
 * 跨日期变更线时仍位于同一条大圆短弧上，不会绕远。
 */
export function slerpUnit(a: Vec3, b: Vec3, omega: number, t: number): Vec3 {
  if (omega <= ZERO_EPS) return { ...a };
  const s = Math.sin(omega);
  const k0 = Math.sin((1 - t) * omega) / s;
  const k1 = Math.sin(t * omega) / s;
  const v = {
    x: k0 * a.x + k1 * b.x,
    y: k0 * a.y + k1 * b.y,
    z: k0 * a.z + k1 * b.z,
  };
  // 数值归一化，保证单位长度
  const n = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

export function vec3ToLLA(v: Vec3): LLA {
  const norm = Math.hypot(v.x, v.y, v.z);
  const x = v.x / norm;
  const y = v.y / norm;
  const z = v.z / norm;
  const lat = Math.asin(Math.max(-1, Math.min(1, z))) * RAD;
  if (Math.abs(Math.abs(lat) - 90) < 1e-12) {
    return { lat: lat < 0 ? -90 : 90, lon: 0 };
  }
  return { lat, lon: normalizeLon(Math.atan2(y, x) * RAD) };
}
