import type { DeviceConfig, FloorConfig, Hass, RoomConfig } from './types';

/**
 * Sincronização planta -> registro do HA (áreas, andares e área de cada entidade).
 * Regras: nunca apaga nem renomeia nada no HA; tudo passa por confirmação (cada item pode ser desmarcado).
 */

export type SyncItem =
  | { kind: 'floor'; key: string; checked: boolean; fi: number; name: string; level: number }
  | { kind: 'area'; key: string; checked: boolean; room: RoomConfig; fi: number; name: string; existing?: string }
  | { kind: 'area-floor'; key: string; checked: boolean; room: RoomConfig; fi: number; areaName: string; floorName: string; from?: string }
  | {
      kind: 'entity';
      key: string;
      checked: boolean;
      room: RoomConfig;
      entity: string;
      entityName: string;
      toName: string;
      from?: string;
    };

export interface SyncNote {
  entity: string;
  reason: string;
}

const norm = (x: string) =>
  x
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** área efetiva da entidade: a própria, senão a do aparelho */
export function entityArea(hass: Hass, id: string): string | undefined {
  const e = hass.entities?.[id];
  return (e?.area_id ?? (e?.device_id ? hass.devices?.[e.device_id]?.area_id : undefined)) ?? undefined;
}

function haFloorByName(hass: Hass, name: string) {
  return Object.values(hass.floors ?? {}).find((f) => norm(f.name) === norm(name));
}

export function computePlan(floors: FloorConfig[], hass: Hass): { items: SyncItem[]; notes: SyncNote[] } {
  const items: SyncItem[] = [];
  const notes: SyncNote[] = [];
  const areaName = (id?: string) => (id ? hass.areas?.[id]?.name ?? id : undefined);
  const multiFloor = floors.length > 1;

  // andares do HA (só faz sentido com mais de um piso na planta)
  if (multiFloor)
    floors.forEach((f, fi) => {
      if (!haFloorByName(hass, f.name)) items.push({ kind: 'floor', key: `floor:${fi}`, checked: true, fi, name: f.name, level: fi });
    });

  // entidade -> cômodos onde aparece (a mesma tecla pode ter vários pontos)
  const placements = new Map<string, { room: RoomConfig; fi: number }[]>();
  floors.forEach((f, fi) =>
    f.rooms.forEach((room) => {
      for (const d of (room.devices ?? []) as DeviceConfig[]) {
        if (!d.entity || d.speaker) continue;
        const list = placements.get(d.entity) ?? [];
        if (!list.some((p) => p.room === room)) list.push({ room, fi });
        placements.set(d.entity, list);
      }
    }),
  );

  floors.forEach((f, fi) =>
    f.rooms.forEach((room) => {
      const label = room.name || areaName(room.area) || '';
      if (!room.area) {
        // cômodo sem área: propõe criar (nome do cômodo), a não ser que já exista área com esse nome
        if (!label) return;
        const existing = Object.values(hass.areas ?? {}).find((a) => norm(a.name) === norm(label));
        // já existe área com esse nome: liga a ela em vez de criar outra igual
        items.push({ kind: 'area', key: `area:${fi}:${label}`, checked: true, room, fi, name: label, existing: existing?.area_id });
      } else if (multiFloor) {
        const area = hass.areas?.[room.area];
        const target = haFloorByName(hass, f.name);
        if (area && area.floor_id !== (target?.floor_id ?? `novo:${fi}`))
          items.push({
            kind: 'area-floor',
            key: `area-floor:${room.area}`,
            checked: true,
            room,
            fi,
            areaName: area.name,
            floorName: f.name,
            from: area.floor_id ? hass.floors?.[area.floor_id]?.name ?? area.floor_id : undefined,
          });
      }
    }),
  );

  for (const [entity, where] of placements) {
    const entName = hass.states[entity]?.attributes.friendly_name ?? entity;
    if (!hass.entities?.[entity]) {
      notes.push({ entity: entName, reason: 'sem ID único no HA: a área não pode ser definida por aqui' });
      continue;
    }
    const targets = new Set(where.map((w) => w.room.area ?? `novo:${w.room.name}`));
    if (targets.size > 1) {
      notes.push({ entity: entName, reason: `aparece em ${targets.size} cômodos diferentes; escolha um só para definir a área` });
      continue;
    }
    const { room } = where[0];
    const current = entityArea(hass, entity);
    // área que o cômodo vai ter: a dele, ou a que já existe com o mesmo nome (será ligada, não criada)
    const byName = !room.area && room.name ? Object.values(hass.areas ?? {}).find((a) => norm(a.name) === norm(room.name!))?.area_id : undefined;
    const prospective = room.area ?? byName;
    if (prospective && current === prospective) continue;
    const toName = room.area ? areaName(room.area)! : room.name ?? '';
    if (!toName) continue;
    items.push({
      kind: 'entity',
      key: `entity:${entity}`,
      checked: true,
      room,
      entity,
      entityName: entName,
      toName,
      from: areaName(current),
    });
  }
  return { items, notes };
}

/** aplica os itens marcados, na ordem: andares -> áreas -> área no andar -> entidades */
export async function applyPlan(items: SyncItem[], floors: FloorConfig[], hass: Hass) {
  const errors: string[] = [];
  let done = 0;
  const floorId = new Map<number, string>();
  floors.forEach((f, fi) => {
    const ex = haFloorByName(hass, f.name);
    if (ex) floorId.set(fi, ex.floor_id);
  });
  const on = items.filter((i) => i.checked);
  const multiFloor = floors.length > 1;

  for (const it of on) {
    if (it.kind !== 'floor') continue;
    try {
      const res = await hass.callWS<{ floor_id: string }>({ type: 'config/floor_registry/create', name: it.name, level: it.level });
      floorId.set(it.fi, res.floor_id);
      done++;
    } catch (e) {
      errors.push(`Andar "${it.name}": ${(e as Error).message ?? e}`);
    }
  }

  for (const it of on) {
    if (it.kind !== 'area') continue;
    const existing = Object.values(hass.areas ?? {}).find((a) => norm(a.name) === norm(it.name));
    try {
      let id = existing?.area_id;
      if (!id) {
        const res = await hass.callWS<{ area_id: string }>({
          type: 'config/area_registry/create',
          name: it.name,
          ...(multiFloor && floorId.get(it.fi) ? { floor_id: floorId.get(it.fi) } : {}),
        });
        id = res.area_id;
      }
      it.room.area = id;
      // o nome passa a vir da área
      if (it.room.name && norm(it.room.name) === norm(it.name)) delete it.room.name;
      done++;
    } catch (e) {
      errors.push(`Área "${it.name}": ${(e as Error).message ?? e}`);
    }
  }

  for (const it of on) {
    if (it.kind !== 'area-floor' || !it.room.area) continue;
    const fid = floorId.get(it.fi);
    if (!fid) continue;
    try {
      await hass.callWS({ type: 'config/area_registry/update', area_id: it.room.area, floor_id: fid });
      done++;
    } catch (e) {
      errors.push(`Área "${it.areaName}" no andar: ${(e as Error).message ?? e}`);
    }
  }

  for (const it of on) {
    if (it.kind !== 'entity') continue;
    const target = it.room.area;
    if (!target) continue; // a área nova foi desmarcada
    const e = hass.entities?.[it.entity];
    const devArea = e?.device_id ? hass.devices?.[e.device_id]?.area_id : undefined;
    try {
      // se o aparelho já está na área certa, basta a entidade herdar dele
      await hass.callWS({ type: 'config/entity_registry/update', entity_id: it.entity, area_id: devArea === target ? null : target });
      done++;
    } catch (e2) {
      errors.push(`${it.entityName}: ${(e2 as Error).message ?? e2}`);
    }
  }
  return { done, errors };
}
