/** 航线计算：输入校验 → 角距 → 航向 → 等弧长采样 → 报告 */
import {
  EPS_ANTIPODAL, EPS_SAME_POINT, GeoError, LatLon, RULES_VERSION, Vec3,
  centralAngle, initialBearing, normalizePoint, slerp, toLatLon, toVector,
  validateRadius, validateSegments, validateT,
} from "./geo";

export interface RouteInput {
  from?: unknown;
  to?: unknown;
  radius?: unknown;
  segments?: unknown;
}

export interface SamplePoint {
  index: number;
  t: number;
  lat: number;
  lon: number;
  distance: number;
}

export interface RouteReport {
  rulesVersion: string;
  status: "ok" | "degenerate";
  from: LatLon;
  to: LatLon;
  radius: number;
  segments: number;
  centralAngleRad: number;
  totalDistance: number;
  initialBearingDeg: number | null;
  bearingStatus: "defined" | "undefined";
  diagnostics: string[];
  samples: SamplePoint[];
}

export function computeRoute(input: RouteInput): RouteReport {
  const from = normalizePoint(input.from, "from");
  const to = normalizePoint(input.to, "to");
  const radius = validateRadius(input.radius);
  const segments = validateSegments(input.segments);
  const va = toVector(from);
  const vb = toVector(to);
  const sigma = centralAngle(va, vb);
  const diagnostics: string[] = [];
  if (sigma < EPS_SAME_POINT) {
    diagnostics.push("SAME_POINT: 起终点相同，距离为零，航向未定义");
    const samples: SamplePoint[] = [];
    for (let i = 0; i <= segments; i++) {
      samples.push({ index: i, t: i / segments, lat: from.lat, lon: from.lon, distance: 0 });
    }
    return {
      rulesVersion: RULES_VERSION, status: "degenerate",
      from, to, radius, segments,
      centralAngleRad: 0, totalDistance: 0,
      initialBearingDeg: null, bearingStatus: "undefined",
      diagnostics, samples,
    };
  }
  if (Math.abs(Math.PI - sigma) < EPS_ANTIPODAL) {
    throw new GeoError(
      "AMBIGUOUS_ANTIPODAL",
      `起终点（接近）对跖（角距=${sigma} rad），短弧不唯一，拒绝任意选择`,
    );
  }
  const totalDistance = sigma * radius;
  const bearing = initialBearing(from, to);
  if (bearing === null) {
    diagnostics.push("POLE_ORIGIN: 起点位于极点，起始航向未定义");
  }
  const samples: SamplePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const v = slerp(va, vb, sigma, t);
    const ll = toLatLon(v);
    samples.push({ index: i, t, lat: ll.lat, lon: ll.lon, distance: t * totalDistance });
  }
  return {
    rulesVersion: RULES_VERSION, status: "ok",
    from, to, radius, segments,
    centralAngleRad: sigma, totalDistance,
    initialBearingDeg: bearing,
    bearingStatus: bearing === null ? "undefined" : "defined",
    diagnostics, samples,
  };
}

export interface PointAtResult {
  rulesVersion: string;
  t: number;
  position: LatLon;
  unitVector: Vec3;
  steps: string[];
}

/** 查询比例位置 t 处的单位向量与计算步骤 */
export function pointAt(input: { from?: unknown; to?: unknown; t?: unknown }): PointAtResult {
  const from = normalizePoint(input.from, "from");
  const to = normalizePoint(input.to, "to");
  const t = validateT(input.t);
  const va = toVector(from);
  const vb = toVector(to);
  const sigma = centralAngle(va, vb);
  if (sigma < EPS_SAME_POINT) {
    return {
      rulesVersion: RULES_VERSION, t,
      position: from, unitVector: va,
      steps: ["起终点相同：sigma=0，任意 t 均返回起点单位向量"],
    };
  }
  if (Math.abs(Math.PI - sigma) < EPS_ANTIPODAL) {
    throw new GeoError("AMBIGUOUS_ANTIPODAL", "起终点（接近）对跖，短弧不唯一");
  }
  const v = slerp(va, vb, sigma, t);
  const len = Math.hypot(v[0], v[1], v[2]);
  const u: Vec3 = [v[0] / len, v[1] / len, v[2] / len];
  const pos = toLatLon(u);
  return {
    rulesVersion: RULES_VERSION, t,
    position: pos,
    unitVector: u,
    steps: [
      `1. 经纬度转单位向量: A=(${va.map((x) => x.toFixed(6)).join(", ")}), B=(${vb.map((x) => x.toFixed(6)).join(", ")})`,
      `2. 角距 sigma = atan2(|A×B|, A·B) = ${sigma} rad`,
      `3. slerp: wA=sin((1-t)*sigma)/sin(sigma), wB=sin(t*sigma)/sin(sigma), t=${t}`,
      `4. V = wA*A + wB*B，归一化得单位向量 (${u.map((x) => x.toFixed(6)).join(", ")})`,
      `5. 单位向量转回经纬度: lat=${pos.lat} deg, lon=${pos.lon} deg`,
    ],
  };
}
