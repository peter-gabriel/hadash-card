import { describe, expect, it } from 'vitest';
import { computeSky } from '../src/sky';
import { isLightSwitch, wallSegments } from '../src/house';
import { addOpening, pointInPoly, rectPoly, roomAt, syncOpenings } from '../src/editor-geom';
import { ago } from '../src/actions';
import { setLanguage } from '../src/i18n';
import { computePlan } from '../src/area-sync';
import type { FloorConfig, Hass, RoomConfig } from '../src/types';

describe('sky', () => {
  it('is night with stars on a clear night, none when overcast', () => {
    const clear = computeSky(-30, true, 'clear-night');
    expect(clear.night).toBe(true);
    expect(clear.stars).toBeGreaterThan(0.9);
    expect(computeSky(-30, true, 'cloudy').stars).toBe(0);
  });

  it('maps weather to effects', () => {
    expect(computeSky(30, false, 'pouring').rain).toBe(2);
    expect(computeSky(30, false, 'lightning-rainy').lightning).toBe(true);
    expect(computeSky(30, false, 'snowy').snow).toBe(true);
    expect(computeSky(30, false, 'sunny').sunGlow).toBe(1);
  });

  it('falls back to above/below horizon without elevation', () => {
    expect(computeSky(undefined, true).night).toBe(true);
    expect(computeSky(undefined, false).phase).toBe('day');
  });
});

describe('house', () => {
  it('cuts openings out of a wall', () => {
    expect(wallSegments(4, [{ edge: 0, at: 1, width: 0.8 }])).toEqual([
      [0, 1],
      [1.8, 4],
    ]);
    // opening at the very end leaves a single segment
    expect(wallSegments(4, [{ edge: 0, at: 3.2, width: 1 }])).toEqual([[0, 3.2]]);
  });

  it('detects light switches by id or name', () => {
    expect(isLightSwitch('switch.kitchen_l1')).toBe(true);
    expect(isLightSwitch('switch.bedroom', 'Bedroom light')).toBe(true);
    expect(isLightSwitch('switch.pump', 'Water pump')).toBe(false);
    expect(isLightSwitch('light.kitchen')).toBe(false);
  });
});

describe('editor geometry', () => {
  const a: RoomConfig = { name: 'A', polygon: rectPoly(0, 0, 4, 3) };
  const b: RoomConfig = { name: 'B', polygon: rectPoly(4, 0, 3, 3) };

  it('finds the room under a point', () => {
    expect(pointInPoly([1, 1], rectPoly(0, 0, 4, 3))).toBe(true);
    expect(roomAt([a, b], [5, 1])).toBe(1);
    expect(roomAt([a, b], [9, 9])).toBe(-1);
  });

  it('opens a door on both sides of a shared wall', () => {
    const rooms = structuredClone([a, b]);
    expect(addOpening(rooms, [4, 1.5], 0.8)).toBe(2);
    // already in sync: nothing new
    expect(syncOpenings(rooms)).toBe(0);
    // remove one side: sync puts it back
    rooms[1].openings = [];
    expect(syncOpenings(rooms)).toBe(1);
  });
});

describe('actions', () => {
  it('formats last run', () => {
    setLanguage({ language: 'en' });
    expect(ago(undefined)).toBe('never');
    expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 min ago');
    expect(ago(new Date(Date.now() - 26 * 3_600_000).toISOString())).toBe('yesterday');
  });
});

describe('area sync', () => {
  const hass = {
    states: { 'light.desk': { entity_id: 'light.desk', state: 'on', attributes: { friendly_name: 'Desk' } } },
    areas: { office: { area_id: 'office', name: 'Office' } },
    floors: {},
    entities: { 'light.desk': { entity_id: 'light.desk', area_id: null } },
    devices: {},
  } as unknown as Hass;

  it('links an unnamed room to an existing area by name and moves its entities', () => {
    const floors: FloorConfig[] = [{ name: 'Ground', rooms: [{ name: 'office', rect: [0, 0, 3, 3], devices: [{ entity: 'light.desk', pos: [1, 1] }] }] }];
    const { items } = computePlan(floors, hass);
    expect(items.find((i) => i.kind === 'area')).toMatchObject({ name: 'office', existing: 'office' });
    expect(items.find((i) => i.kind === 'entity')).toMatchObject({ entity: 'light.desk', toName: 'office' });
  });

  it('never proposes deleting anything', () => {
    const { items } = computePlan([{ name: 'Ground', rooms: [] }], hass);
    expect(items).toEqual([]);
  });
});
