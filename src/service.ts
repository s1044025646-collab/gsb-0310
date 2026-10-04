import {
  ANTIPODAL_EPS,
  type LLA,
  RULES_VERSION,
  type Vec3,
  ZERO_EPS,
  angleBetween,
  initialBearing,
  normalizeLLA,
  slerpUnit,
  toVec3,
  vec3ToLLA,
} from './geometry.js';

export { RULES_VERSION } from './geometry.js';

export const MAX_SEGMENTS = 10000;
export const MAX_BATCH = 100;

export type ErrorCode =
  | 'INVALID_LAT'
  | 'INVALID_LON'
  | 'INVALID_RADIUS'
  | 'INVALID_SEGMENTS'
  | 'ANTIPODAL_AMBIGUOUS'
  | 'BATCH_TOO_LARGE'
  | 'INVALID_T'
  | 'NOT_FOUND'
  | 'NUMERIC_FAILURE';

export class ValidationError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RouteInput {
  from: LLA;
  to: LLA;
  radius: number;
  segments: number;
}

export interface SamplePoint {
  index: number;
  t: number;
  lat: number;
  lon: number;
  distance: number;
  unit: Vec3;
}

export interface RouteResult {
  rulesVersion: string;
  status: 'ok' | 'ok-zero-distance' | 'ambiguous-antipodal';
  from: LLA;
  to: LLA;
  radius: number;
  segments: number;
  angularDistanceRad: number | null;
  angularDistanceDeg: number | null;
  distance: number | null;
  bearing: { status: string; valueDeg: number | null };
  samples: SamplePoint[];
  diagnostics?: string[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseCoord(raw: unknown, name: 'lat' | 'lon'): number {
  if (typeof raw === 'string') {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw.trim())) {
      throw new ValidationError(name === 'lat' ? 'INVALID_LAT' : 'INVALID_LON', `${name} 不是合法数字`);
    }
    raw = Number(raw);
  }
  if (!isFiniteNumber(raw)) {
    throw new ValidationError(name === 'lat' ? 'INVALID_LAT' : 'INVALID_LON', `${name} 必须为有限数`);
  }
  if (name === 'lat' && (raw < -90 || raw > 90)) {
    throw new ValidationError('INVALID_LAT', 'lat 必须在 [-90, 90]');
  }
  if (name === 'lon' && (raw < -180 || raw > 180)) {
    throw new ValidationError('INVALID_LON', 'lon 必须在 [-180, 180]');
  }
  return raw as number;
}

export function validateInput(body: any): RouteInput {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('INVALID_LAT', '请求体必须是对象');
  }
  const from = body.from;
  const to = body.to;
  if (!from || !to) {
    throw new ValidationError('INVALID_LAT', '必须提供 from 与 to');
  }
  const radius = body.radius;
  if (!isFiniteNumber(radius) || radius <= 0) {
    throw new ValidationError('INVALID_RADIUS', 'radius 必须为正数（与距离同单位）');
  }
  const segments = body.segments;
  if (!Number.isInteger(segments) || segments < 1 || segments > MAX_SEGMENTS) {
    throw new ValidationError('INVALID_SEGMENTS', `segments 必须为 1..${MAX_SEGMENTS} 的整数`);
  }
  return {
    from: normalizeLLA({ lat: parseCoord(from.lat, 'lat'), lon: parseCoord(from.lon, 'lon') }),
    to: normalizeLLA({ lat: parseCoord(to.lat, 'lat'), lon: parseCoord(to.lon, 'lon') }),
    radius,
    segments,
  };
}

export function computeRoute(raw: any): RouteResult {
  const input = validateInput(raw);
  const { from, to, radius, segments } = input;

  const a = toVec3(from);
  const b = toVec3(to);
  const omega = angleBetween(a, b);

  const base: RouteResult = {
    rulesVersion: RULES_VERSION,
    status: 'ok',
    from,
    to,
    radius,
    segments,
    angularDistanceRad: null,
    angularDistanceDeg: null,
    distance: null,
    bearing: { status: 'undefined-zero-distance', valueDeg: null },
    samples: [],
  };

  if (omega >= Math.PI - ANTIPODAL_EPS) {
    return {
      ...base,
      status: 'ambiguous-antipodal',
      diagnostics: [
        `两端点夹角 ${omega.toExponential(3)} rad 接近 π（阈值 ${ANTIPODAL_EPS}）：存在无穷多条等长大圆短弧，无法唯一确定`,
      ],
    };
  }

  if (omega <= ZERO_EPS) {
    const samples: SamplePoint[] = [];
    for (let i = 0; i <= segments; i++) {
      samples.push({
        index: i,
        t: i / segments,
        lat: from.lat,
        lon: from.lon,
        distance: 0,
        unit: { ...a },
      });
    }
    return {
      ...base,
      status: 'ok-zero-distance',
      angularDistanceRad: 0,
      angularDistanceDeg: 0,
      distance: 0,
      bearing: { status: 'undefined-zero-distance', valueDeg: null },
      samples,
      diagnostics: ['两端点重合：距离为零，采样点重复，起始航向未定义'],
    };
  }

  const distance = radius * omega;
  const bearing = initialBearing(from, to, omega);
  const samples: SamplePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const v = slerpUnit(a, b, omega, t);
    const lla = vec3ToLLA(v);
    if (!Number.isFinite(lla.lat) || !Number.isFinite(lla.lon)) {
      throw new ValidationError('NUMERIC_FAILURE', `第 ${i} 个采样点数值失败`);
    }
    samples.push({
      index: i,
      t,
      lat: lla.lat,
      lon: lla.lon,
      distance: radius * omega * t,
      unit: v,
    });
  }

  return {
    ...base,
    status: 'ok',
    angularDistanceRad: omega,
    angularDistanceDeg: omega * (180 / Math.PI),
    distance,
    bearing: { status: bearing.status, valueDeg: bearing.valueDeg },
    samples,
  };
}

export function pointAt(raw: any): {
  t: number;
  from: LLA;
  to: LLA;
  unit: Vec3;
  lla: LLA;
  steps: string[];
} {
  const input = validateInput({ ...raw, segments: raw.segments ?? 1 });
  const t = raw.t;
  if (!isFiniteNumber(t) || t < 0 || t > 1) {
    throw new ValidationError('INVALID_T', 't 必须在 [0,1]');
  }
  const a = toVec3(input.from);
  const b = toVec3(input.to);
  const omega = angleBetween(a, b);
  if (omega >= Math.PI - ANTIPODAL_EPS) {
    throw new ValidationError('ANTIPODAL_AMBIGUOUS', '对跖点：比例位置不唯一');
  }
  const v = omega <= ZERO_EPS ? { ...a } : slerpUnit(a, b, omega, t);
  return {
    t,
    from: input.from,
    to: input.to,
    unit: v,
    lla: vec3ToLLA(v),
    steps: [
      `1. 经纬度转单位向量：from=(${a.x.toFixed(9)}, ${a.y.toFixed(9)}, ${a.z.toFixed(9)})`,
      `2. atan2(|a×b|, a·b) 得角距 ω=${omega.toFixed(12)} rad`,
      `3. slerp: v = [sin((1-t)ω)/sin(ω)]a + [sin(tω)/sin(ω)]b，t=${t}`,
      `4. 单位化后 v=(${v.x.toFixed(9)}, ${v.y.toFixed(9)}, ${v.z.toFixed(9)})，|v|=${Math.hypot(v.x, v.y, v.z).toFixed(12)}`,
      '5. 反算经纬度并规范化到 [-180,180)，极点经度取 0',
    ],
  };
}
