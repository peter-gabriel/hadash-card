import type { Device } from './house';
import type { HassEntity } from './types';

export interface Visual {
  color: string;
  /** brilha (luz acesa) */
  glow: boolean;
  /** ligado/ativo, sem brilho */
  active: boolean;
  /** 0..1, ex.: brilho da lâmpada */
  level: number;
  unavailable: boolean;
}

const OFF = '#5b6370';
const DOMAIN_ON: Record<string, string> = {
  switch: '#4fc3f7',
  input_boolean: '#4fc3f7',
  fan: '#4dd0b5',
  media_player: '#b388ff',
  cover: '#ffd54f',
  lock: '#ef5350',
  binary_sensor: '#ef5350',
};

export const SPOTIFY_GREEN = '#1ed760';

/** a música está nesta caixa? (fonte atual do player = nome da caixa) */
export function speakerIsCurrent(st: HassEntity | undefined, speaker?: string) {
  const src = st?.attributes.source;
  return !!speaker && typeof src === 'string' && src.trim().toLowerCase() === speaker.trim().toLowerCase();
}

export function deviceVisual(domain: string, st: HassEntity | undefined, speaker?: string): Visual {
  const base: Visual = { color: OFF, glow: false, active: false, level: 0, unavailable: false };
  if (domain === 'speaker') {
    // player "off"/sem fonte não deixa a caixa indisponível: ela só está livre
    if (!speakerIsCurrent(st, speaker)) return base;
    if (st!.state === 'playing') return { ...base, color: SPOTIFY_GREEN, glow: true, active: true, level: 1 };
    return { ...base, color: '#2e7d4f', active: true, level: 0.5 };
  }
  if (!st || st.state === 'unavailable' || st.state === 'unknown') return { ...base, unavailable: true };
  const s = st.state;
  const a = st.attributes;
  switch (domain) {
    case 'light': {
      if (s !== 'on') return base;
      const level = typeof a.brightness === 'number' ? a.brightness / 255 : 1;
      return { ...base, color: lightColor(a), glow: true, active: true, level };
    }
    case 'climate': {
      if (s === 'off') return base;
      const heat = s === 'heat' || a.hvac_action === 'heating';
      return { ...base, color: heat ? '#ff8a65' : '#64b5f6', active: true, level: 1 };
    }
    case 'media_player': {
      const on = !['off', 'standby', 'idle'].includes(s);
      return on ? { ...base, color: DOMAIN_ON.media_player, active: true, level: 1 } : base;
    }
    case 'cover':
      return s === 'open' || s === 'opening' ? { ...base, color: DOMAIN_ON.cover, active: true, level: 1 } : base;
    case 'lock':
      return s === 'unlocked' ? { ...base, color: DOMAIN_ON.lock, active: true, level: 1 } : { ...base, color: '#66bb6a' };
    default:
      return s === 'on' ? { ...base, color: DOMAIN_ON[domain] ?? '#4fc3f7', active: true, level: 1 } : base;
  }
}

function lightColor(a: Record<string, any>): string {
  if (Array.isArray(a.rgb_color)) {
    const [r, g, b] = a.rgb_color;
    return `rgb(${r},${g},${b})`;
  }
  const k = a.color_temp_kelvin;
  if (typeof k === 'number') return k < 3300 ? '#ffb45c' : k < 4500 ? '#ffd9a0' : '#fff3e0';
  return '#ffc46b';
}

/** "Sala Teto" dentro da Sala vira só "Teto" */
export function deviceName(d: Device, roomName: string, st?: HassEntity): string {
  if (d.domain === 'speaker') return d.name ?? d.speaker ?? 'Caixa';
  const full: string = d.name ?? st?.attributes.friendly_name ?? d.entity.split('.')[1].replace(/_/g, ' ');
  if (d.name) return full;
  const re = new RegExp(`^${roomName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');
  const short = full.replace(re, '');
  return short ? short[0].toUpperCase() + short.slice(1) : full;
}

const PT: Record<string, string> = {
  on: 'ligado',
  off: 'desligado',
  open: 'aberto',
  closed: 'fechado',
  opening: 'abrindo',
  closing: 'fechando',
  playing: 'tocando',
  paused: 'pausado',
  idle: 'ocioso',
  standby: 'standby',
  heat: 'aquecendo',
  cool: 'resfriando',
  heat_cool: 'auto',
  auto: 'auto',
  dry: 'desumidificar',
  fan_only: 'ventilar',
  locked: 'trancado',
  unlocked: 'destrancado',
  unavailable: 'indisponível',
  unknown: '?',
};

export function speakerText(st: HassEntity | undefined, speaker?: string): string {
  if (!speakerIsCurrent(st, speaker)) return 'toque para tocar aqui';
  const a = st!.attributes;
  const what = [a.media_title, a.media_artist].filter(Boolean).join(' · ');
  if (st!.state === 'playing') return what ? `▶ ${what}` : 'tocando';
  return what ? `❚❚ ${what}` : 'pausado';
}

export function stateText(st?: HassEntity): string {
  if (!st) return 'não encontrado';
  const domain = st.entity_id.split('.')[0];
  const a = st.attributes;
  if (domain === 'light' && st.state === 'on' && typeof a.brightness === 'number')
    return `${Math.round(a.brightness / 2.55)}%`;
  if (domain === 'climate' && st.state !== 'off' && a.temperature != null) return `${PT[st.state] ?? st.state} · ${a.temperature}°`;
  if (domain === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(a.device_class))
    return st.state === 'on' ? 'aberta' : 'fechada';
  if (domain === 'sensor') return `${st.state}${a.unit_of_measurement ? ' ' + a.unit_of_measurement : ''}`;
  return PT[st.state] ?? st.state;
}

/** o que um toque rápido faz; undefined = abrir o more-info */
export function tapService(domain: string): [string, string] | undefined {
  if (['light', 'switch', 'fan', 'input_boolean'].includes(domain)) return [domain, 'toggle'];
  if (domain === 'cover') return ['cover', 'toggle'];
  if (domain === 'media_player') return ['media_player', 'toggle'];
  return undefined;
}
