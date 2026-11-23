import type { CardConfig, DeviceConfig, FloorConfig, OpeningConfig, RoomConfig, StairConfig, Vec2 } from './types';

export interface Device {
  entity: string;
  /** "speaker" para caixas de som (entity = player de música) */
  domain: string;
  /** nome da caixa na lista de fontes do player */
  speaker?: string;
  name?: string;
  pos: Vec2;
  height: number;
  roomId: string;
}

export interface Floor {
  index: number;
  name: string;
  elevation: number;
  rooms: Room[];
  stairs: StairConfig[];
}

export function buildFloors(cfg: CardConfig): Floor[] {
  const fh = cfg.floor_height ?? 2.9;
  const list: FloorConfig[] = cfg.floors?.length
    ? cfg.floors
    : [{ name: 'Casa', rooms: cfg.rooms?.length ? cfg.rooms : [] }];
  const fallback = !cfg.floors?.length && !cfg.rooms?.length;
  const src = fallback ? DEMO_FLOORS : list;
  const used = new Set<string>();
  return src.map((f, index) => ({
    index,
    name: f.name,
    elevation: f.elevation ?? index * fh,
    rooms: buildRooms(f.rooms, index, used, cfg.music?.entity),
    stairs: f.stairs ?? [],
  }));
}

export interface Room {
  id: string;
  name: string;
  floor: number;
  area?: string;
  poly: Vec2[];
  color: string;
  wallHeight?: number;
  openings: OpeningConfig[];
  center: Vec2;
  /** [minX, minY, maxX, maxY] */
  bbox: [number, number, number, number];
  temperature?: string;
  humidity?: string;
  motion?: string;
  devices: Device[];
}

const ROOM_COLORS = ['#c9b79c', '#a9c0a6', '#9fb4c7', '#c7a9a9', '#b7a9c7', '#c7c09f', '#9fc7c0', '#c7b39f'];

export function buildRooms(
  configs: RoomConfig[],
  floor = 0,
  used = new Set<string>(),
  musicEntity?: string,
): Room[] {
  return configs.map((rc, i) => {
    let id = rc.id ?? slug(rc.name || rc.area || 'comodo');
    while (used.has(id)) id += '_';
    used.add(id);
    const poly = roomPolygon(rc);
    const bbox = bounds(poly);
    const center = polygonCentroid(poly);
    const room: Room = {
      id,
      name: rc.name ?? '',
      floor,
      area: rc.area,
      poly,
      color: rc.color ?? ROOM_COLORS[i % ROOM_COLORS.length],
      wallHeight: rc.wall_height,
      openings: rc.openings ?? [],
      center,
      bbox,
      temperature: rc.temperature,
      humidity: rc.humidity,
      motion: rc.motion,
      devices: [],
    };
    const devs = (rc.devices ?? [])
      .map((d) => (typeof d === 'string' ? { entity: d } : d))
      // caixa de som sem player de música configurado não tem o que controlar
      .filter((d) => d.entity || (d.speaker && musicEntity));
    const unplaced = devs.filter((d) => !d.pos);
    room.devices = devs.map((d) => toDevice(d, room, unplaced.indexOf(d), unplaced.length, musicEntity));
    return room;
  });
}

function toDevice(d: DeviceConfig, room: Room, idx: number, count: number, musicEntity?: string): Device {
  const speaker = d.speaker;
  const entity = (speaker ? d.entity ?? musicEntity : d.entity)!;
  // interruptor marcado como luz aparece e ilumina como lâmpada (o comando continua indo para o interruptor);
  // teclas de interruptor de parede (…_l1, …_l2) já são luz por padrão, a não ser que `light: false`
  const domain = speaker ? 'speaker' : (d.light ?? isLightSwitch(entity)) ? 'light' : entity.split('.')[0];
  return {
    entity,
    domain,
    speaker,
    name: d.name,
    pos: d.pos ?? autoPlace(room, idx, count),
    height: d.height ?? (domain === 'light' ? 1.4 : domain === 'speaker' ? 0.8 : 0.4),
    roomId: room.id,
  };
}

/** sem posição: distribui num círculo em volta do centro do cômodo */
function autoPlace(room: Room, idx: number, count: number): Vec2 {
  if (count <= 1) return room.center;
  const [x0, y0, x1, y1] = room.bbox;
  const r = Math.min(x1 - x0, y1 - y0) * 0.28;
  const a = (idx / count) * Math.PI * 2 - Math.PI / 2;
  return [room.center[0] + Math.cos(a) * r, room.center[1] + Math.sin(a) * r];
}

function roomPolygon(rc: RoomConfig): Vec2[] {
  if (rc.polygon && rc.polygon.length >= 3) return rc.polygon;
  if (rc.rect) {
    const [x, y, w, d] = rc.rect;
    return [
      [x, y],
      [x + w, y],
      [x + w, y + d],
      [x, y + d],
    ];
  }
  throw new Error(`hadash-card: cômodo "${rc.name ?? rc.area}" precisa de \`rect\` ou \`polygon\`.`);
}

type Areas = Record<string, { name: string }> | undefined;

/** tecla de interruptor de parede (switch.*_l1, _l2…) ou nome de luz: provavelmente acende uma lâmpada */
export function isLightSwitch(entity: string, name?: string): boolean {
  if (!/^switch\./.test(entity)) return false;
  return /_l\d+$/.test(entity) || /\b(luz|luzes|light|lamp|lâmpada|led|spot|lustre|pendente|abajur)\b/i.test(name ?? '');
}

/** nome mostrado: o próprio, senão o da área do HA, senão o id da área */
export function roomLabel(r: { name?: string; area?: string }, areas?: Areas): string {
  return r.name || (r.area && areas?.[r.area]?.name) || r.area || 'Cômodo';
}

export function bounds(poly: Vec2[]): [number, number, number, number] {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function polygonCentroid(poly: Vec2[]): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const [x0, y0, x1, y1] = bounds(poly);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** trechos sólidos de uma parede de comprimento `len`, tirando os vãos */
export function wallSegments(len: number, openings: OpeningConfig[]): [number, number][] {
  const holes = openings
    .map((o) => [Math.max(0, o.at), Math.min(len, o.at + o.width)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cur = 0;
  for (const [a, b] of holes) {
    if (a > cur + 0.01) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (len > cur + 0.01) out.push([cur, len]);
  return out;
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** sobrado de exemplo (o seu entra via YAML em `floors:` ou `rooms:`) */
export const DEMO_FLOORS: FloorConfig[] = [
  {
    name: 'Térreo',
    stairs: [{ from: [8.2, 7.8], to: [8.2, 5.4], width: 1.0 }],
    rooms: [
      {
        name: 'Sala',
        rect: [0, 0, 6, 5],
        temperature: 'sensor.sala_temperatura',
        humidity: 'sensor.sala_umidade',
        motion: 'binary_sensor.sala_presenca',
        openings: [
          { edge: 1, at: 1, width: 1.6 },
          { edge: 2, at: 1.5, width: 3 },
        ],
        devices: [
          { entity: 'light.sala_teto', pos: [3, 2.4] },
          { entity: 'light.sala_abajur', pos: [0.6, 4.4], height: 0.9 },
          { entity: 'media_player.tv_sala', pos: [3, 0.35], height: 0.7 },
          { entity: 'climate.ar_sala', pos: [5.6, 0.35], height: 1.0 },
          { speaker: 'Home theater', pos: [4.2, 0.4], height: 0.7 },
        ],
      },
      {
        name: 'Cozinha',
        rect: [6, 0, 4, 4.2],
        temperature: 'sensor.cozinha_temperatura',
        openings: [
          { edge: 3, at: 1.6, width: 1.6 },
          { edge: 2, at: 0.6, width: 1 },
        ],
        devices: [
          { entity: 'light.cozinha', pos: [8, 2] },
          { entity: 'switch.cafeteira', pos: [9.5, 0.4], height: 0.9 },
          { speaker: 'Sala 2', pos: [6.5, 0.4], height: 0.9 },
        ],
      },
      {
        name: 'Lavabo',
        rect: [6, 4.2, 1.4, 1.8],
        openings: [{ edge: 1, at: 0.5, width: 0.7 }],
        devices: [{ entity: 'light.lavabo', pos: [6.7, 5.1] }],
      },
      {
        name: 'Lavanderia',
        rect: [6, 6, 1.4, 2],
        openings: [{ edge: 1, at: 0.1, width: 0.7 }],
        devices: [{ entity: 'switch.maquina_lavar', pos: [6.7, 7.3] }],
      },
      {
        name: 'Hall',
        rect: [7.4, 4.2, 2.6, 3.8],
        openings: [
          { edge: 0, at: 1.0, width: 1 },
          { edge: 3, at: 2.6, width: 0.7 },
          { edge: 3, at: 1.2, width: 0.7 },
        ],
        devices: [
          { entity: 'light.hall', pos: [9.3, 6.2] },
          { entity: 'lock.porta_entrada', pos: [9.85, 7.4], height: 1.0 },
        ],
      },
      {
        name: 'Varanda',
        rect: [0, 5, 6, 3],
        wall_height: 0.5,
        openings: [{ edge: 0, at: 1.5, width: 3 }],
        devices: [
          { entity: 'light.varanda', pos: [3, 6.5] },
          { entity: 'binary_sensor.porta_varanda', pos: [3, 5], height: 0.9 },
        ],
      },
    ],
  },
  {
    name: 'Superior',
    rooms: [
      {
        name: 'Suíte',
        rect: [0, 0, 4.5, 4],
        temperature: 'sensor.suite_temperatura',
        motion: 'binary_sensor.suite_presenca',
        openings: [{ edge: 2, at: 1.5, width: 0.8 }],
        devices: [
          { entity: 'light.suite', pos: [2.25, 2] },
          { entity: 'climate.ar_suite', pos: [0.35, 2], height: 1.8 },
          { entity: 'cover.cortina_suite', pos: [2.25, 0.3], height: 1.0 },
          { speaker: 'Suite', pos: [4.1, 3.6], height: 0.6 },
        ],
      },
      {
        name: 'Quarto 1',
        rect: [4.5, 0, 3, 4],
        temperature: 'sensor.quarto1_temperatura',
        openings: [{ edge: 2, at: 0.6, width: 0.8 }],
        devices: [
          { entity: 'light.quarto_1', pos: [6, 2] },
          { entity: 'fan.ventilador_quarto_1', pos: [4.9, 0.5] },
        ],
      },
      {
        name: 'Banheiro',
        rect: [7.5, 0, 2.5, 4],
        humidity: 'sensor.banheiro_umidade',
        openings: [{ edge: 2, at: 0.8, width: 0.8 }],
        devices: [{ entity: 'light.banheiro', pos: [8.75, 2] }],
      },
      {
        name: 'Corredor',
        rect: [0, 4, 10, 1.4],
        openings: [
          { edge: 0, at: 2.2, width: 0.8 },
          { edge: 0, at: 6.1, width: 0.8 },
          { edge: 0, at: 8.4, width: 0.8 },
          { edge: 2, at: 7.6, width: 0.8 },
          { edge: 2, at: 4.2, width: 0.8 },
          { edge: 2, at: 1.3, width: 1.2 },
        ],
        devices: [{ entity: 'light.corredor', pos: [5, 4.7] }],
      },
      {
        name: 'Quarto 2',
        rect: [0, 5.4, 4, 2.6],
        temperature: 'sensor.quarto2_temperatura',
        openings: [{ edge: 0, at: 1.6, width: 0.8 }],
        devices: [{ entity: 'light.quarto_2', pos: [2, 6.7] }],
      },
      {
        name: 'Escritório',
        rect: [4, 5.4, 3, 2.6],
        openings: [{ edge: 0, at: 1, width: 0.8 }],
        devices: [
          { entity: 'light.escritorio', pos: [5.5, 6.7] },
          { entity: 'switch.computador', pos: [6.5, 7.6], height: 0.8 },
        ],
      },
    ],
  },
];
