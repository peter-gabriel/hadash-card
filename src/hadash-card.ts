import { LitElement, html, css, nothing } from 'lit';
import { buildFloors, DEMO_FLOORS, roomLabel, type Device, type Floor, type Room } from './house';
import { HouseScene, type FloorSel } from './scene';
import 'spotify-panel-card/panel';
import { speakerIsCurrent, tapService } from './states';
import { computeSky, weatherIcon, type Sky } from './sky';
import { setLanguage, t as L } from './i18n';
import { listActions, loadTargets, runAction, type ActionItem, type ActionTargets } from './actions';
import './editor';
import type { CardConfig, Hass, HassEntity, Vec2 } from './types';

const VERSION = '0.1.0';


class HadashCard extends LitElement {
  static properties = {
    _focused: { state: true },
    _floor: { state: true },
    _coordMode: { state: true },
    _coord: { state: true },
    _toast: { state: true },
    _now: { state: true },
    _musicOpen: { state: true },
    _editing: { state: true },
    _railOpen: { state: true },
    _actionsOpen: { state: true },
    _actionTargets: { state: true },
    _previewing: { state: true },
    _yaml: { state: true },
  };

  declare _focused: string | null;
  declare _floor: FloorSel;
  declare _coordMode: boolean;
  declare _coord: Vec2 | undefined;
  declare _toast: string | undefined;
  declare _now: Date;
  declare _musicOpen: boolean;
  declare _editing: boolean;
  declare _railOpen: boolean;
  declare _actionsOpen: boolean;
  declare _actionTargets: Map<string, ActionTargets> | undefined;
  declare _previewing: boolean;
  declare _yaml: string | undefined;
  /** config de antes de abrir o editor (para cancelar a pré-visualização) */
  private _editBase?: CardConfig;

  private _config!: CardConfig;
  private _hass?: Hass;
  private _floors: Floor[] = [];
  private _rooms: Room[] = [];
  private _coordFloor = 0;
  private _scene?: HouseScene;
  private _idleTimer?: number;
  private _clockTimer?: number;
  private _toastTimer?: number;
  /** card de música do HA (ex.: SpotifyPlus), criado na primeira abertura */

  constructor() {
    super();
    this._focused = null;
    this._floor = 'all';
    this._coordMode = false;
    this._musicOpen = false;
    this._editing = false;
    this._railOpen = false;
    this._actionsOpen = false;
    this._previewing = false;
    this._now = new Date();
  }

  static getStubConfig() {
    return { rooms: DEMO_FLOORS[0].rooms.slice(0, 2) };
  }

  setConfig(config: CardConfig) {
    this._config = config;
    this._floors = buildFloors(config);
    this._rooms = this._floors.flatMap((f) => f.rooms);
    this._floor = this._defaultFloor();
    this._focused = null;
    // config mudou no editor: recria a cena
    if (this._scene) {
      this._scene.dispose();
      this._scene = undefined;
      this.updateComplete.then(() => this._initScene());
    }
  }

  set hass(hass: Hass) {
    this._hass = hass;
    // idioma do perfil no HA: ao mudar, refaz a cena (nomes da casa de exemplo, rótulos)
    if (setLanguage(hass) && this._config) this.setConfig(this._config);
    this._applyHass();
    this.requestUpdate();
  }

  get hass(): Hass | undefined {
    return this._hass;
  }

  getCardSize() {
    return 10;
  }

  getGridOptions() {
    return { columns: 'full', rows: 10, min_rows: 6 };
  }

  // ---------- ciclo de vida ----------

  connectedCallback() {
    super.connectedCallback();
    this._clockTimer = window.setInterval(() => {
      const n = new Date();
      if (n.getMinutes() !== this._now.getMinutes()) this._now = n;
    }, 1000);
    if (this.hasUpdated && !this._scene) this.updateComplete.then(() => this._initScene());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._clockTimer);
    clearTimeout(this._idleTimer);
    // libera o contexto WebGL quando o HA troca de view
    this._scene?.dispose();
    this._scene = undefined;
  }

  updated() {
    this._syncInsets();
  }

  /** o centro da cena fica na área livre entre a lista de cômodos (esquerda) e o seletor de andar (direita) */
  private _syncInsets() {
    const card = this.renderRoot.querySelector<HTMLElement>('.card');
    if (!card || !this._scene) return;
    const c = card.getBoundingClientRect();
    // a lista de cômodos e o painel de ações abrem por cima (não empurram a cena); só o seletor de andar fica fixo
    const floors = this.renderRoot.querySelector<HTMLElement>('.floors')?.getBoundingClientRect();
    let right = floors ? c.right - floors.left : 0;
    // tela larga: a casa desliza para a esquerda e continua inteira ao lado do painel de ações
    const acts = this.renderRoot.querySelector<HTMLElement>('.actions')?.getBoundingClientRect();
    if (acts && c.width - acts.width > 520) right = Math.max(right, c.right - acts.left + 8);
    this._scene.setViewInsets(0, right);
  }

  firstUpdated() {
    this._initScene();
  }

  private _initScene() {
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage');
    if (!stage || this._scene) return;
    this._scene = new HouseScene(
      stage,
      this._floors,
      {
        wallHeight: this._config.wall_height ?? 1.0,
        wallThickness: this._config.wall_thickness ?? 0.12,
        floorHeight: this._config.floor_height ?? 2.9,
        quality: this._config.quality,
        north: this._config.north,
      },
      {
        onTapDevice: (d) => this._tapDevice(d),
        onHoldDevice: (d) => (d.domain === 'speaker' ? this._openMusic() : this._moreInfo(d.entity)),
        onTapRoom: (r) => this._tapRoom(r),
        onTapFloor: (p, floor) => {
          if (!this._coordMode) return;
          this._coord = p;
          this._coordFloor = floor;
          this._scene?.showCoordMarker(p, floor);
        },
        onInteract: () => {
          this._kickIdle();
          this._railOpen = false;
          this._actionsOpen = false;
        },
        onResize: () => requestAnimationFrame(() => this._syncInsets()),
      },
    );
    this._areasSeen = undefined;
    this._scene.setFloor(this._floor, false);
    this._scene.overview(false);
    if (this._focused) this._scene.focusRoom(this._focused);
    this._applyHass();
    this._kickIdle();
  }

  private get _weather(): HassEntity | undefined {
    const st = this._hass?.states ?? {};
    const id = this._config.weather_entity ?? Object.keys(st).find((k) => k.startsWith('weather.'));
    return id ? st[id] : undefined;
  }

  /** céu do momento: sol (elevação) + tempo */
  private _sky(): Sky {
    const sun = this._hass?.states[this._config.sun_entity ?? 'sun.sun'];
    return computeSky(sun?.attributes.elevation, sun?.state === 'below_horizon', this._weather?.state);
  }

  private _renderSky() {
    if (this._config.sky === false) return nothing;
    const k = this._sky();
    const fx = this._config.weather_effects !== false;
    const style = `--sky-top:${k.top};--sky-bottom:${k.bottom};--stars:${k.stars.toFixed(2)};--clouds:${k.clouds.toFixed(2)};--fog:${k.fog.toFixed(2)};--cloud:${k.cloud};--sunglow:${k.sunGlow.toFixed(2)};--moon:${k.moon.toFixed(2)};--overcast:${k.overcast.toFixed(2)}`;
    return html`<div class="sky" style=${style}>
      <div class="stars"></div>
      ${k.sunGlow > 0.02 ? html`<div class="sunglow"></div>` : nothing}
      ${k.moon > 0.02 ? html`<div class="moon"></div>` : nothing}
      ${k.overcast > 0.02 ? html`<div class="overcast"></div>` : nothing}
      ${k.clouds > 0.02 ? html`<div class="clouds ${fx ? '' : 'still'}"><i></i><i></i></div>` : nothing}
    </div>`;
  }

  /** chuva/neve/raio por cima da casa (mas por baixo dos painéis) */
  private _renderWeatherFx() {
    if (this._config.sky === false || this._config.weather_effects === false) return nothing;
    const k = this._sky();
    if (!k.rain && !k.snow && !k.lightning && !k.fog) return nothing;
    return html`<div class="wx ${k.rain === 2 ? 'heavy' : ''}" style="--fog:${k.fog.toFixed(2)}">
      ${k.fog ? html`<div class="fogfront"></div>` : nothing}
      ${k.rain ? html`<div class="rain"><i></i><i></i></div>` : nothing}
      ${k.snow ? html`<div class="snow"><i></i><i></i></div>` : nothing}
      ${k.lightning ? html`<div class="flash"></div>` : nothing}
    </div>`;
  }

  /** tempo lá fora: ícone, temperatura e condição */
  private _renderWeatherLine() {
    const w = this._weather;
    if (!w) return nothing;
    const t = Number(w.attributes.temperature);
    const night = this._hass?.states[this._config.sun_entity ?? 'sun.sun']?.state === 'below_horizon';
    return html`<div class="wline">
      <svg viewBox="0 0 24 24"><path d=${weatherIcon(w.state, night)} /></svg>
      ${Number.isFinite(t) ? html`<b>${Math.round(t)}°</b>` : nothing}
      <span>${L().weather[w.state] ?? w.state}</span>
    </div>`;
  }

  private _roomName(r: Room) {
    return roomLabel(r, this._hass?.areas);
  }

  private _areasSeen?: unknown;

  private _applyHass() {
    if (!this._scene || !this._hass) return;
    // nomes das áreas: só recalcula quando o registro de áreas muda
    if (this._hass.areas !== this._areasSeen) {
      this._areasSeen = this._hass.areas;
      this._scene.setRoomNames(new Map(this._rooms.map((r) => [r.id, this._roomName(r)])));
    }
    this._scene.updateStates(this._hass.states);
    const sun = this._hass.states[this._config.sun_entity ?? 'sun.sun'];
    this._scene.setNight(sun?.state === 'below_horizon');
    this._scene.setSky(this._sky());
    this._scene.setSun(sun?.attributes.elevation, sun?.attributes.azimuth);
  }

  // ---------- ações ----------

  private _tapRoom(r: Room | null) {
    if (this._coordMode) return;
    const id = r && r.id !== this._focused ? r.id : null;
    this._focus(id);
  }

  private _focus(id: string | null) {
    const room = id ? this._rooms.find((r) => r.id === id) : undefined;
    // focar um cômodo de outro andar troca o andar junto
    if (room && this._floor !== room.floor) {
      this._floor = room.floor;
      this._scene?.setFloor(room.floor, false);
    }
    this._focused = id;
    this._scene?.focusRoom(id);
  }

  private _setFloor(sel: FloorSel) {
    this._floor = sel;
    this._focused = null;
    this._scene?.setFloor(sel, false);
    this._scene?.focusRoom(null);
  }

  private _defaultFloor(): FloorSel {
    if (this._floors.length <= 1) return 0;
    const d = this._config.default_floor ?? 'all';
    return d === 'all' ? 'all' : Math.max(0, Math.min(this._floors.length - 1, d));
  }

  private async _tapDevice(d: Device) {
    // retorno imediato: o pino pulsa, para saber que o toque foi recebido
    this._scene?.pulse(d);
    if (d.domain === 'speaker') return this._tapSpeaker(d);
    const st = this._hass?.states[d.entity];
    const name = d.name ?? st?.attributes.friendly_name ?? d.entity;
    if (!st || st.state === 'unavailable' || st.state === 'unknown') {
      return this._showToast(st ? L().unavailableInHa(name) : L().missingInHa(d.entity));
    }
    // serviço pelo tipo real da entidade (um interruptor desenhado como luz continua sendo switch)
    const svc = tapService(d.entity.split('.')[0]);
    if (!svc || !this._hass) return this._moreInfo(d.entity);
    try {
      await this._hass.callService(svc[0], svc[1], { entity_id: d.entity });
    } catch (e) {
      return this._showToast(L().failed(String((e as Error).message ?? e)));
    }
    // o HA aceitou, mas o aparelho pode não reagir (fora do ar, sem bateria…)
    const before = st.last_changed;
    window.setTimeout(() => {
      if (this._hass?.states[d.entity]?.last_changed === before) this._showToast(L().noResponse(name));
    }, 4000);
  }

  // ---------- música ----------

  private get _player(): HassEntity | undefined {
    const id = this._config.music?.entity;
    return id ? this._hass?.states[id] : undefined;
  }

  private async _callPlayer(service: string, data: Record<string, unknown> = {}) {
    const id = this._config.music?.entity;
    if (!id || !this._hass) return;
    try {
      await this._hass.callService('media_player', service, { entity_id: id, ...data });
    } catch (e) {
      this._showToast(L().failed(String((e as Error).message ?? e)));
    }
  }

  /** caixa tocando: pausa/continua; outra caixa: leva a música para ela */
  private async _tapSpeaker(d: Device) {
    const st = this._player;
    if (speakerIsCurrent(st, d.speaker) && st?.state !== 'off') return this._callPlayer('media_play_pause');
    this._showToast(L().playingOn(String(d.name ?? d.speaker)));
    await this._callPlayer('select_source', { source: d.speaker });
  }

  private _openMusic() {
    this._musicOpen = true;
  }

  private _closeMusic() {
    this._musicOpen = false;
  }

  /** erros do painel de música viram o toast do HADash */
  private _onPanelNote(e: CustomEvent<{ message: string }>) {
    e.stopPropagation();
    this._showToast(e.detail.message);
  }

  /** "tocando agora" fixo no canto (o próprio painel some quando nada toca) */
  private _renderNowPlaying() {
    const m = this._config.music;
    if (!m?.entity || m.now_playing === false || this._musicOpen) return nothing;
    return html`<spotify-panel
      class="np-host"
      mode="mini"
      .hass=${this._hass}
      entity=${m.entity}
      @spotify-panel-open=${this._openMusic}
      @hass-notification=${this._onPanelNote}
    ></spotify-panel>`;
  }

  // ---------- editor de planta ----------

  private get _canEdit() {
    if (this._config.editor !== undefined) return this._config.editor;
    // no HA: só administradores; no demo (sem usuário): sempre
    return this._hass?.user ? !!this._hass.user.is_admin : true;
  }

  private _openEditor() {
    this._editBase = this._config;
    this._musicOpen = false;
    this._editing = true;
    this._previewing = false;
  }

  private _closeEditor() {
    if (this._editBase && this._config !== this._editBase) this.setConfig(this._editBase);
    this._editing = false;
    this._previewing = false;
    this._editBase = undefined;
  }

  /** mostra a planta do editor no 3D sem salvar */
  private _preview(cfg: CardConfig) {
    this.setConfig(cfg);
    this._previewing = true;
  }

  private async _saveConfig(cfg: CardConfig) {
    const base = this._editBase ?? this._config;
    try {
      await saveCardConfig(this._hass, base, cfg);
      this._showToast(L().planSaved);
    } catch {
      // listas de números numa linha só: [8.2, 7.8] em vez de uma linha por número
      this._yaml = JSON.stringify(cfg, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]');
    }
    this.setConfig(cfg);
    this._editing = false;
    this._previewing = false;
    this._editBase = undefined;
  }

  private _moreInfo(entityId: string) {
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }

  private _kickIdle() {
    this._scene?.setAutoRotate(false);
    clearTimeout(this._idleTimer);
    const secs = this._config.idle_seconds ?? 90;
    if (!secs) return;
    this._idleTimer = window.setTimeout(() => {
      if (this._coordMode || this._editing) return;
      this._musicOpen = false;
      this._setFloor(this._defaultFloor());
      if (this._config.idle_rotate ?? true) this._scene?.setAutoRotate(true);
    }, secs * 1000);
  }

  private _toggleCoords() {
    this._coordMode = !this._coordMode;
    this._coord = undefined;
    if (this._scene) this._scene.coordMode = this._coordMode;
    this._scene?.showCoordMarker(null);
  }

  private _copyCoord() {
    if (!this._coord) return;
    navigator.clipboard?.writeText(`[${this._coord[0]}, ${this._coord[1]}]`).then(
      () => this._showToast(L().coordCopied),
      () => {},
    );
  }

  private _showToast(msg: string) {
    this._toast = msg;
    clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => (this._toast = undefined), 2500);
  }

  // ---------- render ----------

  /** painel lateral de cômodos: nome + temperatura, presença e luzes acesas */
  private _renderRail() {
    const st = this._hass?.states ?? {};
    const visible = this._rooms.filter((r) => this._floor === 'all' || r.floor === this._floor);
    const totalOn = visible.reduce((n, r) => n + this._lightsOn(r), 0);
    const showFloors = this._floor === 'all' && this._floors.length > 1;
    const temp = (r: Room) => {
      const v = r.temperature ? Number(st[r.temperature]?.state) : NaN;
      return Number.isFinite(v) ? html`<span class="t">${v.toFixed(1)}°</span>` : nothing;
    };
    const item = (r: Room) => {
      const n = this._lightsOn(r);
      const motion = !!r.motion && st[r.motion]?.state === 'on';
      return html`<button class="room ${this._focused === r.id ? 'sel' : ''}" @click=${() => this._pickRoom(r.id)}>
        <span class="nm">${this._roomName(r)}</span>
        <span class="meta">
          ${temp(r)} ${motion ? html`<i class="mot" title=${L().motion}></i>` : nothing}
          ${n ? html`<i class="on" title=${L().lightsOn(n)}>${ICON_BULB}${n}</i>` : nothing}
        </span>
      </button>`;
    };
    return html`<nav class="rail ${this._railOpen ? 'open' : ''}">
      <button class="rail-toggle" @click=${() => (this._railOpen = !this._railOpen)}>
        ${ICON_LIST}<span>${this._focused ? this._roomName(this._rooms.find((r) => r.id === this._focused)!) : L().rooms}</span>
        <svg class="chev" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      <div class="rail-list">
        <button class="room home ${this._focused === null ? 'sel' : ''}" @click=${() => this._pickRoom(null)}>
          <span class="nm">${this._floor === 'all' ? L().wholeHouse : this._floors[this._floor]?.name ?? L().home}</span>
          <span class="meta">${totalOn ? html`<i class="on">${ICON_BULB}${totalOn}</i>` : html`<span class="t">${L().allOff}</span>`}</span>
        </button>
        ${showFloors
          ? this._floors.map(
              (f) => html`<div class="rail-head">${f.name}</div>
                ${visible.filter((r) => r.floor === f.index).map(item)}`,
            )
          : visible.map(item)}
      </div>
    </nav>`;
  }

  // ---------- ações (scripts, cenas, automações) ----------

  /** o menu mostra só cenas e scripts; automação aparece apenas fixada no alto (actions_pinned) */
  private _menuActions() {
    return this._hass ? listActions(this._hass, this._config.actions).filter((i) => i.domain !== 'automation') : [];
  }

  private _toggleActions = () => {
    this._actionsOpen = !this._actionsOpen;
    this._railOpen = false;
    if (this._actionsOpen && this._hass) {
      loadTargets(this._hass, this._menuActions()).then((m) => (this._actionTargets = m));
    }
  };

  /** a ação mexe em algo deste cômodo? (dispositivo da planta, área do cômodo ou entidade da área) */
  private _touchesRoom(t: ActionTargets | undefined, r: Room) {
    if (!t) return false;
    if (r.area && t.areas.has(r.area)) return true;
    for (const id of t.entities) {
      if (r.devices.some((d) => d.entity === id)) return true;
      const e = this._hass?.entities?.[id];
      const area = e?.area_id ?? (e?.device_id ? this._hass?.devices?.[e.device_id]?.area_id : undefined);
      if (r.area && area === r.area) return true;
    }
    return false;
  }

  /** resumo do que a ação faz: cômodos afetados, senão quantidade de dispositivos */
  private _targetSummary(t?: ActionTargets) {
    if (!t) return '';
    const rooms = this._rooms.filter((r) => this._touchesRoom(t, r)).map((r) => this._roomName(r));
    if (rooms.length) return rooms.length > 2 ? `${rooms.slice(0, 2).join(', ')} +${rooms.length - 2}` : rooms.join(', ');
    const n = t.entities.size;
    return n ? `${n} dispositivo${n > 1 ? 's' : ''}` : '';
  }

  private async _run(it: ActionItem) {
    if (!this._hass) return;
    try {
      await runAction(this._hass, it);
      this._showToast(L().actionDone(it.name));
      // retorno na planta: pulsam os dispositivos que a ação mexe
      const t = this._actionTargets?.get(it.id);
      if (t) for (const r of this._rooms) for (const d of r.devices) if (t.entities.has(d.entity)) this._scene?.pulse(d);
    } catch (e) {
      this._showToast(L().failed(String((e as Error).message ?? e)));
    }
  }

  private _actIcon(it: ActionItem) {
    const fallback = { script: 'mdi:play-circle-outline', scene: 'mdi:palette-outline', automation: 'mdi:robot-outline' }[it.domain];
    return customElements.get('ha-icon')
      ? html`<ha-icon .icon=${it.icon ?? fallback}></ha-icon>`
      : html`<i class="glyph">${it.domain === 'automation' ? 'A' : it.domain === 'scene' ? '✦' : '▶'}</i>`;
  }

  private _renderActions() {
    const hass = this._hass;
    if (!hass) return nothing;
    const items = this._menuActions();
    const t = this._actionTargets;
    const room = this._focused ? this._rooms.find((r) => r.id === this._focused) : undefined;
    const here = room && t ? items.filter((it) => it.domain !== 'automation' && this._touchesRoom(t.get(it.id), room)) : [];
    const runnable = items.filter((i) => i.domain !== 'automation' && !here.includes(i));
    const tile = (it: ActionItem) => html`<button class="act ${it.state === 'on' && it.domain === 'script' ? 'running' : ''}" @click=${() => this._run(it)}>
      <span class="ic">${this._actIcon(it)}</span>
      <span class="tx"><b>${it.name}</b><small>${this._targetSummary(t?.get(it.id)) || (it.domain === 'scene' ? L().scene : L().routine)}</small></span>
      <span class="go">${ICON_PLAY}</span>
    </button>`;
    return html`<aside class="actions" @pointerdown=${() => this._kickIdle()}>
      <header>
        <h3>${L().actions}</h3>
        <button class="x" @click=${this._toggleActions} title=${L().close}>${ICON_CLOSE}</button>
      </header>
      ${here.length
        ? html`<h4>${L().inThisRoom(this._roomName(room!))}</h4>
            <div class="acts">${here.map(tile)}</div>`
        : nothing}
      ${runnable.length ? html`<h4>${here.length ? L().otherScenesAndRoutines : L().scenesAndRoutines}</h4>` : nothing}
      ${runnable.length
        ? html`<div class="acts">${runnable.map(tile)}</div>`
        : here.length
          ? nothing
          : html`<h4>${L().scenesAndRoutines}</h4><p class="empty">${L().noScenes}</p>`}
    </aside>`;
  }

  /** atalhos fixos no alto (actions_pinned) */
  private _renderDock() {
    const ids = this._config.actions_pinned;
    if (!ids?.length || !this._hass) return nothing;
    const items = listActions(this._hass, ids);
    if (!items.length) return nothing;
    return html`<div class="dock">
      ${items.map((it) => html`<button @click=${() => this._run(it)} title=${it.name}>${this._actIcon(it)}<span>${it.name}</span></button>`)}
    </div>`;
  }

  /** escolher na lista fecha o painel (tela estreita) */
  private _pickRoom(id: string | null) {
    this._focus(id);
    this._railOpen = false;
  }

  private _lightsOn(r: Room) {
    const st = this._hass?.states ?? {};
    return r.devices.filter((d) => d.domain === 'light' && st[d.entity]?.state === 'on').length;
  }

  render() {
    if (!this._config) return nothing;
    const time = this._now.toLocaleTimeString(L().locale, { hour: '2-digit', minute: '2-digit' });
    const date = this._now.toLocaleDateString(L().locale, { weekday: 'long', day: 'numeric', month: 'long' });
    return html`
      <div class="card" style="height:${this._config.height ?? '600px'}">
        ${this._renderSky()}
        <div class="stage"></div>
        ${this._renderWeatherFx()}

        <div class="top">
          <div class="clock">
            <div class="time">${time}</div>
            <div class="date">${this._config.title ? `${this._config.title} · ` : ''}${date}</div>
            ${this._renderWeatherLine()}
          </div>
          <div class="tools">
            ${this._hass && this._menuActions().length
              ? html`<button class=${this._actionsOpen ? 'active-soft' : ''} @click=${this._toggleActions} title=${L().actions}>${ICON_BOLT}</button>`
              : nothing}
            ${this._config.music
              ? html`<button class=${this._player?.state === 'playing' ? 'playing' : ''} @click=${this._openMusic} title=${L().music}>
                  ${ICON_MUSIC}
                </button>`
              : nothing}
            ${this._canEdit
              ? html`<button @click=${this._openEditor} title=${L().editPlan}>${ICON_EDIT}</button>`
              : nothing}
            ${this._config.show_coords
              ? html`<button class=${this._coordMode ? 'active' : ''} @click=${this._toggleCoords} title=${L().ruler}>
                  ${ICON_RULER}
                </button>`
              : nothing}
            <button @click=${() => this._setFloor(this._defaultFloor())} title=${L().overview}>${ICON_HOME}</button>
          </div>
        </div>

        ${this._coordMode
          ? html`<div class="coord" @click=${this._copyCoord}>
              ${this._coord
                ? html`${this._floors.length > 1 ? html`<span>${this._floors[this._coordFloor]?.name}</span>` : nothing}
                  <b>[${this._coord[0]}, ${this._coord[1]}]</b><span>${L().tapToCopy}</span>`
                : html`<span>${L().tapFloorForCoord}</span>`}
            </div>`
          : nothing}

        ${this._floors.length > 1
          ? html`<div class="floors">
              <button class=${this._floor === 'all' ? 'sel' : ''} @click=${() => this._setFloor('all')}>
                ${ICON_LAYERS}<span>${L().allFloors}</span>
              </button>
              ${[...this._floors].reverse().map(
                (f) => html`<button class=${this._floor === f.index ? 'sel' : ''} @click=${() => this._setFloor(f.index)}>
                  <b>${f.index === 0 ? L().groundShort : f.index}</b><span>${f.name}</span>
                </button>`,
              )}
            </div>`
          : nothing}

        ${this._renderRail()}

        ${this._renderDock()}
        ${this._actionsOpen ? this._renderActions() : nothing}
        ${this._renderNowPlaying()}

        ${this._musicOpen
          ? html`<div class="sheet" @pointerdown=${() => this._kickIdle()}>
              <button class="close" @click=${this._closeMusic} title=${L().close}>${ICON_CLOSE}</button>
              <spotify-panel
                class="sheet-body"
                mode="full"
                .hass=${this._hass}
                entity=${this._config.music?.entity ?? ''}
                .card=${this._config.music?.card}
                @hass-notification=${this._onPanelNote}
              ></spotify-panel>
            </div>`
          : nothing}

        ${this._editing
          ? html`<hadash-editor
              style=${this._previewing ? 'display:none' : ''}
              .hass=${this._hass}
              .initial=${this._editBase}
              @editor-close=${this._closeEditor}
              @editor-preview=${(e: CustomEvent) => this._preview(e.detail)}
              @editor-save=${(e: CustomEvent) => this._saveConfig(e.detail)}
            ></hadash-editor>`
          : nothing}
        ${this._previewing
          ? html`<div class="previewbar">
              <span>${L().previewNotSaved}</span>
              <button @click=${() => (this._previewing = false)}>${L().backToEditor}</button>
              <button
                class="primary"
                @click=${() => this._saveConfig((this.renderRoot.querySelector('hadash-editor') as any).buildConfig())}
              >
                ${L().save}
              </button>
            </div>`
          : nothing}
        ${this._yaml
          ? html`<div class="yaml">
              <div>
                <h3>${L().cantSaveTitle}</h3>
                <p>${L().cantSaveText}</p>
                <textarea readonly .value=${this._yaml}></textarea>
                <div class="row">
                  <button @click=${() => navigator.clipboard?.writeText(this._yaml!).then(() => this._showToast(L().copied))}>
                    ${L().copy}
                  </button>
                  <button class="primary" @click=${() => (this._yaml = undefined)}>${L().close}</button>
                </div>
              </div>
            </div>`
          : nothing}

        ${this._toast ? html`<div class="toast">${this._toast}</div>` : nothing}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      --fg: #eef0f3;
      --muted: #9aa3ae;
      --glass: rgba(20, 23, 29, 0.62);
      --accent: #ffb45c;
      font-family: var(--paper-font-body1_-_font-family, system-ui, -apple-system, sans-serif);
    }
    .card {
      container: hadash / inline-size;
      position: relative;
      overflow: hidden;
      border-radius: var(--ha-card-border-radius, 16px);
      background: #1b1e24;
      color: var(--fg);
      user-select: none;
      -webkit-user-select: none;
    }
    .stage {
      position: absolute;
      inset: 0;
      /* o CSS2DRenderer põe z-index alto nos rótulos: mantém tudo abaixo do resto da UI */
      isolation: isolate;
      z-index: 0;
    }
    .stage canvas {
      display: block;
    }
    .labels {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .room-label {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-top: 46px;
      padding: 3px 10px;
      border-radius: 10px;
      background: var(--glass);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      font-size: 13px;
      line-height: 1.25;
      white-space: nowrap;
    }
    .room-label span:empty {
      display: none;
    }
    .room-label span {
      color: var(--muted);
      font-size: 12px;
    }
    .room-label.motion b::before {
      content: '';
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: 6px;
      border-radius: 50%;
      background: #ff9f43;
      box-shadow: 0 0 6px #ff9f43;
      vertical-align: 1px;
    }
    .dev-label {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2px 8px;
      border-radius: 8px;
      background: rgba(10, 12, 16, 0.75);
      font-size: 11px;
      line-height: 1.25;
      white-space: nowrap;
      color: var(--muted);
    }
    .dev-label b {
      color: var(--fg);
      font-weight: 600;
    }
    .dev-label.on span {
      color: var(--accent);
    }
    .top {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 16px 18px;
      pointer-events: none;
    }
    /* relógio e tempo ficam sobre o céu (claro de dia): sombra suave mantém a leitura */
    .clock {
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55), 0 0 18px rgba(0, 0, 0, 0.35);
    }
    .clock .date,
    .clock .wline span {
      color: rgba(238, 240, 243, 0.86);
    }
    .clock .wline svg {
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
    }
    .time {
      font-size: 44px;
      font-weight: 300;
      letter-spacing: -1px;
      line-height: 1;
    }
    .date {
      margin-top: 4px;
      color: var(--muted);
      font-size: 14px;
      text-transform: capitalize;
    }
    .wline {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 14px;
      color: var(--fg);
    }
    .wline svg {
      width: 20px;
      height: 20px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .wline b {
      font-size: 16px;
      font-weight: 600;
    }
    .wline span {
      color: var(--muted);
    }
    /* ---------- céu ---------- */
    .sky {
      position: absolute;
      inset: 0;
      overflow: hidden;
      background: linear-gradient(180deg, var(--sky-top) 0%, var(--sky-bottom) 100%);
      pointer-events: none;
    }
    .sky .stars {
      position: absolute;
      inset: 0 0 35% 0;
      opacity: var(--stars);
      background-image: radial-gradient(1.2px 1.2px at 12% 18%, #fff 50%, transparent 51%),
        radial-gradient(1px 1px at 33% 8%, #fff 50%, transparent 51%),
        radial-gradient(1.4px 1.4px at 58% 22%, #fff 50%, transparent 51%),
        radial-gradient(1px 1px at 76% 12%, #fff 50%, transparent 51%),
        radial-gradient(1.2px 1.2px at 91% 30%, #fff 50%, transparent 51%),
        radial-gradient(1px 1px at 22% 40%, #fff 50%, transparent 51%),
        radial-gradient(1px 1px at 47% 35%, #dfe8ff 50%, transparent 51%),
        radial-gradient(1.3px 1.3px at 67% 45%, #fff 50%, transparent 51%);
      background-size: 420px 300px;
      animation: twinkle 7s ease-in-out infinite alternate;
    }
    @keyframes twinkle {
      to {
        filter: brightness(0.55);
      }
    }
    .sky .sunglow {
      position: absolute;
      inset: 0;
      opacity: var(--sunglow);
      /* fora do canto dos botões: sol à direita, um pouco abaixo do topo */
      background: radial-gradient(circle at 66% 19%, #fffdf0 0 2.6%, rgba(255, 246, 205, 0.9) 3.4%, rgba(255, 232, 170, 0.45) 9%, rgba(255, 222, 150, 0.16) 22%, transparent 42%);
    }
    .sky .moon {
      position: absolute;
      inset: 0;
      opacity: var(--moon);
      background: radial-gradient(circle at 66% 19%, #f3f0e6 0 1.9%, rgba(225, 232, 255, 0.4) 2.6%, rgba(200, 212, 255, 0.12) 9%, transparent 20%);
    }
    .sky .overcast {
      position: absolute;
      inset: 0;
      opacity: var(--overcast);
      background: linear-gradient(180deg, var(--cloud) 0%, var(--cloud) 22%, transparent 75%);
      filter: blur(2px);
    }
    .sky .clouds {
      position: absolute;
      inset: 0 0 30% 0;
      opacity: var(--clouds);
    }
    .sky .clouds i {
      position: absolute;
      top: 0;
      left: 0;
      width: 200%;
      height: 100%;
      /* nuvens "fofas": cada uma é um cacho de 3 elipses */
      background-image: radial-gradient(ellipse 7% 9% at 10% 26%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 9% 12% at 14.5% 20%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 7% 8% at 19% 27%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 8% 9% at 52% 16%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 11% 13% at 57% 10%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 8% 8% at 62.5% 17%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 6% 7% at 82% 38%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 8% 10% at 86% 33%, var(--cloud) 55%, transparent 72%),
        radial-gradient(ellipse 6% 7% at 90% 39%, var(--cloud) 55%, transparent 72%);
      background-size: 50% 100%;
      filter: blur(3px);
      animation: drift 240s linear infinite;
    }
    .sky .clouds i:nth-child(2) {
      top: 22%;
      opacity: 0.75;
      transform: scale(0.8);
      animation-duration: 380s;
    }
    .sky .clouds.still i {
      animation: none;
    }
    @keyframes drift {
      to {
        transform: translateX(-50%);
      }
    }
    /* névoa: no horizonte e também por cima da base da casa */
    .wx .fogfront {
      position: absolute;
      inset: 35% 0 0 0;
      opacity: var(--fog);
      background: linear-gradient(180deg, transparent, rgba(214, 220, 228, 0.45) 55%, rgba(220, 225, 232, 0.6));
    }
    /* ---------- chuva / neve / raio ---------- */
    .wx {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }
    /* gotas/flocos: padrão que se repete e desce exatamente 1 ladrilho por ciclo (loop sem emenda) */
    .wx .rain i,
    .wx .snow i {
      position: absolute;
      left: 0;
      right: 0;
      will-change: transform;
    }
    .wx .rain i:nth-child(1) {
      top: -160px;
      height: calc(100% + 160px);
      background-image: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%22160%22%3E%3Cg stroke=%22rgba%28205%2C220%2C245%2C0.75%29%22 stroke-width=%221.3%22 stroke-linecap=%22round%22%3E%3Cline x1=%2214%22 y1=%2210%22 x2=%229%22 y2=%2232%22/%3E%3Cline x1=%2252%22 y1=%2248%22 x2=%2247%22 y2=%2266%22/%3E%3Cline x1=%2230%22 y1=%2296%22 x2=%2225%22 y2=%22120%22/%3E%3Cline x1=%2268%22 y1=%22118%22 x2=%2263%22 y2=%22138%22/%3E%3Cline x1=%228%22 y1=%22130%22 x2=%223%22 y2=%22146%22/%3E%3C/g%3E%3C/svg%3E");
      background-size: 80px 160px;
      animation: fall160 0.45s linear infinite;
      opacity: 0.7;
    }
    .wx .rain i:nth-child(2) {
      top: -240px;
      height: calc(100% + 240px);
      background-image: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%22240%22%3E%3Cg stroke=%22rgba%28205%2C220%2C245%2C0.5%29%22 stroke-width=%221.1%22 stroke-linecap=%22round%22%3E%3Cline x1=%2220%22 y1=%2220%22 x2=%2215%22 y2=%2250%22/%3E%3Cline x1=%2284%22 y1=%2270%22 x2=%2279%22 y2=%2296%22/%3E%3Cline x1=%2250%22 y1=%22140%22 x2=%2245%22 y2=%22172%22/%3E%3Cline x1=%22104%22 y1=%22180%22 x2=%2299%22 y2=%22204%22/%3E%3Cline x1=%2210%22 y1=%22200%22 x2=%225%22 y2=%22222%22/%3E%3C/g%3E%3C/svg%3E");
      background-size: 120px 240px;
      animation: fall240 0.9s linear infinite;
      opacity: 0.55;
    }
    .wx.heavy .rain i:nth-child(1) {
      opacity: 1;
      animation-duration: 0.32s;
    }
    .wx.heavy .rain i:nth-child(2) {
      opacity: 0.85;
      animation-duration: 0.6s;
    }
    @keyframes fall160 {
      to {
        transform: translateY(160px);
      }
    }
    @keyframes fall240 {
      to {
        transform: translateY(240px);
      }
    }
    .wx .snow i:nth-child(1) {
      top: -160px;
      height: calc(100% + 160px);
      background-image: radial-gradient(2px 2px at 10% 20%, #fff 50%, transparent 51%),
        radial-gradient(2.5px 2.5px at 40% 60%, #fff 50%, transparent 51%),
        radial-gradient(1.8px 1.8px at 70% 30%, #fff 50%, transparent 51%),
        radial-gradient(2.2px 2.2px at 85% 80%, #fff 50%, transparent 51%);
      background-size: 160px 160px;
      animation: fall160 6s linear infinite;
      opacity: 0.85;
    }
    .wx .snow i:nth-child(2) {
      top: -240px;
      height: calc(100% + 240px);
      background-image: radial-gradient(1.6px 1.6px at 25% 35%, #fff 50%, transparent 51%),
        radial-gradient(2px 2px at 65% 75%, #fff 50%, transparent 51%),
        radial-gradient(1.4px 1.4px at 90% 15%, #fff 50%, transparent 51%);
      background-size: 240px 240px;
      animation: fall240 11s linear infinite;
      opacity: 0.55;
    }
    .wx .flash {
      position: absolute;
      inset: 0;
      background: #dfe8ff;
      opacity: 0;
      animation: flash 11s infinite;
    }
    @keyframes flash {
      0%,
      90%,
      92%,
      95%,
      100% {
        opacity: 0;
      }
      91% {
        opacity: 0.35;
      }
      93.5% {
        opacity: 0.22;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .sky *,
      .wx * {
        animation: none !important;
      }
    }
    .tools {
      display: flex;
      gap: 8px;
      pointer-events: auto;
    }
    .tools button {
      width: 48px;
      height: 48px;
      border: 0;
      border-radius: 14px;
      background: var(--glass);
      color: var(--fg);
      display: grid;
      place-items: center;
      cursor: pointer;
      backdrop-filter: blur(6px);
    }
    .tools button.playing {
      color: #1ed760;
    }
    .np-host {
      position: absolute;
      right: 16px;
      bottom: 16px;
      z-index: 2;
      width: 340px;
      max-width: calc(100% - 32px);
    }
    .sheet {
      position: absolute;
      inset: 0;
      z-index: 5;
      background: rgba(12, 14, 18, 0.72);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      display: flex;
      padding: 16px;
      box-sizing: border-box;
    }
    .sheet .close {
      position: absolute;
      top: 22px;
      right: 22px;
      z-index: 1;
      width: 48px;
      height: 48px;
      border: 0;
      border-radius: 14px;
      background: var(--glass);
      color: var(--fg);
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .sheet svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }
    .sheet-body {
      flex: 1;
      min-height: 0;
      border-radius: 16px;
      overflow: hidden;
      /* espaço do botão fechar no canto */
      --sp-nav-gap: 60px;
    }
    .tools button.active {
      background: #ff3d7f;
    }
    .tools svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }
    .floors {
      position: absolute;
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 6px;
      border-radius: 18px;
      background: var(--glass);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    .floors button {
      width: 64px;
      min-height: 56px;
      border: 0;
      border-radius: 13px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      cursor: pointer;
    }
    .floors button b {
      font-size: 20px;
      font-weight: 600;
      line-height: 1;
    }
    .floors button span {
      font-size: 10px;
      color: var(--muted);
      max-width: 60px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .floors button svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }
    .floors button.sel {
      background: var(--fg);
      color: #15181d;
    }
    .floors button.sel span {
      color: #15181d;
    }
    .tools button.active-soft {
      background: var(--fg);
      color: #15181d;
    }
    /* ---------- painel de ações (abre pela direita, a casa continua visível) ---------- */
    .actions {
      position: absolute;
      top: 12px;
      right: 12px;
      max-height: calc(100% - 24px);
      z-index: 6;
      width: min(360px, calc(100% - 24px));
      box-sizing: border-box;
      overflow-y: auto;
      scrollbar-width: none;
      padding: 14px 14px 18px;
      border-radius: 20px;
      background: rgba(18, 21, 27, 0.86);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
      animation: slidein 0.22s ease-out;
    }
    @keyframes slidein {
      from {
        opacity: 0;
        transform: translateX(24px);
      }
    }
    .actions header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .actions h3 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }
    .actions h4 {
      margin: 16px 2px 8px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .actions .x {
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .actions .x svg,
    .act .go svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }
    .acts {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .act {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 60px;
      padding: 8px 10px 8px 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--fg);
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }
    .act:active {
      transform: scale(0.98);
      background: rgba(255, 255, 255, 0.1);
    }
    .act .ic {
      width: 44px;
      height: 44px;
      flex: none;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, rgba(255, 180, 92, 0.25), rgba(255, 180, 92, 0.08));
      color: var(--accent);
      --mdc-icon-size: 24px;
    }
    .act .tx {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .act b {
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .act small {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .act .go {
      width: 36px;
      height: 36px;
      flex: none;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--fg);
      color: #15181d;
    }
    .act.running .ic {
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.5;
      }
    }
    .glyph {
      font-style: normal;
      font-weight: 700;
    }
    .empty {
      margin: 0 2px;
      color: var(--muted);
      font-size: 13px;
    }
    /* atalhos fixos no alto */
    .dock {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1;
      display: flex;
      gap: 6px;
      padding: 6px;
      border-radius: 18px;
      background: rgba(20, 23, 29, 0.72);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .dock button {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 40px;
      padding: 0 12px 0 10px;
      border: 0;
      border-radius: 12px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      --mdc-icon-size: 20px;
    }
    .dock button:active {
      background: rgba(255, 255, 255, 0.12);
    }
    @container hadash (max-width: 900px) {
      .dock span {
        display: none;
      }
    }
    .rail {
      position: absolute;
      left: 16px;
      /* abaixo do relógio + data + tempo lá fora */
      top: 140px;
      bottom: 16px;
      z-index: 1;
      width: 236px;
      display: flex;
      flex-direction: column;
      pointer-events: none;
    }
    .rail > * {
      pointer-events: auto;
    }
    /* lista de cômodos recolhida: um botão que mostra o cômodo atual e abre a lista */
    .rail-toggle {
      display: inline-flex;
      align-self: flex-start;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      max-width: 100%;
      padding: 0 16px 0 12px;
      border: 0;
      border-radius: 22px;
      background: rgba(20, 23, 29, 0.72);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      color: var(--fg);
      font: inherit;
      font-size: 14px;
      cursor: pointer;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2);
    }
    .rail-toggle span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rail-toggle svg {
      width: 20px;
      height: 20px;
      flex: none;
      fill: currentColor;
    }
    .rail-toggle .chev {
      width: 16px;
      height: 16px;
      opacity: 0.7;
      transition: transform 0.2s;
    }
    .rail.open .rail-toggle .chev {
      transform: rotate(180deg);
    }
    .rail-list {
      display: none !important;
      margin-top: 8px;
    }
    .rail.open .rail-list {
      display: flex !important;
      animation: drop 0.18s ease-out;
    }
    @keyframes drop {
      from {
        opacity: 0;
        transform: translateY(-6px);
      }
    }
    .rail-list {
      align-self: stretch;
      max-height: 100%;
      overflow-y: auto;
      scrollbar-width: none;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      box-sizing: border-box;
      border-radius: 18px;
      /* mais opaco que os outros vidros: a lista precisa ler bem sobre qualquer parte da casa */
      background: rgba(20, 23, 29, 0.8);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    }
    .rail-list::-webkit-scrollbar {
      display: none;
    }
    .rail-head {
      padding: 10px 12px 2px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .room {
      position: relative;
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 44px;
      padding: 0 12px 0 16px;
      border: 0;
      border-radius: 12px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      font-size: 14px;
      text-align: left;
      cursor: pointer;
      transition: background 0.15s;
    }
    .room:active {
      background: rgba(255, 255, 255, 0.08);
    }
    .room .nm {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .room.home .nm {
      font-weight: 600;
    }
    .room .meta {
      flex: none;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .room .on {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      height: 20px;
      padding: 0 7px 0 4px;
      border-radius: 10px;
      font-style: normal;
      font-weight: 700;
      font-size: 11px;
      background: var(--accent);
      color: #1b1e24;
    }
    .room .on svg {
      width: 13px;
      height: 13px;
      fill: currentColor;
    }
    .room .mot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ff9f43;
      box-shadow: 0 0 8px #ff9f43;
    }
    .room.sel {
      background: rgba(255, 255, 255, 0.94);
      color: #15181d;
    }
    .room.sel .meta {
      color: #4b5260;
    }
    .room.sel::before {
      content: '';
      position: absolute;
      left: 6px;
      top: 12px;
      bottom: 12px;
      width: 3px;
      border-radius: 2px;
      background: var(--accent);
    }
    /* tela estreita (tablet em pé, celular): a lista vira um botão que abre o painel */
    .dot {
      font-style: normal;
      font-size: 11px;
      font-weight: 700;
      min-width: 18px;
      height: 18px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      background: var(--accent);
      color: #1b1e24;
    }
    .coord {
      position: absolute;
      top: 84px;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 14px;
      border-radius: 12px;
      background: var(--glass);
      backdrop-filter: blur(6px);
      display: flex;
      gap: 10px;
      align-items: baseline;
      font-size: 13px;
      color: var(--muted);
    }
    .coord b {
      color: var(--fg);
      font-size: 16px;
      font-variant-numeric: tabular-nums;
    }
    hadash-editor {
      position: absolute;
      inset: 0;
      z-index: 20;
    }
    .previewbar {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 21;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 8px 8px 16px;
      border-radius: 14px;
      background: rgba(10, 12, 16, 0.9);
      font-size: 14px;
      white-space: nowrap;
    }
    .previewbar button,
    .yaml button {
      min-height: 40px;
      padding: 0 14px;
      border: 0;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.1);
      color: var(--fg);
      font: inherit;
      cursor: pointer;
    }
    .previewbar button.primary,
    .yaml button.primary {
      background: var(--accent);
      color: #15181d;
      font-weight: 600;
    }
    .yaml {
      position: absolute;
      inset: 0;
      z-index: 22;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.6);
    }
    .yaml > div {
      width: min(640px, 90%);
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 20px;
      border-radius: 16px;
      background: #1b1e24;
    }
    .yaml h3 {
      margin: 0;
    }
    .yaml p {
      margin: 0;
      color: var(--muted);
    }
    .yaml textarea {
      height: 300px;
      background: #111317;
      color: var(--fg);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      font: 12px/1.4 ui-monospace, monospace;
    }
    .yaml .row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .toast {
      position: absolute;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 14px;
      border-radius: 10px;
      background: rgba(10, 12, 16, 0.85);
      font-size: 13px;
    }
  `;
}

const ICON_HOME = html`<svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>`;
const ICON_MUSIC = html`<svg viewBox="0 0 24 24">
  <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z" />
</svg>`;
const ICON_EDIT = html`<svg viewBox="0 0 24 24">
  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z" />
</svg>`;
const ICON_BULB = html`<svg viewBox="0 0 24 24">
  <path d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2M9 21a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-1H9z" />
</svg>`;
const ICON_LIST = html`<svg viewBox="0 0 24 24"><path d="M3 5h2v2H3zm4 0h14v2H7zm-4 6h2v2H3zm4 0h14v2H7zm-4 6h2v2H3zm4 0h14v2H7z" /></svg>`;
const ICON_BOLT = html`<svg viewBox="0 0 24 24"><path d="M11 21h-1l1-7H7.5c-.6 0-.5-.4-.3-.7L13 3h1l-1 7h3.5c.5 0 .6.3.4.7z" /></svg>`;
const ICON_PLAY = html`<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>`;
const ICON_CLOSE = html`<svg viewBox="0 0 24 24">
  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
</svg>`;
const ICON_LAYERS = html`<svg viewBox="0 0 24 24">
  <path d="M12 16.5 3 9.75 12 3l9 6.75zm0 2.6 7.4-5.55L21 14.75 12 21.5l-9-6.75 1.6-1.2z" />
</svg>`;
const ICON_RULER = html`<svg viewBox="0 0 24 24">
  <path
    d="M1.39 18.36l1.77 1.77 2.83-2.83-1.06-1.06 1.41-1.41 1.06 1.06 1.42-1.42-1.06-1.06 1.41-1.41 1.06 1.06 1.42-1.42-1.06-1.06 1.41-1.41 1.06 1.06 1.42-1.42-1.06-1.06 1.41-1.41 1.06 1.06 2.83-2.83-1.77-1.77z"
  />
</svg>`;

/**
 * troca a config deste card no dashboard atual (modo "storage" do HA): acha o card idêntico à config antiga
 * em qualquer nível (views, sections, stacks) e salva
 */
async function saveCardConfig(hass: Hass | undefined, oldCfg: CardConfig, newCfg: CardConfig) {
  if (!hass) throw new Error(L().errNoHa);
  const seg = location.pathname.split('/')[1];
  const url_path = !seg || seg === 'lovelace' ? null : seg;
  const conf = await hass.callWS<Record<string, unknown>>({ type: 'lovelace/config', url_path });
  const target = JSON.stringify(oldCfg);
  // todos os HADash do dashboard (em qualquer nível: views, sections, stacks)
  const slots: { list: unknown[]; i: number; same: boolean }[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((c, i) => {
        if (c && typeof c === 'object' && (c as CardConfig).type === newCfg.type)
          slots.push({ list: node, i, same: JSON.stringify(c) === target });
        else walk(c);
      });
    } else if (node && typeof node === 'object') for (const v of Object.values(node)) walk(v);
  };
  walk(conf);
  // um HADash só: é ele; vários: o que tem a config idêntica à de antes; senão não arrisca salvar no lugar errado
  const hit = slots.length === 1 ? slots[0] : slots.filter((x) => x.same).length === 1 ? slots.find((x) => x.same) : undefined;
  if (!hit) throw new Error(L().errCardNotFound(slots.length));
  hit.list[hit.i] = newCfg;
  await hass.callWS({ type: 'lovelace/config/save', url_path, config: conf });
}


if (!customElements.get('hadash-card')) {
  customElements.define('hadash-card', HadashCard);
  ((window as any).customCards ??= []).push({
    type: 'hadash-card',
    name: 'HADash 3D',
    description: L().cardDescription,
  });
  console.info(`%cHADASH-CARD ${VERSION}`, 'color:#ffb45c;font-weight:bold');
}
