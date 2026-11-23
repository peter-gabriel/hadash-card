import { LitElement, html, svg, css, nothing, type TemplateResult } from 'lit';
import {
  addOpening,
  centroid,
  dist,
  edge,
  insertVertex,
  linkedOpenings,
  moveOpeningTo,
  openingWorld,
  pointInPoly,
  rectPoly,
  removeVertex,
  resizeOpening,
  roomAt,
  roomPoly,
  snapP,
  syncOpenings,
} from './editor-geom';
import { applyPlan, computePlan, type SyncItem, type SyncNote } from './area-sync';
import { DEMO_FLOORS, isLightSwitch, roomLabel, signedArea, wallSegments } from './house';
import type { BackgroundConfig, CardConfig, DeviceConfig, FloorConfig, Hass, RoomConfig, Vec2 } from './types';

type Tool = 'select' | 'rect' | 'poly' | 'door' | 'device' | 'stairs' | 'scale' | 'bg';
type Sel =
  | null
  | { k: 'room'; ri: number }
  | { k: 'opening'; ri: number; oi: number }
  | { k: 'device'; ri: number; di: number }
  | { k: 'stairs'; si: number };

type Drag =
  | { k: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { k: 'vertex'; ri: number; vi: number }
  | { k: 'room'; ri: number; start: Vec2; poly: Vec2[]; devs: Vec2[] }
  | { k: 'opening'; links: [number, number][] }
  | { k: 'device'; ri: number; di: number }
  | { k: 'stairs'; si: number; start: Vec2; from: Vec2; to: Vec2 }
  | { k: 'bg'; start: Vec2; x: number; y: number };

type Draft = { k: 'rect' | 'stairs'; a: Vec2; b: Vec2 } | { k: 'poly'; pts: Vec2[]; hover?: Vec2 };

const COLORS = ['#c9b79c', '#a9c0a6', '#9fb4c7', '#c7a9a9', '#b7a9c7', '#c7c09f', '#9fc7c0', '#c7b39f'];
/** domínios que fazem sentido como "pino" na planta */
const PLACEABLE = ['light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'lock', 'binary_sensor', 'input_boolean', 'vacuum', 'humidifier', 'water_heater', 'valve', 'camera'];
const DOMAIN_COLOR: Record<string, string> = {
  light: '#ffc46b',
  switch: '#4fc3f7',
  input_boolean: '#4fc3f7',
  fan: '#4dd0b5',
  climate: '#64b5f6',
  media_player: '#b388ff',
  cover: '#ffd54f',
  lock: '#ef9a9a',
  binary_sensor: '#ef5350',
  speaker: '#1ed760',
};

const TOOLS: [Tool, string, string][] = [
  ['select', 'Selecionar', 'M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4L7 18.5z'],
  ['rect', 'Cômodo', 'M3 5v14h18V5zm2 2h14v10H5z'],
  ['poly', 'Contorno livre', 'M3 3h8v2H5v6H3zm0 10h2v6h6v2H3zm10 6h6v-6h2v8h-8zm6-14h-6V3h8v8h-2z'],
  ['door', 'Porta', 'M5 21V3h11v2h3v16h-2V7h-1v14zm6-8h2v-2h-2z'],
  ['stairs', 'Escada', 'M15 5v4h-4v4H7v4H3v2h6v-4h4v-4h4V7h4V5z'],
  ['device', 'Dispositivo', 'M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7m0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5'],
];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const r3 = (n: number) => +n.toFixed(3);

/** config do card -> pisos editáveis (cômodos sempre como polígono, dispositivos como objeto) */
function toFloors(cfg: CardConfig): FloorConfig[] {
  const src: FloorConfig[] = cfg.floors?.length
    ? clone(cfg.floors)
    : cfg.rooms?.length
      ? [{ name: 'Térreo', rooms: clone(cfg.rooms) }]
      : [{ name: 'Térreo', rooms: [] }];
  for (const f of src)
    for (const r of f.rooms) {
      r.polygon = roomPoly(r);
      delete r.rect;
      r.devices = (r.devices ?? []).map((d) => (typeof d === 'string' ? { entity: d } : d));
    }
  return src;
}

export class HadashEditor extends LitElement {
  static properties = {
    hass: { attribute: false },
    initial: { attribute: false },
    _floors: { state: true },
    _fi: { state: true },
    _tool: { state: true },
    _sel: { state: true },
    _view: { state: true },
    _draft: { state: true },
    _scalePts: { state: true },
    _pending: { state: true },
    _q: { state: true },
    _msg: { state: true },
    _sync: { state: true },
  };

  declare hass?: Hass;
  declare initial?: CardConfig;
  declare _floors: FloorConfig[];
  declare _fi: number;
  declare _tool: Tool;
  declare _sel: Sel;
  declare _view: { x: number; y: number; s: number };
  declare _draft: Draft | undefined;
  declare _scalePts: Vec2[];
  declare _pending: DeviceConfig | undefined;
  declare _q: string;
  declare _msg: string | undefined;
  declare _sync: { items: SyncItem[]; notes: SyncNote[]; busy?: boolean } | undefined;

  private _undo: string[] = [];
  private _drag?: Drag;
  private _moved = false;
  private _pointers = new Map<number, { x: number; y: number }>();
  private _pinch?: { d: number; cx: number; cy: number; s: number; vx: number; vy: number };
  private _msgTimer?: number;
  private _ro?: ResizeObserver;

  constructor() {
    super();
    this._floors = [];
    this._fi = 0;
    this._tool = 'select';
    this._sel = null;
    this._view = { x: 40, y: 40, s: 50 };
    this._scalePts = [];
    this._q = '';
  }

  // ---------- ciclo de vida ----------

  willUpdate() {
    // lê a config uma vez só: pré-visualizar/salvar não pode apagar o que está sendo editado
    if (!this._floors.length && this.initial) this._floors = toFloors(this.initial);
  }

  firstUpdated() {
    this._ro = new ResizeObserver(() => this.requestUpdate());
    this._ro.observe(this._svg);
    requestAnimationFrame(() => this.fit());
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKey);
    this._ro?.disconnect();
  }

  private get _svg() {
    return this.renderRoot.querySelector('svg.plan') as SVGSVGElement;
  }

  private get _floor() {
    return this._floors[this._fi];
  }

  private get _rooms() {
    return this._floor?.rooms ?? [];
  }

  /** config final do card com a planta editada */
  buildConfig(): CardConfig {
    // porta aberta de um lado só vira parede tapando a porta no 3D: completa o outro lado
    for (const f of this._floors) syncOpenings(f.rooms);
    const out: CardConfig = { ...(this.initial as CardConfig) };
    delete out.rooms;
    out.floors = this._floors.map((f) => {
      const ff: FloorConfig = { ...f, rooms: f.rooms.map((r) => this._cleanRoom(r)) };
      if (!ff.stairs?.length) delete ff.stairs;
      if (!ff.background) delete ff.background;
      return ff;
    });
    return out;
  }

  private _cleanRoom(r: RoomConfig): RoomConfig {
    const out: RoomConfig = { ...r, polygon: roomPoly(r).map(([x, y]) => [r3(x), r3(y)] as Vec2) };
    delete out.rect;
    if (!out.name) delete out.name;
    for (const k of ['openings', 'devices'] as const) if (!out[k]?.length) delete out[k];
    for (const k of ['area', 'temperature', 'humidity', 'motion', 'color', 'wall_height'] as const)
      if (out[k] === '' || out[k] === undefined) delete out[k];
    return out;
  }

  // ---------- histórico ----------

  private _commit() {
    this._undo.push(JSON.stringify(this._floors));
    if (this._undo.length > 80) this._undo.shift();
  }

  private _undoLast() {
    const last = this._undo.pop();
    if (!last) return;
    this._floors = JSON.parse(last);
    this._fi = Math.min(this._fi, this._floors.length - 1);
    this._sel = null;
  }

  private _say(msg: string) {
    this._msg = msg;
    clearTimeout(this._msgTimer);
    this._msgTimer = window.setTimeout(() => (this._msg = undefined), 3200);
  }

  // ---------- visão ----------

  fit() {
    const svgEl = this._svg;
    if (!svgEl) return;
    const w = svgEl.clientWidth;
    const h = svgEl.clientHeight;
    const pts: Vec2[] = this._rooms.flatMap((r) => roomPoly(r));
    const bg = this._floor?.background;
    if (bg) pts.push([bg.x, bg.y], [bg.x + bg.width, bg.y + bg.height]);
    if (!pts.length) pts.push([0, 0], [12, 9]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const s = Math.max(5, Math.min(400, Math.min(w / (x1 - x0 + 2), h / (y1 - y0 + 2))));
    this._view = { s, x: (w - (x1 - x0) * s) / 2 - x0 * s, y: (h - (y1 - y0) * s) / 2 - y0 * s };
  }

  private _toWorld(cx: number, cy: number): Vec2 {
    const r = this._svg.getBoundingClientRect();
    const v = this._view;
    return [(cx - r.left - v.x) / v.s, (cy - r.top - v.y) / v.s];
  }

  private _onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this._svg.getBoundingClientRect();
    const v = this._view;
    const k = Math.exp(-e.deltaY * 0.0015);
    const s = Math.max(5, Math.min(400, v.s * k));
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    this._view = { s, x: mx - ((mx - v.x) / v.s) * s, y: my - ((my - v.y) / v.s) * s };
  };

  // ---------- teclado ----------

  private _onKey = (e: KeyboardEvent) => {
    const tag = (e.composedPath()[0] as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this._undoLast();
    } else if (e.key === 'Escape') {
      this._draft = undefined;
      this._scalePts = [];
      if (this._tool !== 'select') this._tool = 'select';
      else this._sel = null;
    } else if (e.key === 'Enter' && this._draft?.k === 'poly') this._finishPoly();
    else if (e.key === 'Delete' || e.key === 'Backspace') this._deleteSel();
  };

  // ---------- ponteiro ----------

  private _onDown = (e: PointerEvent) => {
    if (e.button === 2) return;
    this._svg.setPointerCapture(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2) {
      // dois dedos: zoom/arrastar a planta, cancela o que estava fazendo
      const [a, b] = [...this._pointers.values()];
      this._drag = undefined;
      if (this._draft?.k !== 'poly') this._draft = undefined;
      this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, ...this._view, vx: this._view.x, vy: this._view.y };
      return;
    }
    this._moved = false;
    const p = this._toWorld(e.clientX, e.clientY);
    const ps = snapP(p);
    const t = e.target as SVGElement;
    const kind = t.dataset?.kind;
    const num = (k: string) => Number(t.dataset?.[k]);
    const rooms = this._rooms;

    switch (this._tool) {
      case 'select': {
        if (kind === 'vertex') {
          this._commit();
          this._drag = { k: 'vertex', ri: num('ri'), vi: num('vi') };
        } else if (kind === 'mid') {
          this._commit();
          const ri = num('ri');
          const e2 = num('e');
          const [a, b] = edge(roomPoly(rooms[ri]), e2);
          insertVertex(rooms[ri], e2, snapP([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
          this._drag = { k: 'vertex', ri, vi: e2 + 1 };
        } else if (kind === 'opening') {
          this._sel = { k: 'opening', ri: num('ri'), oi: num('oi') };
          this._commit();
          this._drag = { k: 'opening', links: linkedOpenings(rooms, num('ri'), num('oi')) };
        } else if (kind === 'device') {
          this._sel = { k: 'device', ri: num('ri'), di: num('di') };
          this._commit();
          this._drag = { k: 'device', ri: num('ri'), di: num('di') };
        } else if (kind === 'stairs') {
          const si = num('si');
          const s = this._floor.stairs![si];
          this._sel = { k: 'stairs', si };
          this._commit();
          this._drag = { k: 'stairs', si, start: ps, from: [...s.from], to: [...s.to] };
        } else if (kind === 'room') {
          const ri = num('ri');
          this._sel = { k: 'room', ri };
          this._commit();
          this._drag = {
            k: 'room',
            ri,
            start: ps,
            poly: roomPoly(rooms[ri]).map((q) => [...q] as Vec2),
            devs: (rooms[ri].devices as DeviceConfig[]).map((d) => [...(d.pos ?? centroid(roomPoly(rooms[ri])))] as Vec2),
          };
        } else {
          this._sel = null;
          this._drag = { k: 'pan', sx: e.clientX, sy: e.clientY, vx: this._view.x, vy: this._view.y };
        }
        break;
      }
      case 'rect':
      case 'stairs':
        this._draft = { k: this._tool, a: ps, b: ps };
        break;
      case 'poly': {
        const d = this._draft?.k === 'poly' ? this._draft : undefined;
        if (d && d.pts.length >= 3 && dist(ps, d.pts[0]) * this._view.s < 14) return this._finishPoly();
        this._draft = { k: 'poly', pts: [...(d?.pts ?? []), ps] };
        break;
      }
      case 'door': {
        this._commit();
        const n = addOpening(rooms, p, 0.8);
        if (!n) {
          this._undo.pop();
          this._say('Toque em cima de uma parede para abrir uma porta.');
        } else {
          const ri = rooms.findIndex((r) => r.openings?.length && (() => {
            const w = openingWorld(roomPoly(r), r.openings[r.openings.length - 1]);
            return w && dist(p, [(w[0][0] + w[1][0]) / 2, (w[0][1] + w[1][1]) / 2]) < 0.6;
          })());
          if (ri >= 0) this._sel = { k: 'opening', ri, oi: rooms[ri].openings!.length - 1 };
          this.requestUpdate();
        }
        break;
      }
      case 'device': {
        if (!this._pending) return this._say('Escolha um dispositivo na lista ao lado.');
        const ri = roomAt(rooms, p);
        if (ri < 0) return this._say('Coloque o dispositivo dentro de um cômodo.');
        this._commit();
        const devs = ((rooms[ri].devices ??= []) as DeviceConfig[]);
        const dev: DeviceConfig = { ...this._pending, pos: ps };
        // nome que indica luz (o id sozinho a planta já reconhece): grava explícito
        if (dev.entity && !isLightSwitch(dev.entity) && isLightSwitch(dev.entity, this.hass?.states[dev.entity]?.attributes.friendly_name)) dev.light = true;
        devs.push(dev);
        this._sel = { k: 'device', ri, di: devs.length - 1 };
        this._pending = undefined;
        break;
      }
      case 'scale':
        this._scalePts = this._scalePts.length >= 2 ? [ps] : [...this._scalePts, ps];
        break;
      case 'bg': {
        const bg = this._floor.background;
        if (!bg) return;
        this._commit();
        this._drag = { k: 'bg', start: p, x: bg.x, y: bg.y };
        break;
      }
    }
  };

  private _onMove = (e: PointerEvent) => {
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch && this._pointers.size >= 2) {
      const [a, b] = [...this._pointers.values()];
      const pi = this._pinch;
      const s = Math.max(5, Math.min(400, (pi.s * Math.hypot(a.x - b.x, a.y - b.y)) / pi.d));
      const r = this._svg.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - r.left;
      const cy = (a.y + b.y) / 2 - r.top;
      const wx = (pi.cx - r.left - pi.vx) / pi.s;
      const wy = (pi.cy - r.top - pi.vy) / pi.s;
      this._view = { s, x: cx - wx * s, y: cy - wy * s };
      return;
    }
    const p = this._toWorld(e.clientX, e.clientY);
    const ps = snapP(p);
    if (this._draft?.k === 'poly') {
      this._draft = { ...this._draft, hover: ps };
      return;
    }
    if (this._draft) {
      this._draft = { ...this._draft, b: ps };
      return;
    }
    const d = this._drag;
    if (!d) return;
    this._moved = true;
    const rooms = this._rooms;
    switch (d.k) {
      case 'pan':
        this._view = { ...this._view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy };
        return;
      case 'vertex': {
        const poly = [...roomPoly(rooms[d.ri])];
        poly[d.vi] = this._snapVertex(ps, d.ri, d.vi);
        rooms[d.ri].polygon = poly;
        break;
      }
      case 'room': {
        const dx = ps[0] - d.start[0];
        const dy = ps[1] - d.start[1];
        const r = rooms[d.ri];
        r.polygon = d.poly.map(([x, y]) => [r3(x + dx), r3(y + dy)] as Vec2);
        (r.devices as DeviceConfig[]).forEach((dev, i) => (dev.pos = [r3(d.devs[i][0] + dx), r3(d.devs[i][1] + dy)]));
        break;
      }
      case 'opening':
        for (const [rj, oj] of d.links) moveOpeningTo(rooms[rj], rooms[rj].openings![oj], p);
        break;
      case 'device':
        (rooms[d.ri].devices![d.di] as DeviceConfig).pos = ps;
        break;
      case 'stairs': {
        const s = this._floor.stairs![d.si];
        const dx = ps[0] - d.start[0];
        const dy = ps[1] - d.start[1];
        s.from = [r3(d.from[0] + dx), r3(d.from[1] + dy)];
        s.to = [r3(d.to[0] + dx), r3(d.to[1] + dy)];
        break;
      }
      case 'bg': {
        const bg = this._floor.background!;
        bg.x = r3(d.x + p[0] - d.start[0]);
        bg.y = r3(d.y + p[1] - d.start[1]);
        break;
      }
    }
    this.requestUpdate();
  };

  private _onUp = (e: PointerEvent) => {
    this._pointers.delete(e.pointerId);
    if (this._pinch) {
      if (this._pointers.size < 2) this._pinch = undefined;
      return;
    }
    const d = this._drag;
    this._drag = undefined;
    // toque sem arrastar não vira passo no "desfazer"
    if (d && d.k !== 'pan' && !this._moved) this._undo.pop();
    if (d?.k === 'device' && this._moved) this._rehomeDevice(d.ri, d.di);

    const dr = this._draft;
    if (dr && dr.k !== 'poly') {
      this._draft = undefined;
      const [x0, x1] = [Math.min(dr.a[0], dr.b[0]), Math.max(dr.a[0], dr.b[0])];
      const [y0, y1] = [Math.min(dr.a[1], dr.b[1]), Math.max(dr.a[1], dr.b[1])];
      if (dr.k === 'rect') {
        if (x1 - x0 < 0.3 || y1 - y0 < 0.3) return this._say('Arraste para desenhar o cômodo.');
        this._commit();
        this._addRoom(rectPoly(x0, y0, r3(x1 - x0), r3(y1 - y0)));
      } else {
        if (dist(dr.a, dr.b) < 0.6) return this._say('Arraste do pé da escada até o topo.');
        this._commit();
        (this._floor.stairs ??= []).push({ from: dr.a, to: dr.b, width: 0.9 });
        this._sel = { k: 'stairs', si: this._floor.stairs.length - 1 };
        this._tool = 'select';
      }
    }
  };

  private _onDbl = () => {
    if (this._draft?.k === 'poly') this._finishPoly();
  };

  /** encaixa no canto de outro cômodo se estiver perto (alinha paredes vizinhas) */
  private _snapVertex(p: Vec2, ri: number, vi: number): Vec2 {
    const tol = 12 / this._view.s;
    let best: Vec2 = p;
    let bd = tol;
    this._rooms.forEach((r, i) =>
      roomPoly(r).forEach((q, j) => {
        if (i === ri && j === vi) return;
        const d = dist(p, q);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }),
    );
    return [...best] as Vec2;
  }

  /** dispositivo arrastado para outro cômodo passa a pertencer a ele */
  private _rehomeDevice(ri: number, di: number) {
    const rooms = this._rooms;
    const dev = rooms[ri].devices![di] as DeviceConfig;
    const to = roomAt(rooms, dev.pos!);
    if (to < 0 || to === ri) return;
    rooms[ri].devices!.splice(di, 1);
    (rooms[to].devices ??= []).push(dev);
    this._sel = { k: 'device', ri: to, di: rooms[to].devices!.length - 1 };
  }

  private _finishPoly() {
    const d = this._draft;
    if (d?.k !== 'poly') return;
    this._draft = undefined;
    if (d.pts.length < 3) return this._say('O contorno precisa de pelo menos 3 cantos.');
    this._commit();
    this._addRoom(d.pts);
  }

  private _addRoom(poly: Vec2[]) {
    const all = this._floors.flatMap((f) => f.rooms);
    const name = `Cômodo ${all.length + 1}`;
    this._rooms.push({ name, polygon: poly, color: COLORS[all.length % COLORS.length], devices: [], openings: [] });
    this._sel = { k: 'room', ri: this._rooms.length - 1 };
    this._tool = 'select';
    this._say('Cômodo criado. Dê um nome no painel ao lado.');
  }

  private _deleteSel() {
    const s = this._sel;
    if (!s) return;
    this._commit();
    const rooms = this._rooms;
    if (s.k === 'room') rooms.splice(s.ri, 1);
    else if (s.k === 'device') rooms[s.ri].devices!.splice(s.di, 1);
    else if (s.k === 'stairs') this._floor.stairs!.splice(s.si, 1);
    else if (s.k === 'opening') {
      // apaga o vão nos dois lados da parede, do maior índice para o menor
      linkedOpenings(rooms, s.ri, s.oi)
        .sort((a, b) => b[1] - a[1])
        .forEach(([rj, oj]) => rooms[rj].openings!.splice(oj, 1));
    }
    this._sel = null;
  }

  private _setTool(t: Tool) {
    this._tool = t;
    this._draft = undefined;
    this._scalePts = [];
    if (t !== 'device') this._pending = undefined;
  }

  // ---------- planta de fundo ----------

  private async _upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return this._say('Use uma imagem (JPG/PNG). PDF: tire um print da página.');
    this._say('Enviando imagem…');
    const dims = await imageSize(file);
    let url: string | undefined;
    // no HA: guarda a imagem no próprio HA (não pesa a config do dashboard)
    if (this.hass?.fetchWithAuth) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await this.hass.fetchWithAuth('/api/image/upload', { method: 'POST', body: fd });
        if (r.ok) url = `/api/image/serve/${(await r.json()).id}/original`;
      } catch {
        /* cai para a versão embutida */
      }
    }
    url ??= await downscale(file, 1600);
    this._commit();
    const width = 12;
    this._floor.background = { image: url, x: 0, y: 0, width, height: r3((width * dims.h) / dims.w), opacity: 0.55 };
    this.fit();
    this._setTool('scale');
    this._say('Agora calibre a escala: toque nas duas pontas de uma medida conhecida.');
  }

  private _applyScale(real: number) {
    const bg = this._floor.background;
    const [a, b] = this._scalePts;
    if (!bg || !a || !b || !(real > 0)) return;
    const k = real / dist(a, b);
    this._commit();
    // escala em volta do primeiro ponto: ele fica parado
    bg.x = r3(a[0] + (bg.x - a[0]) * k);
    bg.y = r3(a[1] + (bg.y - a[1]) * k);
    bg.width = r3(bg.width * k);
    bg.height = r3(bg.height * k);
    this._scalePts = [];
    this._setTool('select');
    this.fit();
    this._say(`Escala ajustada (${real} m). Agora desenhe os cômodos por cima.`);
  }

  // ---------- dispositivos ----------

  /** áreas criadas agora (o registro do HA demora um instante para atualizar) */
  private _newAreas: Record<string, string> = {};

  private _areaName(id?: string | null) {
    return (id && (this.hass?.areas?.[id]?.name ?? this._newAreas[id])) || '';
  }

  private _label(r: RoomConfig) {
    return r.name || this._areaName(r.area) || r.area || 'Cômodo';
  }

  private _allAreas() {
    const list = Object.values(this.hass?.areas ?? {}).map((a) => ({ id: a.area_id, name: a.name, floor: a.floor_id ?? '' }));
    for (const [id, name] of Object.entries(this._newAreas)) if (!list.some((a) => a.id === id)) list.push({ id, name, floor: '' });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** liga o cômodo à área: nome passa a vir dela e sensores da área entram sozinhos */
  private _linkArea(r: RoomConfig, area: string | undefined) {
    this._commit();
    r.area = area || undefined;
    if (!area) {
      if (!r.name) r.name = this._areaName(r.area) || 'Cômodo';
      return this.requestUpdate();
    }
    delete r.name;
    const filled: string[] = [];
    const inArea = Object.values(this.hass?.states ?? {}).filter((s) => this._entityArea(s.entity_id) === area);
    const find = (domain: string, classes: string[]) =>
      inArea.find((s) => s.entity_id.startsWith(`${domain}.`) && classes.includes(s.attributes.device_class))?.entity_id;
    if (!r.temperature && (r.temperature = find('sensor', ['temperature']))) filled.push('temperatura');
    if (!r.humidity && (r.humidity = find('sensor', ['humidity']))) filled.push('umidade');
    if (!r.motion && (r.motion = find('binary_sensor', ['motion', 'occupancy', 'presence']))) filled.push('presença');
    this._say(`Ligado à área "${this._areaName(area)}"${filled.length ? ` · sensores: ${filled.join(', ')}` : ''}.`);
    this.requestUpdate();
  }

  private async _createArea(r: RoomConfig) {
    const name = prompt('Nome da nova área no Home Assistant:', this._label(r));
    if (!name?.trim() || !this.hass) return this.requestUpdate();
    try {
      const res = await this.hass.callWS<{ area_id: string; name: string }>({ type: 'config/area_registry/create', name: name.trim() });
      this._newAreas[res.area_id] = res.name;
      this._linkArea(r, res.area_id);
    } catch (e) {
      this._say(`Não consegui criar a área: ${(e as Error).message ?? e}`);
      this.requestUpdate();
    }
  }

  /** liga de uma vez os cômodos cujo nome bate com o de uma área (ignorando acentos e maiúsculas) */
  private _autoLink() {
    const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const areas = this._allAreas();
    let n = 0;
    this._commit();
    for (const f of this._floors)
      for (const r of f.rooms) {
        if (r.area || !r.name) continue;
        const a = areas.find((x) => norm(x.name) === norm(r.name!));
        if (a) {
          r.area = a.id;
          delete r.name;
          n++;
        }
      }
    if (!n) this._undo.pop();
    this._say(n ? `${n} cômodo(s) ligados às áreas de mesmo nome.` : 'Nenhum cômodo com o mesmo nome de uma área.');
    this.requestUpdate();
  }

  private _entityArea(id: string) {
    const e = this.hass?.entities?.[id];
    return e?.area_id ?? (e?.device_id ? this.hass?.devices?.[e.device_id]?.area_id : undefined) ?? undefined;
  }

  private _placed() {
    const set = new Set<string>();
    for (const f of this._floors)
      for (const r of f.rooms)
        for (const d of (r.devices ?? []) as DeviceConfig[]) set.add(d.speaker ? `speaker:${d.speaker}` : d.entity!);
    return set;
  }

  /** coloca de uma vez os dispositivos da área do HA dentro do cômodo */
  private _addAreaDevices(ri: number) {
    const r = this._rooms[ri];
    if (!r.area || !this.hass) return;
    const placed = this._placed();
    const ids = Object.keys(this.hass.states).filter(
      (id) => PLACEABLE.includes(id.split('.')[0]) && !placed.has(id) && this._entityArea(id) === r.area && !this.hass!.entities?.[id]?.hidden,
    );
    if (!ids.length) return this._say('Nenhum dispositivo novo nessa área.');
    this._commit();
    const poly = roomPoly(r);
    const c = centroid(poly);
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const rad = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.3;
    ids.forEach((entity, i) => {
      const a = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      let pos = snapP([c[0] + Math.cos(a) * rad, c[1] + Math.sin(a) * rad]);
      if (!pointInPoly(pos, poly)) pos = snapP(c);
      ((r.devices ??= []) as DeviceConfig[]).push({ entity, pos });
    });
    this._say(`${ids.length} dispositivo(s) adicionados. Arraste para o lugar certo.`);
  }

  // ---------- render ----------

  render() {
    if (!this._floor) return nothing;
    return html`<div class="ed">
      <header>
        <div class="floors">
          ${this._floors.map(
            (f, i) => html`<button class=${i === this._fi ? 'sel' : ''} @click=${() => this._goFloor(i)}>${f.name}</button>`,
          )}
          <button class="add" @click=${this._addFloor} title="Novo piso">+ Piso</button>
        </div>
        <div class="tools">
          ${TOOLS.map(
            ([t, label, d]) => html`<button class=${this._tool === t ? 'sel' : ''} @click=${() => this._setTool(t)} title=${label}>
              <svg viewBox="0 0 24 24"><path d=${d} /></svg><span>${label}</span>
            </button>`,
          )}
        </div>
        <div class="actions">
          <button @click=${this._undoLast} ?disabled=${!this._undo.length} title="Desfazer (Ctrl+Z)">↶</button>
          <button @click=${() => this.fit()} title="Enquadrar">⤢</button>
          <span class="sep"></span>
          <button @click=${() => this._emit('editor-close')}>Cancelar</button>
          <button @click=${() => this._emit('editor-preview', this.buildConfig())}>Ver em 3D</button>
          <button class="primary" @click=${this._startSave}>Salvar</button>
        </div>
      </header>
      <main>
        <div class="canvas">
          ${this._renderSvg()} ${this._msg ? html`<div class="msg">${this._msg}</div>` : nothing}
        </div>
        <aside>${this._renderPanel()}</aside>
      </main>
      ${this._sync ? this._renderSync() : nothing}
    </div>`;
  }

  // ---------- sincronizar com as áreas do HA ----------

  /** antes de salvar: mostra o que mudaria no HA (áreas, andares, área de cada entidade) */
  private _startSave = () => this._openSync(true);

  private _openSync(saveAfter: boolean) {
    if (!this.hass?.areas) return saveAfter ? this._emit('editor-save', this.buildConfig()) : undefined;
    const plan = computePlan(this._floors, this.hass);
    if (!plan.items.length && !plan.notes.length) {
      if (saveAfter) return this._emit('editor-save', this.buildConfig());
      return this._say('Planta e áreas do HA já estão iguais.');
    }
    this._syncSaveAfter = saveAfter;
    this._sync = plan;
  }

  private _syncSaveAfter = true;

  private async _applySync() {
    const sync = this._sync;
    if (!sync || !this.hass) return;
    this._commit();
    this._sync = { ...sync, busy: true };
    const res = await applyPlan(sync.items, this._floors, this.hass);
    this._sync = undefined;
    this._say(res.errors.length ? `${res.done} mudança(s) no HA; ${res.errors.length} falharam: ${res.errors[0]}` : `${res.done} mudança(s) aplicadas no HA.`);
    if (this._syncSaveAfter) this._emit('editor-save', this.buildConfig());
    else this.requestUpdate();
  }

  private _renderSync() {
    const { items, notes, busy } = this._sync!;
    const floorName = (fi: number) => this._floors[fi]?.name ?? '';
    const group = (kind: SyncItem['kind'], title: string, line: (i: any) => TemplateResult) => {
      const list = items.filter((i) => i.kind === kind);
      return list.length
        ? html`<h4>${title}</h4>
            ${list.map(
              (i) => html`<label class="sync-item"
                ><input type="checkbox" .checked=${i.checked} ?disabled=${busy}
                  @change=${(e: Event) => ((i.checked = (e.target as HTMLInputElement).checked), this.requestUpdate())} />
                <span>${line(i)}</span></label
              >`,
            )}`
        : nothing;
    };
    const n = items.filter((i) => i.checked).length;
    return html`<div class="modal">
      <div class="sheet">
        <h3>Sincronizar com o Home Assistant</h3>
        <p class="hint">
          Deixe a planta e as áreas do HA iguais: assim voz, automações e cards por área seguem a planta. Nada é apagado
          nem renomeado no HA; desmarque o que não quiser.
        </p>
        <div class="sync-list">
          ${group('floor', 'Andares a criar', (i) => html`Criar andar <b>${i.name}</b>`)}
          ${group('area', 'Áreas', (i) =>
            i.existing
              ? html`Ligar <b>${i.name}</b> à área que já existe com esse nome`
              : html`Criar área <b>${i.name}</b>${this._floors.length > 1 ? html` <small>no andar ${floorName(i.fi)}</small>` : nothing}`,
          )}
          ${group('area-floor', 'Áreas no andar', (i) => html`Colocar <b>${i.areaName}</b> no andar <b>${i.floorName}</b>${i.from ? html` <small>(hoje: ${i.from})</small>` : nothing}`)}
          ${group('entity', 'Dispositivos', (i) => html`<b>${i.entityName}</b> → ${i.toName} <small>${i.from ? `(hoje: ${i.from})` : '(sem área)'}</small>`)}
          ${notes.length
            ? html`<h4>Não dá para sincronizar</h4>
                ${notes.map((x) => html`<p class="hint">• <b>${x.entity}</b>: ${x.reason}</p>`)}`
            : nothing}
        </div>
        <div class="row">
          <button @click=${() => (this._sync = undefined)} ?disabled=${busy}>Voltar</button>
          ${this._syncSaveAfter
            ? html`<button @click=${() => ((this._sync = undefined), this._emit('editor-save', this.buildConfig()))} ?disabled=${busy}>
                Salvar sem mexer no HA
              </button>`
            : nothing}
          <button class="primary" @click=${this._applySync} ?disabled=${busy || !n}>
            ${busy ? 'Aplicando…' : this._syncSaveAfter ? `Aplicar ${n} e salvar` : `Aplicar ${n} no HA`}
          </button>
        </div>
      </div>
    </div>`;
  }

  private async _createAreaFor(r: RoomConfig) {
    if (!this.hass) return;
    const name = (r.name || '').trim();
    if (!name) return this._createArea(r);
    const existing = this._allAreas().find((a) => a.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) return this._linkArea(r, existing.id);
    try {
      const res = await this.hass.callWS<{ area_id: string; name: string }>({ type: 'config/area_registry/create', name });
      this._newAreas[res.area_id] = res.name;
      this._linkArea(r, res.area_id);
    } catch (e) {
      this._say(`Não consegui criar a área: ${(e as Error).message ?? e}`);
    }
  }

  private _emit(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private _goFloor(i: number) {
    this._fi = i;
    this._sel = null;
    this._draft = undefined;
    requestAnimationFrame(() => this.fit());
  }

  private _addFloor() {
    this._commit();
    this._floors = [...this._floors, { name: this._floors.length === 1 ? 'Superior' : `Piso ${this._floors.length + 1}`, rooms: [] }];
    this._goFloor(this._floors.length - 1);
    this._say('Piso novo. O de baixo aparece tracejado para ajudar a alinhar.');
  }

  private _renderSvg() {
    const v = this._view;
    const k = 1 / v.s; // 1 pixel em metros
    const el = this._svg;
    const W = el?.clientWidth ?? 1000;
    const H = el?.clientHeight ?? 700;
    const gx0 = Math.floor(-v.x / v.s) - 1;
    const gy0 = Math.floor(-v.y / v.s) - 1;
    const gw = W / v.s + 3;
    const gh = H / v.s + 3;
    const f = this._floor;
    const below = this._floors[this._fi - 1];
    const sel = this._sel;
    const rooms = this._rooms;
    const cursor = { select: 'default', bg: 'move' }[this._tool as string] ?? 'crosshair';

    return html`<svg
      class="plan"
      style="cursor:${cursor}"
      @pointerdown=${this._onDown}
      @pointermove=${this._onMove}
      @pointerup=${this._onUp}
      @pointercancel=${this._onUp}
      @wheel=${this._onWheel}
      @dblclick=${this._onDbl}
      @contextmenu=${(e: Event) => e.preventDefault()}
    >
      <defs>
        <pattern id="g1" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M1 0H0V1" fill="none" stroke="rgba(255,255,255,.08)" stroke-width=${k} />
        </pattern>
      </defs>
      <g transform="translate(${v.x} ${v.y}) scale(${v.s})">
        <rect x=${gx0} y=${gy0} width=${gw} height=${gh} fill="url(#g1)" />
        ${f.background ? this._renderBg(f.background) : nothing}
        ${below
          ? below.rooms.map(
              (r) => svg`<polygon points=${pts(roomPoly(r))} fill="none" stroke="rgba(255,255,255,.35)" stroke-width=${1.5 * k} stroke-dasharray="${6 * k} ${5 * k}" />`,
            )
          : nothing}
        ${rooms.map((r, ri) => this._renderRoom(r, ri, k))}
        ${(f.stairs ?? []).map((s, si) => this._renderStairs(s.from, s.to, s.width ?? 0.9, k, sel?.k === 'stairs' && sel.si === si, si))}
        ${rooms.map((r, ri) => this._renderOpenings(r, ri, k))}
        ${rooms.map((r, ri) => this._renderLabel(r, k))}
        ${rooms.map((r, ri) => this._renderDevices(r, ri, k))}
        ${sel?.k === 'room' && rooms[sel.ri] ? this._renderHandles(rooms[sel.ri], sel.ri, k) : nothing}
        ${this._renderDraft(k)}
      </g>
    </svg>`;
  }

  private _renderBg(bg: BackgroundConfig) {
    return svg`<image href=${bg.image} x=${bg.x} y=${bg.y} width=${bg.width} height=${bg.height}
      preserveAspectRatio="none" opacity=${bg.opacity ?? 0.55} style="pointer-events:none" />
      ${this._tool === 'bg' ? svg`<rect x=${bg.x} y=${bg.y} width=${bg.width} height=${bg.height} fill="none" stroke="#ffb45c" stroke-width=${2 / this._view.s} />` : nothing}`;
  }

  private _renderRoom(r: RoomConfig, ri: number, k: number) {
    const poly = roomPoly(r);
    const selected = this._sel?.k === 'room' && this._sel.ri === ri;
    const walls: TemplateResult[] = [];
    for (let e = 0; e < poly.length; e++) {
      const [a, b] = edge(poly, e);
      const len = dist(a, b);
      if (len < 1e-6) continue;
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      for (const [s0, s1] of wallSegments(len, (r.openings ?? []).filter((o) => o.edge === e)))
        walls.push(svg`<line x1=${a[0] + ux * s0} y1=${a[1] + uy * s0} x2=${a[0] + ux * s1} y2=${a[1] + uy * s1}
          stroke=${selected ? '#ffe2b8' : '#d9d4ca'} stroke-width=${Math.max(0.12, 3 * k)} stroke-linecap="square" style="pointer-events:none" />`);
    }
    return svg`<polygon data-kind="room" data-ri=${ri} points=${pts(poly)} fill=${r.color ?? '#9fb4c7'}
        fill-opacity=${selected ? 0.55 : 0.3} style="cursor:${this._tool === 'select' ? 'move' : 'inherit'}" />
      ${walls}`;
  }

  private _renderOpenings(r: RoomConfig, ri: number, k: number) {
    const poly = roomPoly(r);
    return (r.openings ?? []).map((o, oi) => {
      const w = openingWorld(poly, o);
      if (!w) return nothing;
      const selected = this._sel?.k === 'opening' && this._sel.ri === ri && this._sel.oi === oi;
      return svg`<line x1=${w[0][0]} y1=${w[0][1]} x2=${w[1][0]} y2=${w[1][1]} stroke=${selected ? '#ff3d7f' : '#ffb45c'}
          stroke-width=${3 * k} stroke-dasharray="${5 * k} ${3 * k}" style="pointer-events:none" />
        <line data-kind="opening" data-ri=${ri} data-oi=${oi} x1=${w[0][0]} y1=${w[0][1]} x2=${w[1][0]} y2=${w[1][1]}
          stroke="transparent" stroke-width=${18 * k} style="cursor:${this._tool === 'select' ? 'ew-resize' : 'inherit'}" />`;
    });
  }

  private _renderLabel(r: RoomConfig, k: number) {
    const poly = roomPoly(r);
    if (poly.length < 3) return nothing;
    const [cx, cy] = centroid(poly);
    const area = Math.abs(signedArea(poly));
    return svg`<text x=${cx} y=${cy} text-anchor="middle" font-size=${13 * k} fill="#fff" font-weight="600" style="pointer-events:none">${this._label(r)}</text>
      <text x=${cx} y=${cy + 15 * k} text-anchor="middle" font-size=${11 * k} fill="rgba(255,255,255,.6)" style="pointer-events:none">${area.toFixed(1)} m²</text>`;
  }

  private _renderDevices(r: RoomConfig, ri: number, k: number) {
    return ((r.devices ?? []) as DeviceConfig[]).map((d, di) => {
      const p = d.pos ?? centroid(roomPoly(r));
      const domain = d.speaker ? 'speaker' : this._isLight(d) ? 'light' : d.entity?.split('.')[0] ?? '';
      const selected = this._sel?.k === 'device' && this._sel.ri === ri && this._sel.di === di;
      const name = d.name ?? (d.speaker || this.hass?.states[d.entity!]?.attributes.friendly_name || d.entity);
      const showName = selected || (this._sel?.k === 'room' && this._sel.ri === ri);
      return svg`<circle data-kind="device" data-ri=${ri} data-di=${di} cx=${p[0]} cy=${p[1]} r=${Math.max(0.14, 7 * k)}
          fill=${DOMAIN_COLOR[domain] ?? '#cfd8dc'} stroke=${selected ? '#ff3d7f' : '#1b1e24'} stroke-width=${(selected ? 3 : 1.5) * k}
          style="cursor:${this._tool === 'select' ? 'grab' : 'inherit'}" />
        ${showName ? svg`<text x=${p[0]} y=${p[1] - 12 * k} text-anchor="middle" font-size=${10 * k} fill="#fff" style="pointer-events:none">${name}</text>` : nothing}`;
    });
  }

  private _renderStairs(a: Vec2, b: Vec2, w: number, k: number, selected: boolean, si: number) {
    const len = dist(a, b);
    if (len < 1e-6) return nothing;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const nx = (-uy * w) / 2;
    const ny = (ux * w) / 2;
    const corners: Vec2[] = [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
    ];
    const steps = Math.max(2, Math.round(len / 0.28));
    const lines = Array.from({ length: steps - 1 }, (_, i) => {
      const t = ((i + 1) / steps) * len;
      const cx = a[0] + ux * t;
      const cy = a[1] + uy * t;
      return svg`<line x1=${cx + nx} y1=${cy + ny} x2=${cx - nx} y2=${cy - ny} stroke="rgba(0,0,0,.35)" stroke-width=${k} style="pointer-events:none" />`;
    });
    return svg`<polygon data-kind=${si >= 0 ? 'stairs' : ''} data-si=${si} points=${pts(corners)} fill="#b9a58a" fill-opacity=".85"
        stroke=${selected ? '#ff3d7f' : '#8d7a60'} stroke-width=${(selected ? 3 : 1) * k} style="cursor:${this._tool === 'select' ? 'move' : 'inherit'}" />
      ${lines}
      <line x1=${a[0]} y1=${a[1]} x2=${b[0] - ux * 0.25} y2=${b[1] - uy * 0.25} stroke="#1b1e24" stroke-width=${2 * k} style="pointer-events:none" />
      <circle cx=${b[0] - ux * 0.25} cy=${b[1] - uy * 0.25} r=${4 * k} fill="#1b1e24" style="pointer-events:none" />`;
  }

  private _renderHandles(r: RoomConfig, ri: number, k: number) {
    const poly = roomPoly(r);
    return svg`${poly.map((_, e) => {
      const [a, b] = edge(poly, e);
      return svg`<circle data-kind="mid" data-ri=${ri} data-e=${e} cx=${(a[0] + b[0]) / 2} cy=${(a[1] + b[1]) / 2} r=${5 * k}
        fill="#ffb45c" fill-opacity=".8" style="cursor:copy" />`;
    })}
    ${poly.map(
      (p, vi) => svg`<circle data-kind="vertex" data-ri=${ri} data-vi=${vi} cx=${p[0]} cy=${p[1]} r=${8 * k}
        fill="#fff" stroke="#ff3d7f" stroke-width=${2 * k} style="cursor:grab" />`,
    )}`;
  }

  private _renderDraft(k: number) {
    const d = this._draft;
    const sp = this._scalePts;
    const scale =
      this._tool === 'scale' && sp.length
        ? svg`${sp.length === 2 ? svg`<line x1=${sp[0][0]} y1=${sp[0][1]} x2=${sp[1][0]} y2=${sp[1][1]} stroke="#ff3d7f" stroke-width=${2 * k} />` : nothing}
          ${sp.map((p) => svg`<circle cx=${p[0]} cy=${p[1]} r=${6 * k} fill="#ff3d7f" />`)}`
        : nothing;
    if (!d) return scale;
    if (d.k === 'rect') {
      const x = Math.min(d.a[0], d.b[0]);
      const y = Math.min(d.a[1], d.b[1]);
      const w = Math.abs(d.a[0] - d.b[0]);
      const h = Math.abs(d.a[1] - d.b[1]);
      return svg`<rect x=${x} y=${y} width=${w} height=${h} fill="rgba(255,180,92,.2)" stroke="#ffb45c" stroke-width=${2 * k} />
        <text x=${x + w / 2} y=${y + h / 2} text-anchor="middle" font-size=${12 * k} fill="#fff">${w.toFixed(2)} × ${h.toFixed(2)} m</text>`;
    }
    if (d.k !== 'poly') return this._renderStairs(d.a, d.b, 0.9, k, true, -1);
    const all = d.hover ? [...d.pts, d.hover] : d.pts;
    return svg`<polyline points=${pts(all)} fill="rgba(255,180,92,.15)" stroke="#ffb45c" stroke-width=${2 * k} />
      ${d.pts.map((p, i) => svg`<circle cx=${p[0]} cy=${p[1]} r=${(i === 0 ? 8 : 5) * k} fill=${i === 0 ? '#ff3d7f' : '#ffb45c'} />`)}
      ${d.hover && d.pts.length ? svg`<text x=${d.hover[0]} y=${d.hover[1] - 10 * k} text-anchor="middle" font-size=${11 * k} fill="#fff">${dist(d.pts[d.pts.length - 1], d.hover).toFixed(2)} m</text>` : nothing}`;
  }

  // ---------- painel ----------

  private _renderPanel() {
    const s = this._sel;
    const rooms = this._rooms;
    if (this._tool === 'device') return this._panelDevices();
    if (this._tool === 'scale') return this._panelScale();
    if (s?.k === 'room' && rooms[s.ri]) return this._panelRoom(rooms[s.ri], s.ri);
    if (s?.k === 'opening' && rooms[s.ri]?.openings?.[s.oi]) return this._panelOpening(s.ri, s.oi);
    if (s?.k === 'device' && rooms[s.ri]?.devices?.[s.di]) return this._panelDevice(rooms[s.ri].devices![s.di] as DeviceConfig);
    if (s?.k === 'stairs' && this._floor.stairs?.[s.si]) return this._panelStairs(s.si);
    const help: Partial<Record<Tool, string>> = {
      rect: 'Arraste na planta para desenhar um cômodo retangular. Os cantos se ajustam a uma grade de 5 cm.',
      poly: 'Toque em cada canto do cômodo. Para fechar, toque no primeiro ponto (rosa), dê dois toques ou aperte Enter.',
      door: 'Toque numa parede para abrir uma porta de 80 cm. Ela aparece nos dois cômodos que dividem a parede.',
      stairs: 'Arraste do pé da escada até o topo. A escada sobe deste piso para o piso de cima.',
      bg: 'Arraste para mover a imagem da planta.',
    };
    if (help[this._tool])
      return html`<h3>${TOOLS.find((t) => t[0] === this._tool)?.[1] ?? 'Planta de fundo'}</h3>
        <p class="hint">${help[this._tool]}</p>
        ${this._tool === 'poly' && this._draft?.k === 'poly'
          ? html`<div class="row"><button class="primary" @click=${this._finishPoly}>Concluir contorno</button>
              <button @click=${() => (this._draft = undefined)}>Cancelar</button></div>`
          : nothing}`;
    return this._panelFloor();
  }

  private _panelFloor() {
    const f = this._floor;
    const bg = f.background;
    return html`<h3>Piso</h3>
      <label>Nome<input .value=${f.name} @change=${(e: Event) => this._set(() => (f.name = val(e)))} /></label>
      <label
        >Altura do piso (m)
        <input
          type="number"
          step="0.1"
          placeholder=${(this._fi * 2.9).toFixed(1)}
          .value=${f.elevation ?? ''}
          @change=${(e: Event) => this._set(() => (f.elevation = num(e)))}
      /></label>
      ${this._floors.length > 1
        ? html`<button class="danger" @click=${this._deleteFloor}>Excluir este piso</button>`
        : nothing}

      ${this.hass?.areas
        ? html`<h3>Áreas do HA</h3>
            <p class="hint">Cada cômodo pode usar o nome de uma área do HA. Selecione o cômodo para escolher ou criar a área.</p>
            <button @click=${this._autoLink}>Ligar cômodos às áreas de mesmo nome</button>
            <button @click=${() => this._openSync(false)}>Comparar com as áreas do HA…</button>`
        : nothing}

      <h3>Planta de fundo</h3>
      ${bg
        ? html`<label
              >Transparência
              <input type="range" min="0.1" max="1" step="0.05" .value=${String(bg.opacity ?? 0.55)}
                @input=${(e: Event) => ((bg.opacity = num(e)), this.requestUpdate())} /></label>
            <div class="row">
              <button @click=${() => this._setTool('scale')}>Calibrar escala</button>
              <button class=${this._tool === 'bg' ? 'sel' : ''} @click=${() => this._setTool(this._tool === 'bg' ? 'select' : 'bg')}>Mover imagem</button>
            </div>
            <button class="danger" @click=${() => this._set(() => delete f.background)}>Remover imagem</button>`
        : html`<p class="hint">Use uma foto ou print da planta para desenhar por cima. Ela só aparece aqui no editor.</p>
            <label class="file">Escolher imagem<input type="file" accept="image/*" @change=${this._upload} /></label>`}

      <h3>Como usar</h3>
      <ul class="hint">
        <li><b>Cômodo</b>: arraste um retângulo. Depois arraste os cantos brancos ou toque nos pontos laranja para criar cantos novos.</li>
        <li><b>Porta</b>: toque numa parede.</li>
        <li><b>Dispositivo</b>: escolha na lista e toque na planta.</li>
        <li>Para navegar, use dois dedos ou a roda do mouse. No modo Selecionar, arrastar o vazio move a planta.</li>
        <li>Delete apaga, Ctrl+Z desfaz.</li>
      </ul>
      ${!this._rooms.length && this._floors.length === 1
        ? html`<button @click=${this._loadExample}>Começar com o sobrado de exemplo</button>`
        : nothing}`;
  }

  private _loadExample() {
    this._commit();
    this._floors = toFloors({ type: '', floors: DEMO_FLOORS });
    this._fi = 0;
    requestAnimationFrame(() => this.fit());
  }

  private _deleteFloor() {
    if (!confirm(`Excluir o piso "${this._floor.name}" e tudo que está nele?`)) return;
    this._commit();
    this._floors = this._floors.filter((_, i) => i !== this._fi);
    this._goFloor(Math.max(0, this._fi - 1));
  }

  private _panelScale() {
    const sp = this._scalePts;
    if (!this._floor.background)
      return html`<h3>Calibrar escala</h3>
        <p class="hint">Primeiro adicione a imagem da planta, no painel do piso.</p>
        <button @click=${() => this._setTool('select')}>Voltar</button>`;
    const measured = sp.length === 2 ? dist(sp[0], sp[1]) : 0;
    return html`<h3>Calibrar escala</h3>
      <p class="hint">
        Toque nas duas pontas de algo cuja medida você conhece, como uma parede com cota na planta ou a largura de uma
        porta. Use zoom para acertar.
      </p>
      ${sp.length === 2
        ? html`<label
              >Medida real (m)
              <input id="real" type="number" step="0.01" min="0.1" placeholder="ex.: 3.50" autofocus
                @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this._applyScale(num(e))} /></label>
            <p class="hint">Medido agora: ${measured.toFixed(2)} m na escala atual.</p>
            <button class="primary" @click=${() => this._applyScale(Number((this.renderRoot.querySelector('#real') as HTMLInputElement).value))}>
              Aplicar escala
            </button>`
        : html`<p class="hint">${sp.length ? 'Agora toque na outra ponta.' : 'Toque na primeira ponta.'}</p>`}
      <button @click=${() => this._setTool('select')}>Cancelar</button>`;
  }

  private _panelRoom(r: RoomConfig, ri: number) {
    const sensors = (dc: string[], domain = 'sensor') =>
      Object.values(this.hass?.states ?? {}).filter(
        (s) => s.entity_id.startsWith(`${domain}.`) && dc.includes(s.attributes.device_class),
      );
    const opt = (id: string, label: string, cur?: string) => html`<option value=${id} ?selected=${cur === id}>${label}</option>`;
    const pick = (key: 'temperature' | 'humidity' | 'motion', list: { entity_id: string; attributes: any }[]) => html`<select
      @change=${(e: Event) => this._set(() => (r[key] = val(e) || undefined))}>
      ${opt('', '—', r[key] ?? '')}
      ${list.map((s) => opt(s.entity_id, s.attributes.friendly_name ?? s.entity_id, r[key]))}
    </select>`;
    const areas = this._allAreas();
    const floorsHA = Object.values(this.hass?.floors ?? {}).sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    const groups: [string, typeof areas][] = floorsHA.length
      ? [...floorsHA.map((f) => [f.name, areas.filter((a) => a.floor === f.floor_id)] as [string, typeof areas]), ['Sem andar', areas.filter((a) => !floorsHA.some((f) => f.floor_id === a.floor))]]
      : [['', areas]];
    const areaSelect = html`<select
      @change=${(e: Event) => {
        const v = val(e);
        if (v === '__new__') this._createArea(r);
        else this._linkArea(r, v);
      }}>
      ${opt('', '— nenhuma —', r.area ?? '')}
      ${groups
        .filter(([, list]) => list.length)
        .map(([label, list]) =>
          label
            ? html`<optgroup label=${label}>${list.map((a) => opt(a.id, a.name, r.area))}</optgroup>`
            : list.map((a) => opt(a.id, a.name, r.area)),
        )}
      ${this.hass ? html`<option value="__new__">＋ Nova área…</option>` : nothing}
    </select>`;
    const poly = roomPoly(r);
    return html`<h3>Cômodo</h3>
      ${this.hass ? html`<label>Área do HA ${areaSelect}</label>` : nothing}
      ${this.hass && !r.area && r.name
        ? html`<button @click=${() => this._createAreaFor(r)}>Criar área “${r.name}” no HA</button>`
        : nothing}
      <label
        >${r.area ? 'Nome (opcional: substitui o da área)' : 'Nome'}
        <input
          .value=${r.name ?? ''}
          placeholder=${r.area ? this._areaName(r.area) : 'Nome do cômodo'}
          @change=${(e: Event) =>
            this._set(() => {
              const v = val(e).trim();
              if (v) r.name = v;
              else if (r.area) delete r.name;
            })}
      /></label>
      ${r.area && !r.name
        ? html`<p class="hint">O nome vem da área "${this._areaName(r.area)}": se você renomear a área no HA, muda aqui também.</p>`
        : nothing}
      ${r.area ? html`<button @click=${() => this._addAreaDevices(ri)}>Adicionar dispositivos de "${this._areaName(r.area)}"</button>` : nothing}
      <div class="row">
        <label>Cor<input type="color" .value=${r.color ?? '#9fb4c7'} @change=${(e: Event) => this._set(() => (r.color = val(e)))} /></label>
        <label
          >Paredes (m)
          <input type="number" step="0.1" min="0" placeholder="1.0" .value=${r.wall_height ?? ''}
            @change=${(e: Event) => this._set(() => (r.wall_height = num(e) || undefined))} /></label>
      </div>
      ${this.hass
        ? html`<label>Temperatura ${pick('temperature', sensors(['temperature']))}</label>
            <label>Umidade ${pick('humidity', sensors(['humidity']))}</label>
            <label>Presença ${pick('motion', sensors(['motion', 'occupancy', 'presence'], 'binary_sensor'))}</label>`
        : nothing}
      <p class="hint">
        ${Math.abs(signedArea(poly)).toFixed(1)} m² · ${poly.length} cantos · ${(r.devices ?? []).length} dispositivo(s) ·
        ${(r.openings ?? []).length} porta(s)
      </p>
      <p class="hint">Arraste os cantos brancos para ajustar. Os pontos laranja no meio das paredes criam cantos novos.</p>
      ${this._sel?.k === 'room' ? html`<div class="row">
        ${poly.length > 3
          ? html`<button @click=${() => this._removeLastVertex(ri)}>Remover último canto</button>`
          : nothing}
      </div>` : nothing}
      <button class="danger" @click=${this._deleteSel}>Excluir cômodo</button>`;
  }

  private _removeLastVertex(ri: number) {
    this._commit();
    removeVertex(this._rooms[ri], roomPoly(this._rooms[ri]).length - 1);
    this.requestUpdate();
  }

  private _panelOpening(ri: number, oi: number) {
    const o = this._rooms[ri].openings![oi];
    const links = linkedOpenings(this._rooms, ri, oi);
    return html`<h3>Porta / passagem</h3>
      <label
        >Largura: ${o.width.toFixed(2)} m
        <input type="range" min="0.5" max="4" step="0.05" .value=${String(o.width)}
          @input=${(e: Event) => {
            for (const [rj, oj] of links) resizeOpening(this._rooms[rj], this._rooms[rj].openings![oj], num(e));
            this.requestUpdate();
          }}
          @pointerdown=${() => this._commit()} /></label>
      <p class="hint">Arraste a porta ao longo da parede para mudar a posição. ${links.length > 1 ? 'Ela aparece nos dois cômodos.' : ''}</p>
      <button class="danger" @click=${this._deleteSel}>Fechar vão</button>`;
  }

  /** mais um ponto de luz da mesma tecla (ex.: vários spots no teto) */
  private _addSpot() {
    const s = this._sel;
    if (s?.k !== 'device') return;
    const r = this._rooms[s.ri];
    const d = r.devices![s.di] as DeviceConfig;
    this._commit();
    const p = d.pos ?? centroid(roomPoly(r));
    let pos = snapP([p[0] + 0.8, p[1]]);
    if (!pointInPoly(pos, roomPoly(r))) pos = snapP([p[0] - 0.8, p[1]]);
    r.devices!.push({ ...d, pos });
    this._sel = { k: 'device', ri: s.ri, di: r.devices!.length - 1 };
    this._say('Ponto de luz adicionado. Arraste para o lugar do spot.');
  }

  /** o pino é desenhado como luz? (explícito, ou tecla de interruptor por padrão) */
  private _isLight(d: DeviceConfig) {
    return !d.speaker && !!d.entity && (d.light ?? isLightSwitch(d.entity));
  }

  private _panelDevice(d: DeviceConfig) {
    const st = d.entity ? this.hass?.states[d.entity] : undefined;
    const domain = d.entity?.split('.')[0];
    const asLight = this._isLight(d);
    const canBeLight = !d.speaker && ['switch', 'input_boolean', 'light'].includes(domain ?? '');
    const spots = d.entity ? this._rooms.flatMap((r) => (r.devices ?? []) as DeviceConfig[]).filter((x) => x.entity === d.entity).length : 0;
    return html`<h3>${d.speaker ? 'Caixa de som' : asLight && domain !== 'light' ? 'Luz (por interruptor)' : 'Dispositivo'}</h3>
      ${canBeLight && domain !== 'light'
        ? html`<label class="check"
            ><input type="checkbox" .checked=${asLight} @change=${(e: Event) => this._set(() => {
              const on = (e.target as HTMLInputElement).checked;
              // padrão da tecla: não grava nada; diferente do padrão: grava explícito
              d.light = on === isLightSwitch(d.entity!) ? undefined : on;
            })} />
            Acende uma lâmpada (mostrar como luz)</label
          >`
        : nothing}
      ${asLight || domain === 'light'
        ? html`<button @click=${this._addSpot}>+ Outro ponto de luz desta tecla</button>
            ${spots > 1 ? html`<p class="hint">Esta tecla aparece em ${spots} pontos na planta.</p>` : nothing}`
        : nothing}
      <p><b>${d.speaker ?? st?.attributes.friendly_name ?? d.entity}</b><br /><span class="hint">${d.speaker ? 'Spotify' : d.entity}</span></p>
      <label>Nome no mapa<input placeholder="automático" .value=${d.name ?? ''} @change=${(e: Event) => this._set(() => (d.name = val(e) || undefined))} /></label>
      <label
        >Altura (m)
        <input type="number" step="0.1" min="0.1" placeholder="automática" .value=${d.height ?? ''}
          @change=${(e: Event) => this._set(() => (d.height = num(e) || undefined))} /></label>
      <p class="hint">Arraste para mudar de lugar, inclusive para outro cômodo.</p>
      <button class="danger" @click=${this._deleteSel}>Remover da planta</button>`;
  }

  private _panelStairs(si: number) {
    const s = this._floor.stairs![si];
    return html`<h3>Escada</h3>
      <label
        >Largura: ${(s.width ?? 0.9).toFixed(2)} m
        <input type="range" min="0.6" max="2" step="0.05" .value=${String(s.width ?? 0.9)}
          @pointerdown=${() => this._commit()}
          @input=${(e: Event) => ((s.width = num(e)), this.requestUpdate())} /></label>
      <p class="hint">A seta aponta para onde a escada sobe.</p>
      <button @click=${() => this._set(() => ([s.from, s.to] = [s.to, s.from]))}>Inverter sentido</button>
      <button class="danger" @click=${this._deleteSel}>Excluir escada</button>`;
  }

  private _panelDevices() {
    const hass = this.hass;
    const q = this._q.trim().toLowerCase();
    const placed = this._placed();
    const music = this.initial?.music?.entity;
    const speakers: string[] = music ? (hass?.states[music]?.attributes.source_list ?? []).filter((x: string) => x) : [];
    const ents = Object.values(hass?.states ?? {})
      .filter((s) => PLACEABLE.includes(s.entity_id.split('.')[0]) && !hass?.entities?.[s.entity_id]?.hidden)
      .map((s) => ({ id: s.entity_id, name: (s.attributes.friendly_name as string) ?? s.entity_id, area: this._areaName(this._entityArea(s.entity_id)) }))
      .filter((x) => !q || `${x.name} ${x.id} ${x.area}`.toLowerCase().includes(q))
      .sort((a, b) => (a.area || 'zzz').localeCompare(b.area || 'zzz') || a.name.localeCompare(b.name));
    const pend = this._pending;
    const item = (dev: DeviceConfig, label: string, sub: string, key: string) => {
      const isSel = pend && (pend.entity ?? `speaker:${pend.speaker}`) === (dev.entity ?? `speaker:${dev.speaker}`);
      return html`<button class="ent ${isSel ? 'sel' : ''} ${placed.has(key) ? 'placed' : ''}" @click=${() => {
        this._pending = dev;
        this._say(`Toque na planta onde fica "${label}".`);
      }}>
        <i style="background:${DOMAIN_COLOR[dev.speaker ? 'speaker' : key.split('.')[0]] ?? '#cfd8dc'}"></i>
        <span><b>${label}</b><small>${sub}</small></span>${placed.has(key) ? html`<em>✓</em>` : nothing}
      </button>`;
    };
    let lastArea = '\u0000';
    return html`<h3>Dispositivos</h3>
      <p class="hint">${pend ? 'Agora toque na planta.' : 'Escolha um item e toque na planta para colocá-lo. ✓ = já está na planta.'}</p>
      <input class="search" type="search" placeholder="Buscar entidade…" .value=${this._q} @input=${(e: Event) => (this._q = val(e))} />
      <div class="ents">
        ${speakers.length
          ? html`<div class="grp">Caixas de som (Spotify)</div>
              ${speakers
                .filter((sp) => !q || sp.toLowerCase().includes(q))
                .map((sp) => item({ speaker: sp }, sp, 'caixa', `speaker:${sp}`))}`
          : nothing}
        ${ents.slice(0, 300).map((x) => {
          const head = x.area !== lastArea ? html`<div class="grp">${x.area || 'Sem área'}</div>` : nothing;
          lastArea = x.area;
          return html`${head}${item({ entity: x.id }, x.name, x.id, x.id)}`;
        })}
        ${!hass ? html`<p class="hint">Sem conexão com o HA.</p>` : nothing}
      </div>`;
  }

  /** muda algo com "desfazer" e redesenha */
  private _set(fn: () => void) {
    this._commit();
    fn();
    this.requestUpdate();
  }

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: block;
      --fg: #eef0f3;
      --muted: #9aa3ae;
      --line: rgba(255, 255, 255, 0.1);
      --acc: #ffb45c;
      color: var(--fg);
      font: 14px/1.35 var(--paper-font-body1_-_font-family, system-ui, -apple-system, sans-serif);
    }
    .ed {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      background: #15181d;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #1b1e24;
    }
    header button,
    aside button,
    .modal button,
    .file {
      min-height: 38px;
      padding: 0 12px;
      border: 0;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.07);
      color: var(--fg);
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    button:disabled {
      opacity: 0.35;
      cursor: default;
    }
    button.sel {
      background: var(--fg);
      color: #15181d;
    }
    button.primary {
      background: var(--acc);
      color: #15181d;
      font-weight: 600;
    }
    button.danger {
      background: rgba(239, 83, 80, 0.15);
      color: #ff8a80;
    }
    .floors,
    .tools,
    .actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .floors .add {
      background: transparent;
      border: 1px dashed rgba(255, 255, 255, 0.25);
    }
    .tools {
      margin: 0 auto;
    }
    .tools button {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tools svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }
    .sep {
      width: 1px;
      height: 24px;
      background: var(--line);
    }
    @media (max-width: 1400px) {
      .tools span {
        display: none;
      }
    }
    main {
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .canvas {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    svg.plan {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      background: #111317;
    }
    .msg {
      position: absolute;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      padding: 8px 14px;
      border-radius: 10px;
      background: rgba(10, 12, 16, 0.9);
      pointer-events: none;
      max-width: 80%;
      text-align: center;
    }
    aside {
      width: 300px;
      flex: none;
      overflow-y: auto;
      padding: 4px 16px 20px;
      border-left: 1px solid var(--line);
      background: #1b1e24;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    h3 {
      margin: 14px 0 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    p {
      margin: 0;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
    }
    ul.hint {
      margin: 0;
      padding-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    input,
    select {
      min-height: 38px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #111317;
      color: var(--fg);
      font: inherit;
      width: 100%;
    }
    input[type='color'] {
      padding: 2px;
    }
    input[type='range'] {
      border: 0;
      background: transparent;
      accent-color: var(--acc);
    }
    .modal {
      position: absolute;
      inset: 0;
      z-index: 5;
      /* flex (não grid): assim a altura máxima da janela tem referência e a lista ganha rolagem */
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.55);
    }
    .modal .sheet {
      width: min(620px, 100%);
      max-height: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 18px 20px;
      border-radius: 16px;
      background: #1b1e24;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }
    .modal h3 {
      margin: 0;
      font-size: 16px;
      text-transform: none;
      letter-spacing: 0;
      color: var(--fg);
    }
    .modal h4 {
      margin: 12px 0 4px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .sync-list {
      overflow-y: auto;
      min-height: 0;
      flex: 1;
    }
    .sync-item {
      flex-direction: row;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
      font-size: 14px;
      color: var(--fg);
    }
    .sync-item input {
      width: 20px;
      min-height: 20px;
      flex: none;
      accent-color: var(--acc);
    }
    .sync-item small {
      color: var(--muted);
    }
    .modal .row {
      justify-content: flex-end;
    }
    .modal .row > * {
      flex: none;
    }
    label.check {
      flex-direction: row;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      color: var(--fg);
    }
    label.check input {
      width: 20px;
      min-height: 20px;
      accent-color: var(--acc);
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .row > * {
      flex: 1;
      min-width: 0;
    }
    aside > * {
      flex: none;
    }
    .file {
      display: grid;
      place-items: center;
      background: var(--acc);
      color: #15181d;
      font-weight: 600;
    }
    .file input {
      display: none;
    }
    .search {
      flex: none;
    }
    .ents {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .grp {
      margin: 10px 0 2px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .ent {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      text-align: left;
      background: transparent;
    }
    .ent i {
      width: 12px;
      height: 12px;
      flex: none;
      border-radius: 50%;
    }
    .ent span {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    .ent b,
    .ent small {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
    }
    .ent small {
      color: var(--muted);
      font-size: 11px;
    }
    .ent.placed {
      opacity: 0.55;
    }
    .ent em {
      font-style: normal;
      color: #1ed760;
    }
    .ent.sel {
      background: var(--acc);
      color: #15181d;
      opacity: 1;
    }
    .ent.sel small {
      color: #15181d;
    }
    @media (max-width: 760px) {
      main {
        flex-direction: column;
      }
      aside {
        width: auto;
        max-height: 42%;
        border-left: 0;
        border-top: 1px solid var(--line);
      }
    }
  `;
}

const pts = (poly: Vec2[]) => poly.map((p) => p.join(',')).join(' ');
const val = (e: Event) => (e.target as HTMLInputElement).value;
const num = (e: Event) => Number((e.target as HTMLInputElement).value);

function imageSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      res({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => res({ w: 4, h: 3 });
    img.src = URL.createObjectURL(file);
  });
}

/** fora do HA: guarda a imagem reduzida dentro da config */
async function downscale(file: File, max: number): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

if (!customElements.get('hadash-editor')) customElements.define('hadash-editor', HadashEditor);
