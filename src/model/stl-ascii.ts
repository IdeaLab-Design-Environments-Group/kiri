/** Minimal ASCII-STL writers for the tile export. Normals come from winding. */
export type V3 = [number, number, number];

export function facet(out: string[], a: V3, b: V3, c: V3): void {
  const n = normal(a, b, c);
  out.push(`  facet normal ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`);
  out.push("    outer loop");
  out.push(`      vertex ${fmt(a[0])} ${fmt(a[1])} ${fmt(a[2])}`);
  out.push(`      vertex ${fmt(b[0])} ${fmt(b[1])} ${fmt(b[2])}`);
  out.push(`      vertex ${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`);
  out.push("    endloop");
  out.push("  endfacet");
}

/** A quad given CCW-outward → two facets. */
export function quad(out: string[], a: V3, b: V3, c: V3, d: V3): void {
  facet(out, a, b, c);
  facet(out, a, c, d);
}

/**
 * A closed box from an in-plane frame: centre `c` with unit in-plane axes `x`,`y` and half-extents
 * `hx`,`hy`, spanning world-z `zlo`..`zhi`. Winding is outward (watertight), normals point out.
 */
export function boxFrame(out: string[], c: V3, x: V3, y: V3, hx: number, hy: number, zlo: number, zhi: number): void {
  const corner = (sx: number, sy: number, z: number): V3 => [
    c[0] + sx * hx * x[0] + sy * hy * y[0],
    c[1] + sx * hx * x[1] + sy * hy * y[1],
    z,
  ];
  const b00 = corner(-1, -1, zlo), b10 = corner(1, -1, zlo), b11 = corner(1, 1, zlo), b01 = corner(-1, 1, zlo);
  const t00 = corner(-1, -1, zhi), t10 = corner(1, -1, zhi), t11 = corner(1, 1, zhi), t01 = corner(-1, 1, zhi);
  quad(out, t00, t10, t11, t01); // top (+z)
  quad(out, b00, b01, b11, b10); // bottom (−z)
  quad(out, b10, b11, t11, t10); // +x
  quad(out, b01, b00, t00, t01); // −x
  quad(out, b11, b01, t01, t11); // +y
  quad(out, b00, b10, t10, t00); // −y
}

function normal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0");
