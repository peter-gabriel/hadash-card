// HA falso para desenvolver sem o Home Assistant: `npm run dev`
import '../src/hadash-card';
import type { Hass, HassEntity } from '../src/types';
import { DEMO_FLOORS } from '../src/house';

const now = new Date().toISOString();
const ent = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HassEntity => ({
  entity_id,
  state,
  attributes,
  last_changed: now,
  last_updated: now,
});

// estados iniciais: cada entidade do sobrado de exemplo, com alguns valores mais interessantes
const OVERRIDES: Record<string, [string, Record<string, unknown>?]> = {
  'sun.sun': ['above_horizon', { elevation: 32, azimuth: 250 }],
  'script.apagar_banheiro': ['off', { friendly_name: 'Apagar banheiro', icon: 'mdi:lightbulb-off' }],
  'script.modo_cinema': ['off', { friendly_name: 'Modo cinema', icon: 'mdi:movie-open' }],
  'scene.jantar': ['2026-11-22T21:10:00Z', { friendly_name: 'Jantar', icon: 'mdi:silverware-fork-knife', entity_id: ['light.sala_teto', 'light.sala_abajur'] }],
  'automation.luz_do_banheiro_por_presenca': ['on', { friendly_name: 'Luz do banheiro por presença', id: 'a1', last_triggered: new Date(Date.now() - 18 * 60000).toISOString() }],
  'automation.apagar_tudo_a_meia_noite': ['off', { friendly_name: 'Apagar tudo à meia-noite', id: 'a2', last_triggered: new Date(Date.now() - 3 * 86400000).toISOString() }],
  'weather.forecast_home': ['partlycloudy', { temperature: 24.3, humidity: 62, friendly_name: 'Casa' }],
  'light.sala_teto': ['on', { brightness: 200, color_temp_kelvin: 2700 }],
  'light.sala_abajur': ['on', { brightness: 90, rgb_color: [255, 120, 60] }],
  'media_player.tv_sala': ['playing'],
  'climate.ar_sala': ['cool', { temperature: 23, current_temperature: 25 }],
  'sensor.sala_temperatura': ['24.6', { unit_of_measurement: '°C' }],
  'sensor.sala_umidade': ['58', { unit_of_measurement: '%' }],
  'binary_sensor.sala_presenca': ['on'],
  'sensor.cozinha_temperatura': ['26.1'],
  'switch.maquina_lavar': ['on'],
  'lock.porta_entrada': ['locked'],
  'binary_sensor.porta_varanda': ['off', { device_class: 'door' }],
  'light.suite': ['on', { brightness: 60, rgb_color: [120, 140, 255] }],
  'climate.ar_suite': ['off', { temperature: 22 }],
  'cover.cortina_suite': ['closed'],
  'sensor.suite_temperatura': ['23.4'],
  'sensor.quarto1_temperatura': ['22.8'],
  'sensor.quarto2_temperatura': ['23.1'],
  'fan.ventilador_quarto_1': ['on'],
  'sensor.banheiro_umidade': ['71'],
  'light.escritorio': ['on', { brightness: 255, color_temp_kelvin: 5000 }],
  'switch.computador': ['on'],
  'media_player.spotifyplus': [
    'playing',
    {
      friendly_name: 'SpotifyPlus',
      source: 'Home theater',
      source_list: ['65" OLED', 'Home theater', 'Q-Series Soundbar', 'Sala 2', 'Suite', 'Todo lugar'],
      volume_level: 0.36,
    },
  ],
};

// [música, artista, álbum, duração (s), cores da capa]
const TRACKS: [string, string, string, number, string, string][] = [
  ['Horizonte', 'Banda Exemplo', 'Lado Claro da Lua', 413, '#1b1b2f', '#e43f5a'],
  ['Menina da Praia', 'Trio Imaginário', 'Verão Sem Fim', 324, '#f6d365', '#fda085'],
  ['Relógios', 'Coletivo Teste', 'Pressa no Sangue', 307, '#0f4c75', '#3282b8'],
];

/** capa falsa: gradiente + iniciais do álbum */
const cover = (t: (typeof TRACKS)[number]) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${t[4]}"/><stop offset="1" stop-color="${t[5]}"/></linearGradient></defs>` +
      `<rect width="100" height="100" fill="url(#g)"/><text x="50" y="60" font-family="Georgia" font-size="30" ` +
      `fill="white" fill-opacity=".85" text-anchor="middle">${t[2].split(' ').map((w) => w[0]).filter((c) => /\w/.test(c)).join('').slice(0, 3)}</text></svg>`,
  );

// mais faixas só para a biblioteca falsa
const MORE: (typeof TRACKS)[number][] = [
  ['Bom Demais', 'Quarteto Demo', 'Janelas', 228, '#355c7d', '#c06c84'],
  ['Chuva de Março', 'Dupla Fictícia', 'Encontro', 212, '#11998e', '#38ef7d'],
  ['Me Encontre', 'DJ Exemplo', 'Dias Claros', 196, '#8e2de2', '#4a00e0'],
  ['Samba Novo', 'Banda Exemplo', 'Esquema', 182, '#f12711', '#f5af19'],
  ['Cidade à Noite', 'Coletivo Teste', 'Sonhando', 244, '#141e30', '#243b55'],
];
const ALL_TRACKS = [...TRACKS, ...MORE];
const fakeTrack = (t: (typeof TRACKS)[number]) => ({
  name: t[0],
  uri: `spotify:track:${t[0].replace(/\W/g, '')}`,
  artists: [{ name: t[1] }],
  album: { name: t[2] },
  image_url: cover(t),
});
const LIBRARY: Record<string, unknown[]> = {
  get_player_recent_tracks: ALL_TRACKS.map((t) => ({ track: fakeTrack(t) })),
  get_track_favorites: [MORE[2], TRACKS[1], MORE[1]].map((t) => ({ track: fakeTrack(t) })),
  get_playlist_favorites: [
    { name: 'Bossa para o jantar', uri: 'spotify:playlist:bossa', owner: { display_name: 'Spotify' }, image_url: cover(TRACKS[1]) },
    { name: 'Foco', uri: 'spotify:playlist:foco', owner: { display_name: 'Você' }, image_url: cover(MORE[4]) },
  ],
};

/** busca falsa: procura o texto em música, artista e álbum das faixas do demo */
function fakeSearch(service: string, msg: Record<string, unknown>) {
  const q = String((msg.service_data as any)?.criteria ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hits = ALL_TRACKS.filter((t) => [t[0], t[1], t[2]].some((x) => norm(x).includes(q)));
  const uniq = <K>(list: (typeof TRACKS)[number][], key: (t: (typeof TRACKS)[number]) => K) =>
    list.filter((t, i) => list.findIndex((u) => key(u) === key(t)) === i);
  switch (service) {
    case 'search_tracks':
      return hits.map(fakeTrack);
    case 'search_artists':
      return uniq(hits, (t) => t[1]).map((t) => ({
        name: t[1],
        uri: `spotify:artist:${t[1].replace(/\W/g, '')}`,
        image_url: cover(t),
        followers: { total: 1_200_000 },
      }));
    case 'search_albums':
      return uniq(hits, (t) => t[2]).map((t) => ({
        name: t[2],
        uri: `spotify:album:${t[2].replace(/\W/g, '')}`,
        artists: [{ name: t[1] }],
        image_url: cover(t),
      }));
    default:
      return hits.slice(0, 2).map((t) => ({
        name: `Só ${t[1]}`,
        uri: `spotify:playlist:${t[1].replace(/\W/g, '')}`,
        owner: { display_name: 'Spotify' },
        image_url: cover(t),
      }));
  }
}

const trackAttrs = (t: (typeof TRACKS)[number], position = 0) => ({
  media_title: t[0],
  media_artist: t[1],
  media_album_name: t[2],
  media_duration: t[3],
  media_position: position,
  media_position_updated_at: new Date().toISOString(),
  entity_picture: cover(t),
});

Object.assign(OVERRIDES['media_player.spotifyplus'][1]!, trackAttrs(TRACKS[0], 95));

const ids = new Set<string>(Object.keys(OVERRIDES));
for (const f of DEMO_FLOORS)
  for (const r of f.rooms) {
    for (const d of r.devices ?? []) {
      const id = typeof d === 'string' ? d : d.entity;
      if (id) ids.add(id);
    }
    for (const id of [r.temperature, r.humidity, r.motion]) if (id) ids.add(id);
  }

const titleCase = (id: string) =>
  id.split('.')[1].split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

let states: Record<string, HassEntity> = Object.fromEntries(
  [...ids].map((id) => {
    const [state, attrs] = OVERRIDES[id] ?? [id.startsWith('sensor.') ? '23' : 'off'];
    // device_class como no HA real (o editor usa para achar sensores da área)
    const device_class = /_temperatura$/.test(id) ? 'temperature' : /_umidade$/.test(id) ? 'humidity' : /_presenca$/.test(id) ? 'occupancy' : undefined;
    return [id, ent(id, state, { friendly_name: titleCase(id), ...(device_class ? { device_class } : {}), ...attrs })];
  }),
);

const card = document.getElementById('card') as any;

function set(id: string, state: string, attrs?: Record<string, unknown>) {
  const old = states[id];
  states = { ...states, [id]: { ...old, state, attributes: { ...old.attributes, ...attrs }, last_updated: new Date().toISOString() } };
  push();
}

const TOGGLE: Record<string, [string, string]> = {
  cover: ['open', 'closed'],
  media_player: ['playing', 'off'],
  lock: ['unlocked', 'locked'],
};

// registro de áreas/andares falso (no HA real vem pronto em hass.areas / hass.floors)
const AREAS: Hass['areas'] = {
  sala: { area_id: 'sala', name: 'Sala de estar', floor_id: 'terreo' },
  cozinha: { area_id: 'cozinha', name: 'Cozinha', floor_id: 'terreo' },
  suite: { area_id: 'suite', name: 'Suíte master', floor_id: 'superior' },
  escritorio: { area_id: 'escritorio', name: 'Escritório', floor_id: 'superior' },
};
const ENTITY_AREA: Record<string, string> = {
  'light.sala_teto': 'sala',
  'light.sala_abajur': 'sala',
  'sensor.sala_temperatura': 'sala',
  'sensor.sala_umidade': 'sala',
  'binary_sensor.sala_presenca': 'sala',
  'light.cozinha': 'cozinha',
  'switch.cafeteira': 'cozinha',
  'sensor.cozinha_temperatura': 'cozinha',
  'light.suite': 'suite',
  'climate.ar_suite': 'suite',
  'sensor.suite_temperatura': 'suite',
  'binary_sensor.suite_presenca': 'suite',
};

const hass: Omit<Hass, 'states'> = {
  // idioma do demo: ?lang=en | pt-BR | es
  language: new URLSearchParams(location.search).get('lang') ?? 'pt-BR',
  // presença de "spotifyplus" liga as abas de biblioteca no painel
  services: { spotifyplus: {} },
  areas: AREAS,
  floors: { terreo: { floor_id: 'terreo', name: 'Térreo', level: 0 }, superior: { floor_id: 'superior', name: 'Superior', level: 1 } },
  entities: Object.fromEntries(Object.keys(states).map((entity_id) => [entity_id, { entity_id, area_id: ENTITY_AREA[entity_id] ?? null }])),
  async callWS<T>(msg: Record<string, unknown>): Promise<T> {
    if (msg.type === 'call_service' && msg.domain === 'spotifyplus') {
      await new Promise((r) => setTimeout(r, 300));
      const service = msg.service as string;
      if (service.startsWith('search_')) return { response: { result: { items: fakeSearch(service, msg) } } } as T;
      return { response: { result: { items: LIBRARY[service] ?? [] } } } as T;
    }
    const slugify = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\W+/g, '_');
    if (msg.type === 'config/area_registry/create') {
      const name = String(msg.name);
      const area_id = slugify(name);
      hass.areas = { ...hass.areas, [area_id]: { area_id, name, floor_id: (msg.floor_id as string) ?? null } };
      setTimeout(push, 200);
      return { area_id, name } as T;
    }
    if (msg.type === 'config/area_registry/update') {
      const id = String(msg.area_id);
      hass.areas = { ...hass.areas, [id]: { ...hass.areas![id], floor_id: msg.floor_id as string } };
      setTimeout(push, 200);
      return hass.areas[id] as T;
    }
    if (msg.type === 'config/floor_registry/create') {
      const floor_id = slugify(String(msg.name));
      hass.floors = { ...hass.floors, [floor_id]: { floor_id, name: String(msg.name), level: msg.level as number } };
      setTimeout(push, 200);
      return { floor_id } as T;
    }
    if (msg.type === 'config/entity_registry/update') {
      const id = String(msg.entity_id);
      hass.entities = { ...hass.entities, [id]: { ...(hass.entities?.[id] ?? { entity_id: id }), area_id: msg.area_id as string | null } };
      setTimeout(push, 200);
      return { entity_entry: hass.entities[id] } as T;
    }
    throw new Error('sem WS no demo');
  },
  async callApi<T>(_method: string, path: string): Promise<T> {
    const CFG: Record<string, unknown> = {
      'config/script/config/apagar_banheiro': { sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.banheiro' } }] },
      'config/script/config/modo_cinema': {
        sequence: [{ action: 'light.turn_off', target: { entity_id: ['light.sala_teto'] } }, { action: 'light.turn_on', target: { entity_id: 'light.sala_abajur' }, data: { brightness: 40 } }],
      },
      'config/automation/config/a1': { triggers: [{ entity_id: 'binary_sensor.banheiro_movimento' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.banheiro' } }] },
      'config/automation/config/a2': { actions: [{ action: 'light.turn_off', target: { entity_id: 'all' } }] },
    };
    return CFG[path] as T;
  },
  async callService(domain, service, data) {
    if (domain === 'script' || domain === 'scene' || domain === 'automation') {
      const id = data?.entity_id as string;
      if (domain === 'automation' && service !== 'trigger') set(id, service === 'turn_on' ? 'on' : 'off');
      if (domain === 'script') {
        const cfg = (await (hass as any).callApi('GET', `config/script/config/${id.split('.')[1]}`)) as any;
        for (const step of cfg?.sequence ?? []) {
          const [d, sv] = step.action.split('.');
          for (const e of [step.target.entity_id].flat()) await (hass as any).callService(d, sv, { entity_id: e, ...step.data });
        }
      }
      if (domain === 'scene') set(id, new Date().toISOString(), {});
      return;
    }
    const id = data?.entity_id as string;
    const cur = states[id];
    if (!cur) return;
    if (domain === 'spotifyplus') {
      // toca a primeira faixa pedida (ou a 1ª do "álbum" da playlist)
      const uri = String(data?.uris ?? '').split(',')[0];
      const ctx = String(data?.context_uri ?? '').split(':').pop() ?? '';
      const t =
        ALL_TRACKS.find((x) => fakeTrack(x).uri === uri) ??
        ALL_TRACKS.find((x) => [x[1], x[2]].some((n) => n.replace(/\W/g, '') === ctx)) ??
        (ctx === 'foco' ? MORE[4] : TRACKS[1]);
      set(id, 'playing', trackAttrs(t));
      return;
    }
    if (domain === 'media_player' && id === 'media_player.spotifyplus') {
      const a = cur.attributes;
      // congela/retoma a posição como o HA faz
      const now = () => {
        const p = a.media_position + (cur.state === 'playing' ? (Date.now() - Date.parse(a.media_position_updated_at)) / 1000 : 0);
        return { media_position: p, media_position_updated_at: new Date().toISOString() };
      };
      if (service === 'media_play_pause') set(id, cur.state === 'playing' ? 'paused' : 'playing', now());
      if (service === 'select_source') set(id, 'playing', { source: data?.source, ...now() });
      if (service === 'volume_set') set(id, cur.state, { volume_level: data?.volume_level });
      if (service === 'media_seek')
        set(id, cur.state, { media_position: data?.seek_position, media_position_updated_at: new Date().toISOString() });
      if (service === 'media_next_track' || service === 'media_previous_track') {
        const i = ALL_TRACKS.findIndex((t) => t[0] === a.media_title);
        const n = (i + (service === 'media_next_track' ? 1 : ALL_TRACKS.length - 1)) % ALL_TRACKS.length;
        set(id, 'playing', trackAttrs(ALL_TRACKS[n]));
      }
      return;
    }
    if (service === 'toggle') {
      const [on, off] = TOGGLE[domain] ?? ['on', 'off'];
      const next = cur.state === off ? on : off;
      set(id, next, domain === 'light' && next === 'on' && !cur.attributes.brightness ? { brightness: 255 } : undefined);
    }
    if (service === 'turn_off') set(id, 'off');
    if (service === 'turn_on') set(id, 'on', { brightness: (data?.brightness as number) ?? cur.attributes.brightness ?? 255 });
  },
};

// para testes no console: demoSet('weather.forecast_home', 'rainy')
(window as any).demoSet = (id: string, state: string, attrs?: Record<string, unknown>) => set(id, state, attrs);

function push() {
  card.hass = { ...hass, states };
}

card.setConfig({
  type: 'custom:hadash-card',
  height: '100vh',
  title: 'Casa (demo)',
  show_coords: true,
  idle_seconds: 120,
  // sem `card`, o botão de música abre o player embutido (no HA: custom:spotifyplus-card)
  music: { entity: 'media_player.spotifyplus' },
});
push();

addEventListener('hass-more-info', (e: any) => console.log('more-info', e.detail.entityId));
// hora do dia: madrugada -> amanhecer -> golden -> dia -> pôr do sol -> noite
const HOURS: [string, number, number][] = [
  ['dia', 40, 200],
  ['golden', 8, 260],
  ['pôr do sol', 0.5, 268],
  ['crepúsculo', -5, 272],
  ['noite', -30, 330],
  ['amanhecer', 2, 95],
];
let hour = 0;
document.getElementById('night')!.onclick = () => {
  hour = (hour + 1) % HOURS.length;
  const [label, elevation, azimuth] = HOURS[hour];
  set('sun.sun', elevation > -1 ? 'above_horizon' : 'below_horizon', { elevation, azimuth });
  document.getElementById('night')!.textContent = `hora: ${label}`;
};
const WX = ['partlycloudy', 'sunny', 'cloudy', 'rainy', 'pouring', 'lightning-rainy', 'snowy', 'fog'];
let wx = 0;
document.getElementById('weather')!.onclick = () => {
  wx = (wx + 1) % WX.length;
  set('weather.forecast_home', WX[wx]);
  document.getElementById('weather')!.textContent = `tempo: ${WX[wx]}`;
};
// liga/desliga a presença em todos os cômodos que têm sensor (Sala e Suíte no demo)
document.getElementById('motion')!.onclick = () => {
  const motion = Object.keys(states).filter((id) => id.startsWith('binary_sensor.') && id.endsWith('_presenca'));
  const next = motion.some((id) => states[id].state === 'on') ? 'off' : 'on';
  for (const id of motion) set(id, next);
};

// sensores "vivos"
setInterval(() => {
  const t = Number(states['sensor.sala_temperatura'].state) + (Math.random() - 0.5) * 0.2;
  set('sensor.sala_temperatura', t.toFixed(1));
}, 5000);
