// Pure geometry helpers for the GLB car's wheels. No three.js import: typed arrays in, typed arrays out.
//
// WHY THIS EXISTS
// The BMW GLB has no wheel nodes. The four wheels are merged per material into shared meshes (one tyre mesh with all
// four tyres, one rim mesh with all four rims, ...). To spin a wheel its triangles must first be separated.
// car.js does the three.js side (transforming vertices, building meshes and pivots); this file does the maths:
//
//   locateWheels(tyrePoints)             -> where the four wheels are: centre, axle axis, radius, width
//   splitByWheel(points, index, wheels)  -> which triangles of any merged mesh belong to which wheel
//
// All coordinates are in ONE common frame (the "car frame" of car.js: Y up, the car's length along X or Z, units = metres).
// Nothing here knows about names, materials or three.js, so it can be unit-tested in plain Node.

const DEG = Math.PI / 180;

/** Eigen-decomposition of a symmetric 3x3 matrix (row-major, 9 numbers; modified in place) with Jacobi rotations. */
function jacobi3(a) {
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 40; sweep++) {
    if (Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]) < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-20) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A = A * J
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // A = J^T * A
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) { // V = V * J
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return {
    values: [a[0], a[4], a[8]],
    vectors: [[v[0], v[3], v[6]], [v[1], v[4], v[7]], [v[2], v[5], v[8]]], // vectors[i] belongs to values[i]
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Finds the four wheels from the points of the tyres (all four tyres together, in any order).
 * The car's length is taken as the longer horizontal extent of the tyre points, its width as the other one, and the
 * points are cut into four groups at the middle of both. Each group is one tyre.
 *
 * The axle axis is the direction of least spread of a tyre (a tyre is narrower than it is tall).
 * It is only trusted when it agrees with the car's width axis to within 6 degrees and is clearly the smallest spread;
 * within 2 degrees it is snapped to the width axis: on irregular vertex sets the fit itself is only good to about a
 * degree, and a wrong fit would make the wheel wobble, while a real camber that small is invisible.
 *
 * @param {Float32Array|number[]} pts  x,y,z triples
 * @returns {{ ok: true, wheels: object[], radius: number, lengthAxis: number, widthAxis: number }
 *          | { ok: false, reason: string }}
 */
export function locateWheels(pts) {
  const n = Math.floor(pts.length / 3);
  if (n < 400) return { ok: false, reason: `only ${n} tyre points` };

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const x = pts[i * 3 + k];
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  }
  const lengthAxis = hi[0] - lo[0] >= hi[2] - lo[2] ? 0 : 2;
  const widthAxis = lengthAxis === 0 ? 2 : 0;
  const midL = (lo[lengthAxis] + hi[lengthAxis]) / 2;
  const midW = (lo[widthAxis] + hi[widthAxis]) / 2;

  const groups = [[], [], [], []];
  for (let i = 0; i < n; i++) {
    const g = (pts[i * 3 + lengthAxis] > midL ? 1 : 0) | (pts[i * 3 + widthAxis] > midW ? 2 : 0);
    groups[g].push(i);
  }

  const eL = [0, 0, 0]; eL[lengthAxis] = 1;
  const eW = [0, 0, 0]; eW[widthAxis] = 1;
  const wheels = [];

  for (let g = 0; g < 4; g++) {
    const ids = groups[g];
    if (ids.length < n * 0.1) return { ok: false, reason: `tyre group ${g} has only ${ids.length} of ${n} points` };

    // Covariance -> axis of least spread.
    const mean = [0, 0, 0];
    for (const i of ids) for (let k = 0; k < 3; k++) mean[k] += pts[i * 3 + k];
    for (let k = 0; k < 3; k++) mean[k] /= ids.length;
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const i of ids) {
      const d0 = pts[i * 3] - mean[0], d1 = pts[i * 3 + 1] - mean[1], d2 = pts[i * 3 + 2] - mean[2];
      cov[0] += d0 * d0; cov[1] += d0 * d1; cov[2] += d0 * d2;
      cov[4] += d1 * d1; cov[5] += d1 * d2; cov[8] += d2 * d2;
    }
    cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
    const eig = jacobi3(cov.map((x) => x / ids.length));
    const order = [0, 1, 2].sort((p, q) => eig.values[p] - eig.values[q]);
    let fit = eig.vectors[order[0]];
    if (dot(fit, eW) < 0) fit = [-fit[0], -fit[1], -fit[2]];
    const clear = eig.values[order[0]] < eig.values[order[1]] * 0.8; // least spread must be clearly smaller than the next
    const tilt = Math.acos(Math.min(1, dot(fit, eW))) / DEG;

    let axis, axisSource;
    if (!clear || tilt > 6) { axis = eW; axisSource = 'width-axis (fit rejected)'; }
    else if (tilt < 2) { axis = eW; axisSource = 'width-axis'; }
    else { axis = norm(fit); axisSource = 'fitted'; }

    // In-plane basis: u along the car's length, v = axis x u (close to "up"), then bounding box in (u, v, axis).
    const k = dot(eL, axis);
    const u = norm([eL[0] - k * axis[0], eL[1] - k * axis[1], eL[2] - k * axis[2]]);
    const v = cross(axis, u);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, minA = Infinity, maxA = -Infinity;
    for (const i of ids) {
      const p = [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
      const pu = dot(p, u), pv = dot(p, v), pa = dot(p, axis);
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
      if (pa < minA) minA = pa; if (pa > maxA) maxA = pa;
    }
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2, ca = (minA + maxA) / 2;
    let radius = 0;
    for (const i of ids) {
      const p = [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
      radius = Math.max(radius, Math.hypot(dot(p, u) - cu, dot(p, v) - cv));
    }
    const halfWidth = (maxA - minA) / 2;
    const round = (maxU - minU) / (maxV - minV);
    if (!(radius > 0.15 && radius < 0.8)) return { ok: false, reason: `tyre ${g}: radius ${radius.toFixed(3)} m is not a car wheel` };
    if (!(round > 0.9 && round < 1.1)) return { ok: false, reason: `tyre ${g}: not round (aspect ${round.toFixed(3)})` };
    if (!(halfWidth < radius * 0.8)) return { ok: false, reason: `tyre ${g}: wider than expected (${(halfWidth * 2).toFixed(3)} m)` };

    wheels.push({
      id: g,
      lenSide: g & 1, widSide: (g >> 1) & 1,
      center: [u[0] * cu + v[0] * cv + axis[0] * ca, u[1] * cu + v[1] * cv + axis[1] * ca, u[2] * cu + v[2] * cv + axis[2] * ca],
      axis, u, v, radius, halfWidth,
      tiltDeg: tilt, axisSource,
    });
  }

  const rMin = Math.min(...wheels.map((w) => w.radius)), rMax = Math.max(...wheels.map((w) => w.radius));
  if (rMax / rMin > 1.05) return { ok: false, reason: `tyre radii differ (${rMin.toFixed(3)} .. ${rMax.toFixed(3)} m)` };
  const yMin = Math.min(...wheels.map((w) => w.center[1])), yMax = Math.max(...wheels.map((w) => w.center[1]));
  if (yMax - yMin > 0.03) return { ok: false, reason: `wheel centres are at different heights (${yMin.toFixed(3)} .. ${yMax.toFixed(3)} m)` };

  return {
    ok: true, wheels, lengthAxis, widthAxis,
    radius: wheels.reduce((s, w) => s + w.radius, 0) / 4,
  };
}

/**
 * Assigns every triangle of a merged mesh to the wheel whose cylinder contains its centroid.
 * A triangle that is inside no wheel's cylinder (axially wider than the tyre by axialMargin, radially bigger than the
 * tyre by radialMargin) stays in `rest`, so nothing that is not clearly a wheel part is ever moved.
 * The four wheels are far apart (>= 0.9 m between neighbouring cylinders), so the assignment is never ambiguous.
 *
 * @param {Float32Array|number[]} pos    x,y,z per vertex, already in the common frame
 * @param {ArrayLike<number>} index      triangle list (3 vertex indices per triangle)
 * @param {object[]} wheels              from locateWheels()
 * @returns {{ perWheel: (Uint32Array|null)[], rest: Uint32Array, stats: object[] }}
 *   stats[i] = { tris, ecc: [du, dv] (bbox centre of the assigned vertices from the axle, metres), maxRadius }
 */
export function splitByWheel(pos, index, wheels, { axialMargin = 0.35, radialMargin = 0.08 } = {}) {
  const out = wheels.map(() => []);
  const rest = [];
  const st = wheels.map(() => ({ tris: 0, minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity, maxRadius: 0 }));
  const nTri = Math.floor(index.length / 3);

  for (let t = 0; t < nTri; t++) {
    const i0 = index[t * 3], i1 = index[t * 3 + 1], i2 = index[t * 3 + 2];
    const cx = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3;
    const cy = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3;
    const cz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;

    let best = -1, bestD = Infinity;
    for (let w = 0; w < wheels.length; w++) {
      const { center: c, axis: a, radius, halfWidth } = wheels[w];
      const dx = cx - c[0], dy = cy - c[1], dz = cz - c[2];
      const along = dx * a[0] + dy * a[1] + dz * a[2];
      if (Math.abs(along) > halfWidth + axialMargin) continue;
      const rx = dx - along * a[0], ry = dy - along * a[1], rz = dz - along * a[2];
      const r2 = rx * rx + ry * ry + rz * rz;
      const rmax = radius * (1 + radialMargin);
      if (r2 > rmax * rmax) continue;
      const d = r2 + along * along;
      if (d < bestD) { bestD = d; best = w; }
    }

    if (best < 0) { rest.push(i0, i1, i2); continue; }
    out[best].push(i0, i1, i2);

    const { center: c, u, v } = wheels[best];
    const s = st[best];
    s.tris++;
    for (const i of [i0, i1, i2]) {
      const dx = pos[i * 3] - c[0], dy = pos[i * 3 + 1] - c[1], dz = pos[i * 3 + 2] - c[2];
      const pu = dx * u[0] + dy * u[1] + dz * u[2], pv = dx * v[0] + dy * v[1] + dz * v[2];
      if (pu < s.minU) s.minU = pu; if (pu > s.maxU) s.maxU = pu;
      if (pv < s.minV) s.minV = pv; if (pv > s.maxV) s.maxV = pv;
      const r = Math.hypot(pu, pv);
      if (r > s.maxRadius) s.maxRadius = r;
    }
  }

  return {
    perWheel: out.map((arr) => (arr.length ? Uint32Array.from(arr) : null)),
    rest: Uint32Array.from(rest),
    stats: st.map((s) => ({
      tris: s.tris,
      ecc: s.tris ? [(s.minU + s.maxU) / 2, (s.minV + s.maxV) / 2] : [0, 0],
      maxRadius: s.maxRadius,
    })),
  };
}
