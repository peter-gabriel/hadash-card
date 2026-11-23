/**
 * Céu de fundo e clima da cena a partir do sol (elevação em graus) e do estado da entidade weather.*.
 * Tudo aqui é cálculo puro: o card aplica no CSS (fundo + efeitos) e a cena na iluminação.
 */

export interface Sky {
  top: string;
  bottom: string;
  /** cor do chão em volta da casa */
  ground: string;
  /** 0..1 */
  stars: number;
  clouds: number;
  fog: number;
  rain: 0 | 1 | 2;
  snow: boolean;
  lightning: boolean;
  /** quanto do sol chega (nuvens/chuva tiram luz e suavizam sombra), 0..1 */
  sun: number;
  /** cor do céu para a luz ambiente da cena */
  ambient: string;
  night: boolean;
  /** texto curto do momento, para depuração/acessibilidade */
  phase: 'night' | 'twilight' | 'sunrise' | 'golden' | 'day';
  /** brilho do sol no céu (só com céu aberto de dia), 0..1 */
  sunGlow: number;
  /** lua no céu (noite aberta), 0..1 */
  moon: number;
  /** cor das nuvens (branca no sol, cinza na chuva, escura à noite) */
  cloud: string;
  /** véu cinza fechando o céu (nublado/chuva), 0..1 */
  overcast: number;
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const toHex = (c: RGB) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [hex(a), hex(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t) as RGB);
};

/** cores do céu (topo, horizonte) por elevação do sol */
const STOPS: [number, string, string][] = [
  [-18, '#050912', '#0d1426'],
  [-8, '#0b1230', '#2a2448'],
  [-3, '#1c2452', '#7a4560'],
  [0, '#2e3c74', '#e07a5f'],
  [5, '#3f64a0', '#f2a66b'],
  [12, '#4a7cc0', '#e9c9a0'],
  [25, '#3f80cf', '#a9cdec'],
  [60, '#2f74c8', '#9cc6ee'],
];

function skyColors(elev: number): [string, string] {
  if (elev <= STOPS[0][0]) return [STOPS[0][1], STOPS[0][2]];
  for (let i = 1; i < STOPS.length; i++) {
    const [e1, t1, b1] = STOPS[i];
    const [e0, t0, b0] = STOPS[i - 1];
    if (elev <= e1) {
      const k = (elev - e0) / (e1 - e0);
      return [mix(t0, t1, k), mix(b0, b1, k)];
    }
  }
  const last = STOPS[STOPS.length - 1];
  return [last[1], last[2]];
}

/** estados do weather do HA -> efeitos */
const WEATHER: Record<
  string,
  { gray: number; clouds: number; overcast: number; glow: number; tone: 'white' | 'light' | 'gray' | 'dark'; rain?: 1 | 2; snow?: boolean; fog?: number; storm?: boolean; sun: number }
> = {
  sunny: { gray: 0, clouds: 0, overcast: 0, glow: 1, tone: 'white', sun: 1 },
  'clear-night': { gray: 0, clouds: 0, overcast: 0, glow: 1, tone: 'white', sun: 1 },
  partlycloudy: { gray: 0.08, clouds: 0.75, overcast: 0, glow: 0.7, tone: 'white', sun: 0.8 },
  windy: { gray: 0.1, clouds: 0.6, overcast: 0, glow: 0.6, tone: 'white', sun: 0.75 },
  'windy-variant': { gray: 0.45, clouds: 0.9, overcast: 0.4, glow: 0, tone: 'light', sun: 0.45 },
  cloudy: { gray: 0.75, clouds: 1, overcast: 0.65, glow: 0, tone: 'light', sun: 0.3 },
  fog: { gray: 0.7, clouds: 0.2, overcast: 0.3, glow: 0, tone: 'light', fog: 1, sun: 0.25 },
  rainy: { gray: 0.82, clouds: 1, overcast: 0.8, glow: 0, tone: 'gray', rain: 1, sun: 0.2 },
  pouring: { gray: 0.9, clouds: 1, overcast: 0.95, glow: 0, tone: 'dark', rain: 2, sun: 0.12 },
  lightning: { gray: 0.88, clouds: 1, overcast: 0.9, glow: 0, tone: 'dark', storm: true, sun: 0.15 },
  'lightning-rainy': { gray: 0.92, clouds: 1, overcast: 1, glow: 0, tone: 'dark', rain: 2, storm: true, sun: 0.1 },
  snowy: { gray: 0.7, clouds: 0.9, overcast: 0.6, glow: 0, tone: 'light', snow: true, sun: 0.35 },
  'snowy-rainy': { gray: 0.8, clouds: 1, overcast: 0.75, glow: 0, tone: 'gray', snow: true, rain: 1, sun: 0.22 },
  hail: { gray: 0.88, clouds: 1, overcast: 0.9, glow: 0, tone: 'dark', rain: 2, sun: 0.15 },
  exceptional: { gray: 0.5, clouds: 0.7, overcast: 0.4, glow: 0, tone: 'gray', sun: 0.5 },
};

/** elevação: graus do sun.sun; sem dado, usa só "acima/abaixo do horizonte" */
export function computeSky(elevation: number | undefined, belowHorizon: boolean, weather?: string): Sky {
  const elev = elevation ?? (belowHorizon ? -20 : 35);
  const w = WEATHER[weather ?? ''] ?? WEATHER.sunny;
  let [top, bottom] = skyColors(elev);
  const night = elev < -4;
  // nuvem cinza: mais clara de dia, quase preta à noite
  const dayK = Math.max(0, Math.min(1, (elev + 6) / 18));
  // céu encoberto: claro (nublado) -> chumbo (chuva forte/tempestade)
  const toneTop = { white: '#8f9aa8', light: '#8b95a2', gray: '#646e7b', dark: '#3c434d' }[w.tone];
  const toneBottom = { white: '#b9c1ca', light: '#b3bac3', gray: '#8a939e', dark: '#59616b' }[w.tone];
  const grayTop = mix('#141820', toneTop, dayK);
  const grayBottom = mix('#1e232b', toneBottom, dayK);
  top = mix(top, grayTop, w.gray);
  bottom = mix(bottom, grayBottom, w.gray);
  if (w.fog) bottom = mix(bottom, mix('#2a2f37', '#c9cfd6', dayK), w.fog * 0.7);
  const phase: Sky['phase'] = night ? 'night' : elev < 0 ? 'twilight' : elev < 4 ? 'sunrise' : elev < 14 ? 'golden' : 'day';
  return {
    top,
    bottom,
    // chão no tom do céu (um pouco mais escuro): a casa "pousa" sobre ele sem um disco preto em volta
    ground: mix(mix(bottom, top, 0.35), '#000000', night ? 0.35 : 0.22),
    stars: night ? Math.max(0, 1 - w.clouds * 1.2) * Math.min(1, (-elev - 4) / 8) : 0,
    clouds: w.clouds,
    fog: w.fog ?? 0,
    rain: w.rain ?? 0,
    snow: !!w.snow,
    lightning: !!w.storm,
    sun: night ? 0 : w.sun * Math.min(1, Math.max(0.15, (elev + 2) / 20)),
    ambient: mix(top, bottom, 0.5),
    night,
    phase,
    sunGlow: night ? 0 : w.glow * Math.min(1, Math.max(0, (elev + 2) / 10)),
    moon: night ? w.glow * Math.min(1, (-elev - 4) / 6) : 0,
    cloud: night
      ? { white: 'rgba(120,130,150,.35)', light: 'rgba(95,104,120,.55)', gray: 'rgba(70,78,92,.7)', dark: 'rgba(40,45,55,.8)' }[w.tone]
      : { white: 'rgba(255,255,255,.92)', light: 'rgba(222,226,232,.9)', gray: 'rgba(160,168,178,.9)', dark: 'rgba(96,104,114,.92)' }[w.tone],
    overcast: w.overcast,
  };
}

/** condição do tempo em português */
export const WEATHER_PT: Record<string, string> = {
  sunny: 'Ensolarado',
  'clear-night': 'Céu limpo',
  partlycloudy: 'Parcialmente nublado',
  cloudy: 'Nublado',
  windy: 'Ventando',
  'windy-variant': 'Ventando e nublado',
  fog: 'Neblina',
  rainy: 'Chuva',
  pouring: 'Chuva forte',
  lightning: 'Raios',
  'lightning-rainy': 'Tempestade',
  snowy: 'Neve',
  'snowy-rainy': 'Chuva e neve',
  hail: 'Granizo',
  exceptional: 'Tempo instável',
};

/** caminho do ícone (24x24) para a condição */
export function weatherIcon(state: string, night: boolean): string {
  const sun = 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 1v3m0 16v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M1 12h3m16 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1';
  const moon = 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5';
  const cloud = 'M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z';
  if (state === 'sunny') return sun;
  if (state === 'clear-night') return moon;
  if (state === 'partlycloudy') return night ? moon + ' ' + cloud : 'M9 4.5a4.5 4.5 0 0 1 4.3 3.1 ' + cloud;
  if (/lightning/.test(state)) return cloud + ' M12 14l-2 5h3l-1 4';
  if (/rain|pouring|hail/.test(state)) return cloud + ' M8 20l-1 3m5-3-1 3m5-3-1 3';
  if (/snow/.test(state)) return cloud + ' M8 21h.01M12 22h.01M16 21h.01';
  if (state === 'fog') return 'M3 9h18M3 13h18M5 17h14';
  return cloud;
}
