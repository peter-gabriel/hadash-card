import type { Hass, HassEntity } from './types';
import { t } from './i18n';

/** script, cena ou automação do HA, como o painel de ações mostra */
export interface ActionItem {
  id: string;
  domain: 'script' | 'scene' | 'automation';
  name: string;
  icon?: string;
  state: string;
  /** última execução (ISO) */
  last?: string;
}

export interface ActionTargets {
  entities: Set<string>;
  areas: Set<string>;
}

const DOMAINS = ['script', 'scene', 'automation'] as const;

export function listActions(hass: Hass, only?: string[]): ActionItem[] {
  const ids = only?.length ? only : Object.keys(hass.states).filter((id) => (DOMAINS as readonly string[]).includes(id.split('.')[0]));
  return ids
    .map((id) => hass.states[id])
    .filter((s): s is HassEntity => !!s && !hass.entities?.[s.entity_id]?.hidden)
    .map((s) => ({
      id: s.entity_id,
      domain: s.entity_id.split('.')[0] as ActionItem['domain'],
      name: s.attributes.friendly_name ?? s.entity_id,
      icon: s.attributes.icon,
      state: s.state,
      last: s.attributes.last_triggered ?? (s.entity_id.startsWith('scene.') ? s.state : undefined),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** junta todos os entity_id / area_id que aparecem em qualquer lugar da configuração */
function collect(node: unknown, out: ActionTargets, hass: Hass) {
  if (typeof node === 'string') {
    if (/^[a-z_]+\.[a-z0-9_]+$/.test(node) && hass.states[node]) out.entities.add(node);
    else if (hass.areas?.[node]) out.areas.add(node);
  } else if (Array.isArray(node)) node.forEach((n) => collect(n, out, hass));
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === 'area_id') [v].flat().forEach((a) => typeof a === 'string' && out.areas.add(a));
      collect(v, out, hass);
    }
}

const cache = new Map<string, ActionTargets>();

/** em quais entidades/áreas cada ação mexe (lê a configuração de scripts e automações; cenas trazem no estado) */
export async function loadTargets(hass: Hass, items: ActionItem[]): Promise<Map<string, ActionTargets>> {
  const out = new Map<string, ActionTargets>();
  await Promise.all(
    items.map(async (it) => {
      const hit = cache.get(it.id);
      if (hit) return out.set(it.id, hit);
      const t: ActionTargets = { entities: new Set(), areas: new Set() };
      try {
        if (it.domain === 'scene') collect(hass.states[it.id]?.attributes.entity_id ?? [], t, hass);
        else if (it.domain === 'script') {
          const cfg = await hass.callApi?.('GET', `config/script/config/${it.id.split('.')[1]}`);
          collect(cfg, t, hass);
        } else {
          const aid = hass.states[it.id]?.attributes.id;
          if (aid) collect(await hass.callApi?.('GET', `config/automation/config/${aid}`), t, hass);
        }
      } catch {
        /* sem permissão ou YAML manual: fica sem alvos */
      }
      // automações citam o próprio gatilho; tira a própria ação
      t.entities.delete(it.id);
      cache.set(it.id, t);
      out.set(it.id, t);
    }),
  );
  return out;
}

export function forgetTargets() {
  cache.clear();
}

/** "há 3 min", "há 2 h", "ontem"… */
export function ago(iso?: string): string {
  const tr = t();
  if (!iso) return tr.never;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return tr.never;
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return tr.justNow;
  if (m < 60) return tr.minutesAgo(m);
  const h = Math.round(m / 60);
  if (h < 24) return tr.hoursAgo(h);
  const d = Math.round(h / 24);
  return d === 1 ? tr.yesterday : tr.daysAgo(d);
}

export async function runAction(hass: Hass, it: ActionItem) {
  if (it.domain === 'script') return hass.callService('script', 'turn_on', { entity_id: it.id });
  if (it.domain === 'scene') return hass.callService('scene', 'turn_on', { entity_id: it.id });
  return hass.callService('automation', 'trigger', { entity_id: it.id });
}

export async function toggleAutomation(hass: Hass, it: ActionItem) {
  return hass.callService('automation', it.state === 'on' ? 'turn_off' : 'turn_on', { entity_id: it.id });
}
