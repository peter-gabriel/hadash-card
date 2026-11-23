export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
}

export interface Hass {
  states: Record<string, HassEntity>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  callApi?<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: Record<string, unknown>): Promise<T>;
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<unknown>;
  themes?: { darkMode?: boolean };
  language?: string;
  locale?: { language?: string };
  services?: Record<string, Record<string, unknown>>;
  /** registros do HA (só existem dentro do HA, não no demo) */
  areas?: Record<string, { area_id: string; name: string; floor_id?: string | null }>;
  floors?: Record<string, { floor_id: string; name: string; level?: number | null }>;
  entities?: Record<string, { entity_id: string; area_id?: string | null; device_id?: string | null; hidden?: boolean }>;
  devices?: Record<string, { id: string; area_id?: string | null }>;
  user?: { is_admin?: boolean; name?: string };
  fetchWithAuth?: (path: string, init?: RequestInit) => Promise<Response>;
}

/** ponto na planta, em metros: [x, y] (x para a direita, y para "baixo" no desenho) */
export type Vec2 = [number, number];

export interface DeviceConfig {
  /** entidade do HA; numa caixa de som (speaker) é opcional e usa `music.entity` */
  entity?: string;
  /** caixa de som: nome dela na lista de fontes do player (ex.: "Suite" no SpotifyPlus) */
  speaker?: string;
  name?: string;
  /** posição na planta em metros (coordenadas da casa, não do cômodo) */
  pos?: Vec2;
  /** altura em metros (padrão: 1.4 para luz, 0.4 para o resto) */
  height?: number;
  /**
   * interruptor/relé que acende uma lâmpada comum: desenha como lâmpada (com a luz no piso).
   * Uma tecla com vários spots: coloque a mesma entidade em vários pontos.
   */
  light?: boolean;
}

export interface OpeningConfig {
  /** índice da parede: parede i vai do vértice i ao i+1 (retângulo: 0 topo, 1 direita, 2 baixo, 3 esquerda) */
  edge: number;
  /** distância em metros do começo da parede até o começo do vão */
  at: number;
  width: number;
}

export interface RoomConfig {
  /** opcional quando `area` está definida: aí o nome vem da área do HA */
  name?: string;
  id?: string;
  /** area_id do HA: o cômodo usa o nome da área (e acompanha se ela for renomeada no HA) */
  area?: string;
  /** atalho para retângulo: [x, y, largura, profundidade] */
  rect?: [number, number, number, number];
  /** contorno livre (cômodo em L etc.), vértices em sequência */
  polygon?: Vec2[];
  color?: string;
  wall_height?: number;
  /** portas e passagens (vãos na parede) */
  openings?: OpeningConfig[];
  temperature?: string;
  humidity?: string;
  /** binary_sensor de presença/movimento: acende o piso do cômodo */
  motion?: string;
  devices?: (string | DeviceConfig)[];
}

export interface StairConfig {
  /** pé da escada (neste piso) e topo (chega no piso de cima), em metros na planta */
  from: Vec2;
  to: Vec2;
  width?: number;
}

/** imagem da planta embaixo do desenho (só no editor), em metros */
export interface BackgroundConfig {
  image: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
}

export interface FloorConfig {
  name: string;
  background?: BackgroundConfig;
  /** altura do piso em metros (padrão: índice × floor_height) */
  elevation?: number;
  rooms: RoomConfig[];
  /** escadas que sobem deste piso para o próximo */
  stairs?: StairConfig[];
}

export interface MusicConfig {
  /** media_player que toca a música (ex.: media_player.spotifyplus) */
  entity: string;
  /** card aberto pelo botão de música (ex.: custom:spotifyplus-card); sem ele usa o player embutido */
  card?: Record<string, unknown>;
  /** widget "tocando agora" no canto (padrão true) */
  now_playing?: boolean;
}

export interface CardConfig {
  type: string;
  title?: string;
  /** altura do card (padrão 600px; use 100% em painel) */
  height?: string;
  /** altura das paredes em metros; baixa = visual de "casa de bonecas" cortada */
  wall_height?: number;
  wall_thickness?: number;
  /** casa de um piso só */
  rooms?: RoomConfig[];
  /** sobrado / vários andares (do térreo para cima); tem prioridade sobre `rooms` */
  floors?: FloorConfig[];
  /** pé-direito usado para empilhar os pisos (padrão 2.9 m) */
  floor_height?: number;
  /** piso mostrado ao abrir e ao ficar ocioso: índice ou "all" (padrão "all") */
  default_floor?: number | 'all';
  /** segundos sem toque até voltar à visão geral (0 desliga) */
  idle_seconds?: number;
  /** gira devagar quando está ocioso */
  idle_rotate?: boolean;
  /** mostra o botão de régua para descobrir coordenadas tocando no piso */
  show_coords?: boolean;
  /** ações (scripts, cenas, automações) no painel ⚡; padrão: todas */
  actions?: string[];
  /** atalhos fixos no alto da tela (ids de script/cena/automação) */
  actions_pinned?: string[];
  /** botão de música + caixas de som na planta */
  music?: MusicConfig;
  /** mostra o botão do editor de planta (padrão: só para administradores) */
  editor?: boolean;
  /** "low" desliga sombras e iluminação de ambiente (tablets fracos); padrão "high" */
  quality?: 'high' | 'low';
  /** graus que a planta está girada em relação ao norte (0 = topo da planta aponta para o norte) */
  north?: number;
  /** entidade de previsão do tempo (padrão: a primeira weather.*); usada no céu e no tempo lá fora */
  weather_entity?: string;
  /** céu de fundo acompanhando hora do dia e tempo (padrão true) */
  sky?: boolean;
  /** nuvens, chuva, neve e raios animados (padrão true) */
  weather_effects?: boolean;
  /** entidade do sol para o modo noite e a posição do sol (padrão sun.sun) */
  sun_entity?: string;
}
