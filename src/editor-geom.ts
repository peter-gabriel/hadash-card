import type { OpeningConfig, RoomConfig, Vec2 } from './types';

export const GRID = 0.05;

export const snap = (v: number, g = GRID) => +(Math.round(v / g) * g).toFixed(3);
export const snapP = (p: Vec2, g = GRID): Vec2 => [snap(p[0], g), snap(p[1], g)];
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function rectPoly(x: number, y: number, w: number, d: number): Vec2[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + d],
    [x, y + d],
  ];
}

/** cômodo do editor sempre trabalha com polígono (rect vira polígono na mesma ordem de paredes) */
export function roomPoly(r: RoomConfig): Vec2[] {
  if (r.polygon?.length) return r.polygon;
  if (r.rect) return rectPoly(...r.rect);
  return [];
}

export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** distância de p ao segmento ab; t = posição relativa (0..1) da projeção */
export function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { d: dist(p, a), t: 0, len };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)));
  return { d: Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)), t, len };
}

export function centroid(poly: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function edge(poly: Vec2[], i: number): [Vec2, Vec2] {
  return [poly[i], poly[(i + 1) % poly.length]];
}

/** extremos do vão no mundo */
export function openingWorld(poly: Vec2[], o: OpeningConfig): [Vec2, Vec2] | undefined {
  if (o.edge >= poly.length) return undefined;
  const [a, b] = edge(poly, o.edge);
  const len = dist(a, b);
  if (len < 1e-9) return undefined;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  return [
    [a[0] + ux * o.at, a[1] + uy * o.at],
    [a[0] + ux * (o.at + o.width), a[1] + uy * (o.at + o.width)],
  ];
}

/** parede mais próxima de p entre os cômodos */
export function nearestEdge(rooms: RoomConfig[], p: Vec2, maxD: number) {
  let best: { ri: number; e: number; t: number; len: number; d: number } | undefined;
  rooms.forEach((r, ri) => {
    const poly = roomPoly(r);
    for (let e = 0; e < poly.length; e++) {
      const [a, b] = edge(poly, e);
      const s = segDist(p, a, b);
      if (s.d <= maxD && (!best || s.d < best.d)) best = { ri, e, t: s.t, len: s.len, d: s.d };
    }
  });
  return best;
}

const parallel = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
  const u = [b[0] - a[0], b[1] - a[1]];
  const v = [d[0] - c[0], d[1] - c[1]];
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  return lu > 1e-9 && lv > 1e-9 && Math.abs(u[0] * v[1] - u[1] * v[0]) / (lu * lv) < 0.03;
};

/**
 * abre um vão centrado em `c`, na parede mais próxima e em todas as paredes paralelas encostadas nela
 * (a parede entre dois cômodos é desenhada pelos dois)
 */
export function addOpening(rooms: RoomConfig[], c: Vec2, width: number, reach = 0.35): number {
  let added = 0;
  rooms.forEach((r) => {
    const poly = roomPoly(r);
    for (let e = 0; e < poly.length; e++) {
      const [a, b] = edge(poly, e);
      const s = segDist(c, a, b);
      if (s.d > reach || s.t <= 0 || s.t >= 1) continue;
      const w = Math.min(width, s.len);
      const at = +Math.max(0, Math.min(s.len - w, s.t * s.len - w / 2)).toFixed(3);
      (r.openings ??= []).push({ edge: e, at, width: +w.toFixed(3) });
      added++;
      break; // um vão por cômodo
    }
  });
  return added;
}

/** vãos "gêmeos" (mesmo buraco visto pelos dois cômodos) */
export function linkedOpenings(rooms: RoomConfig[], ri: number, oi: number): [number, number][] {
  const base = rooms[ri].openings?.[oi];
  const bw = base && openingWorld(roomPoly(rooms[ri]), base);
  if (!bw) return [[ri, oi]];
  const bc: Vec2 = [(bw[0][0] + bw[1][0]) / 2, (bw[0][1] + bw[1][1]) / 2];
  const out: [number, number][] = [];
  rooms.forEach((r, rj) => {
    const poly = roomPoly(r);
    (r.openings ?? []).forEach((o, oj) => {
      const w = openingWorld(poly, o);
      if (!w) return;
      const c: Vec2 = [(w[0][0] + w[1][0]) / 2, (w[0][1] + w[1][1]) / 2];
      if ((rj === ri && oj === oi) || (dist(c, bc) < 0.4 && parallel(bw[0], bw[1], w[0], w[1]))) out.push([rj, oj]);
    });
  });
  return out;
}

/** recoloca o vão centrado em `c` na mesma parede (arrastar porta) */
export function moveOpeningTo(r: RoomConfig, o: OpeningConfig, c: Vec2) {
  const [a, b] = edge(roomPoly(r), o.edge);
  const s = segDist(c, a, b);
  o.at = +Math.max(0, Math.min(s.len - o.width, s.t * s.len - o.width / 2)).toFixed(3);
}

export function resizeOpening(r: RoomConfig, o: OpeningConfig, width: number) {
  const [a, b] = edge(roomPoly(r), o.edge);
  const len = dist(a, b);
  const center = o.at + o.width / 2;
  o.width = +Math.min(width, len).toFixed(3);
  o.at = +Math.max(0, Math.min(len - o.width, center - o.width / 2)).toFixed(3);
}

/** novo canto no meio da parede `e`; vãos dessa parede passam para a metade certa */
export function insertVertex(r: RoomConfig, e: number, p: Vec2) {
  const poly = [...roomPoly(r)];
  const [a] = edge(poly, e);
  const len1 = dist(a, p);
  poly.splice(e + 1, 0, p);
  r.polygon = poly;
  delete r.rect;
  for (const o of r.openings ?? []) {
    if (o.edge > e) o.edge++;
    else if (o.edge === e && o.at >= len1) {
      o.edge = e + 1;
      o.at = +(o.at - len1).toFixed(3);
    }
  }
}

/** remove canto; vãos das duas paredes que encostavam nele somem */
export function removeVertex(r: RoomConfig, vi: number) {
  const poly = [...roomPoly(r)];
  if (poly.length <= 3) return false;
  const n = poly.length;
  const prev = (vi - 1 + n) % n;
  poly.splice(vi, 1);
  r.polygon = poly;
  delete r.rect;
  r.openings = (r.openings ?? [])
    .filter((o) => o.edge !== vi && o.edge !== prev)
    .map((o) => ({ ...o, edge: o.edge > vi ? o.edge - 1 : o.edge }));
  return true;
}

/** cômodo que contém o ponto (o menor, se houver sobreposição) */
export function roomAt(rooms: RoomConfig[], p: Vec2): number {
  let best = -1;
  let bestArea = Infinity;
  rooms.forEach((r, i) => {
    const poly = roomPoly(r);
    if (poly.length < 3 || !pointInPoly(p, poly)) return;
    const xs = poly.map((q) => q[0]);
    const ys = poly.map((q) => q[1]);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (area < bestArea) {
      best = i;
      bestArea = area;
    }
  });
  return best;
}

/**
 * garante que todo vão exista dos dois lados da parede: se o cômodo vizinho tem uma parede paralela encostada
 * e sem vão naquele trecho, abre lá também (senão o 3D mostra a parede do vizinho tapando a porta)
 */
export function syncOpenings(rooms: RoomConfig[], reach = 0.35): number {
  let added = 0;
  rooms.forEach((r, ri) => {
    const poly = roomPoly(r);
    for (const o of [...(r.openings ?? [])]) {
      const w = openingWorld(poly, o);
      if (!w) continue;
      const c: Vec2 = [(w[0][0] + w[1][0]) / 2, (w[0][1] + w[1][1]) / 2];
      rooms.forEach((r2, rj) => {
        if (rj === ri) return;
        const p2 = roomPoly(r2);
        for (let e = 0; e < p2.length; e++) {
          const [a, b] = edge(p2, e);
          if (!parallel(w[0], w[1], a, b)) continue;
          const s = segDist(c, a, b);
          if (s.d > reach || s.t <= 0 || s.t >= 1) continue;
          const center = s.t * s.len;
          const has = (r2.openings ?? []).some((q) => q.edge === e && Math.abs(q.at + q.width / 2 - center) < Math.max(q.width, o.width) / 2);
          if (has) break;
          const width = Math.min(o.width, s.len);
          (r2.openings ??= []).push({ edge: e, at: +Math.max(0, Math.min(s.len - width, center - width / 2)).toFixed(3), width: +width.toFixed(3) });
          added++;
          break;
        }
      });
    }
  });
  return added;
}
