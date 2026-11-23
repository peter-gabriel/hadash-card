import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { aoBand, aoTexture, floorKind, floorTexture, MAX_ROOM_LIGHTS, roomLightMaterial, wallBox } from './render-fx';
import { bounds, roomLabel, signedArea, wallSegments, type Device, type Floor, type Room } from './house';
import type { HassEntity, StairConfig, Vec2 } from './types';
import { deviceVisual, deviceName, speakerText, stateText } from './states';

export interface SceneOptions {
  wallHeight: number;
  wallThickness: number;
  floorHeight: number;
  /** "low": sem sombras nem iluminação de ambiente (tablets fracos) */
  quality?: 'high' | 'low';
  /** graus: quanto a planta está girada em relação ao norte (0 = topo da planta é o norte) */
  north?: number;
}

export interface SceneCallbacks {
  onTapDevice(d: Device): void;
  onHoldDevice(d: Device): void;
  onTapRoom(r: Room | null): void;
  onTapFloor(p: Vec2, floor: number): void;
  onInteract(): void;
  /** o tamanho do card mudou (painéis por cima podem ter mudado de tamanho também) */
  onResize?(): void;
}

/** piso selecionado: índice, ou todos empilhados com folga ("explodido") */
export type FloorSel = number | 'all';

interface DeviceView {
  device: Device;
  room: Room;
  fv: FloorView;
  head: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  glow: boolean;
  /** cor e brilho atuais (para a luz no piso do cômodo) */
  lightColor: string;
  level: number;
  unavailable: boolean;
  label: CSS2DObject;
  labelEl: HTMLElement;
  last?: HassEntity;
}

interface RoomView {
  room: Room;
  floor: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  base: THREE.Color;
  label: CSS2DObject;
  labelEl: HTMLElement;
  motion: boolean;
  /** luz das lâmpadas no piso, recortada no formato do cômodo */
  light: THREE.Mesh;
  lightMat: THREE.ShaderMaterial;
  lightCount: number;
  /** alcance da luz (m), proporcional ao tamanho do cômodo */
  lightRadius: number;
}

interface FloorView {
  floor: Floor;
  group: THREE.Group;
  /** materiais que esmaecem junto com o piso */
  mats: THREE.Material[];
  /** paredes/degraus projetam sombra (desligado no fantasma) */
  casting: boolean;
  y: number;
  targetY: number;
  opacity: number;
  targetOpacity: number;
}

interface Tween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  t0: number;
  dur: number;
}

const OVERVIEW_POLAR = 0.85;
const TAP_SLOP = 10;
const HOLD_MS = 550;
/** folga extra entre os pisos na vista "todos" */
const EXPLODE_GAP = 2.4;
/** opacidade dos pisos de baixo quando um piso de cima está selecionado */
const GHOST = 0.14;
const STEP_RISE = 0.18;

export class HouseScene {
  readonly renderer: THREE.WebGLRenderer;
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  private controls: OrbitControls;
  private hemi = new THREE.HemisphereLight('#f4f1ea', '#3a3530', 1.1);
  private sun = new THREE.DirectionalLight('#fff4e0', 1.6);
  private ground!: THREE.Mesh;
  private devices: DeviceView[] = [];
  private rooms = new Map<string, RoomView>();
  private floors: FloorView[] = [];
  private pickables: THREE.Object3D[] = [];
  private center = new THREE.Vector3();
  private radius = 5;
  private dirty = true;
  private raf = 0;
  private tween?: Tween;
  private ro: ResizeObserver;
  private focused: string | null = null;
  private sel: FloorSel = 'all';
  private night = false;
  private coordMarker: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private gesture?: { x: number; y: number; t: number; moved: boolean; multi: boolean; held: boolean; timer?: number };
  private pointers = new Set<number>();

  private roomNames = new Map<string, string>();

  /** nomes vindos das áreas do HA (chamado quando o registro de áreas muda) */
  setRoomNames(names: Map<string, string>) {
    this.roomNames = names;
    for (const rv of this.rooms.values()) {
      const n = names.get(rv.room.id);
      const b = rv.labelEl.querySelector('b')!;
      if (n && b.textContent !== n) b.textContent = n;
    }
    // força os rótulos dos dispositivos a recalcular o nome curto
    for (const v of this.devices) v.last = undefined;
    this.dirty = true;
  }

  private pulses = new Map<DeviceView, number>();

  /** pulso rápido no pino tocado */
  pulse(d: Device) {
    const v = this.devices.find((x) => x.device === d);
    if (v) this.pulses.set(v, performance.now());
  }

  private animatePulses(): boolean {
    if (!this.pulses.size) return false;
    const now = performance.now();
    for (const [v, t0] of this.pulses) {
      const k = (now - t0) / 380;
      if (k >= 1) {
        v.head.scale.setScalar(1);
        this.pulses.delete(v);
      } else v.head.scale.setScalar(1 + 0.6 * Math.sin(Math.PI * k));
    }
    return true;
  }

  /** régua: toques só acertam o piso */
  coordMode = false;

  private envTexture?: THREE.Texture;

  constructor(
    private container: HTMLElement,
    floorList: Floor[],
    private opts: SceneOptions,
    private cb: SceneCallbacks,
  ) {
    // fundo transparente: o céu (hora do dia/tempo) é desenhado pelo card, atrás da cena
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    const low = opts.quality === 'low';
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, low ? 1 : 2));
    this.renderer.shadowMap.enabled = !low;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // neutro: cores fiéis (as do cômodo e das lâmpadas), sem o "lavado" do ACES
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    if (!low) {
      // iluminação de estúdio (gerada uma vez): dá volume às paredes e aos pinos
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = this.envTexture;
      pmrem.dispose();
    }
    this.renderer.domElement.style.touchAction = 'none';
    this.labels.domElement.className = 'labels';
    container.append(this.renderer.domElement, this.labels.domElement);

    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.build(floorList);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = 1.15;
    this.controls.minDistance = 2;
    this.controls.maxDistance = this.radius * 5;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomToCursor = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.coordMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#ff3d7f' }),
    );
    this.coordMarker.visible = false;
    this.scene.add(this.coordMarker);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);

    this.ro = new ResizeObserver(() => {
      this.resize();
      this.cb.onResize?.();
    });
    this.ro.observe(container);
    this.resize();
    this.setNight(false);
    this.raf = requestAnimationFrame(this.tick);
  }

  // ---------- construção ----------

  private build(floorList: Floor[]) {
    const all = floorList.flatMap((f) => f.rooms.flatMap((r) => r.poly));
    const [x0, y0, x1, y1] = bounds(all.length ? all : [[0, 0], [1, 1]]);
    this.center.set((x0 + x1) / 2, 0, (y0 + y1) / 2);
    this.radius = Math.max(2, Math.hypot(x1 - x0, y1 - y0) / 2);

    // chão em volta da casa: some suave nas bordas e se mistura com o céu
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(this.radius * 1.7, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 1, transparent: true, alphaMap: groundFade(), depthWrite: false }),
    );
    this.ground.position.set(this.center.x, -0.09, this.center.z);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // sol fixo, com sombra cobrindo a casa toda (inclusive empilhada)
    const top = (floorList.at(-1)?.elevation ?? 0) + (floorList.length - 1) * EXPLODE_GAP;
    this.sun.position.set(this.center.x - this.radius, top + this.radius * 2.2, this.center.z - this.radius * 0.7);
    this.sun.target.position.copy(this.center);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 4;
    const sc = this.sun.shadow.camera;
    const ext = this.radius * 1.4 + top / 2;
    sc.left = sc.bottom = -ext;
    sc.right = sc.top = ext;
    sc.near = 0.5;
    sc.far = this.radius * 6 + top * 2;

    for (const floor of floorList) {
      const group = new THREE.Group();
      const fv: FloorView = {
        floor,
        group,
        mats: [],
        casting: true,
        y: floor.elevation,
        targetY: floor.elevation,
        opacity: 1,
        targetOpacity: 1,
      };
      group.position.y = floor.elevation;
      this.scene.add(group);
      this.floors.push(fv);

      const wallGeos: THREE.BufferGeometry[] = [];
      const aoGeos: THREE.BufferGeometry[] = [];
      for (const room of floor.rooms) {
        this.buildRoom(room, fv, wallGeos, aoGeos);
        for (const d of room.devices) this.buildDevice(d, room, fv);
      }
      // um objeto por piso para todas as paredes (e outro para as sombras de contato): bem menos chamadas de desenho
      if (wallGeos.length) {
        const wallMat = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.85 });
        fv.mats.push(wallMat);
        const walls = new THREE.Mesh(mergeGeometries(wallGeos), wallMat);
        walls.castShadow = walls.receiveShadow = true;
        walls.userData.cast = true;
        fv.group.add(walls);
        wallGeos.forEach((g) => g.dispose());
      }
      if (aoGeos.length) {
        const aoMat = new THREE.MeshBasicMaterial({
          color: '#000000',
          alphaMap: aoTexture(),
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        fv.mats.push(aoMat);
        // fade usa opacity como fração: guarda a base
        aoMat.userData.baseOpacity = 0.55;
        const ao = new THREE.Mesh(mergeGeometries(aoGeos), aoMat);
        ao.renderOrder = 1;
        fv.group.add(ao);
        aoGeos.forEach((g) => g.dispose());
      }
      const next = floorList[floor.index + 1];
      const rise = next ? next.elevation - floor.elevation : this.opts.floorHeight;
      for (const s of floor.stairs) this.buildStairs(s, rise, fv);
    }
  }

  private buildRoom(room: Room, fv: FloorView, wallGeos: THREE.BufferGeometry[], aoGeos: THREE.BufferGeometry[]) {
    const shape = new THREE.Shape(room.poly.map(([x, y]) => new THREE.Vector2(x, y)));
    // laje mais grossa nos andares de cima (aparece como "teto" do piso de baixo)
    const slab = fv.floor.index > 0 ? 0.18 : 0.08;
    // extrusão em z; girando +90° em x: (x, y, z) -> (x, -z, y), topo do piso fica em y=0
    const geo = new THREE.ExtrudeGeometry(shape, { depth: slab, bevelEnabled: false }).rotateX(Math.PI / 2);
    const base = new THREE.Color(room.color);
    const kind = floorKind(room.name || room.area || '');
    const mat = new THREE.MeshStandardMaterial({
      color: base.clone(),
      roughness: kind === 'tile' ? 0.55 : 0.8,
      map: floorTexture(kind, this.renderer.capabilities.getMaxAnisotropy()),
    });
    fv.mats.push(mat);
    const floor = new THREE.Mesh(geo, mat);
    floor.receiveShadow = true;
    floor.userData = { kind: 'room', id: room.id, floor: fv.floor.index };
    fv.group.add(floor);
    this.pickables.push(floor);

    // luz das lâmpadas: mesma forma do piso, um pouco acima
    const lightGeo = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2).translate(0, 0.012, 0);
    const lightMat = roomLightMaterial();
    const light = new THREE.Mesh(lightGeo, lightMat);
    light.visible = false;
    light.renderOrder = 2;
    fv.group.add(light);
    const [bx0, by0, bx1, by1] = room.bbox;
    // alcance da lâmpada: proporcional ao cômodo, para formar um "pool" de luz e não pintar o cômodo inteiro
    const lightRadius = Math.max(1.6, Math.min(3.4, Math.hypot(bx1 - bx0, by1 - by0) * 0.42));

    const h = room.wallHeight ?? this.opts.wallHeight;
    const t = this.opts.wallThickness;
    const side = new THREE.Color('#ece8e0');
    const cap = new THREE.Color('#4a4f57');
    const ccw = signedArea(room.poly) > 0;
    const n = room.poly.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = room.poly[i];
      const [bx, by] = room.poly[(i + 1) % n];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.01) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      // paredes vão para dentro do cômodo: dois cômodos vizinhos formam uma parede de espessura 2t
      const [nx, ny] = ccw ? [-uy, ux] : [uy, -ux];
      const holes = room.openings.filter((o) => o.edge === i);
      for (const [s0, e0] of wallSegments(len, holes)) {
        const mid = (s0 + e0) / 2;
        wallGeos.push(
          wallBox(e0 - s0, h, t, side, cap)
            .rotateY(-Math.atan2(uy, ux))
            .translate(ax + ux * mid + (nx * t) / 2, h / 2, ay + uy * mid + (ny * t) / 2),
        );
        // sombra de contato no piso, colada na face interna da parede
        aoGeos.push(aoBand([ax + ux * s0, ay + uy * s0], [ax + ux * e0, ay + uy * e0], [nx, ny], t, 0.45, 0.006));
      }
    }

    const labelEl = document.createElement('div');
    labelEl.className = 'room-label';
    labelEl.innerHTML = `<b></b><span></span>`;
    labelEl.querySelector('b')!.textContent = roomLabel(room);
    const label = new CSS2DObject(labelEl);
    label.position.set(room.center[0], 0.05, room.center[1]);
    fv.group.add(label);

    this.rooms.set(room.id, { room, floor, mat, base, label, labelEl, motion: false, light, lightMat, lightCount: 0, lightRadius });
  }

  private buildDevice(d: Device, room: Room, fv: FloorView) {
    const group = new THREE.Group();
    group.position.set(d.pos[0], 0, d.pos[1]);

    const stemMat = new THREE.MeshStandardMaterial({ color: '#8a8f98', roughness: 0.6 });
    fv.mats.push(stemMat);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, d.height, 6), stemMat);
    stem.position.y = d.height / 2;
    group.add(stem);

    const mat = new THREE.MeshStandardMaterial({ color: '#5b6370', roughness: 0.4, metalness: 0.1 });
    const geo =
      d.domain === 'light'
        ? new THREE.SphereGeometry(0.13, 24, 16)
        : d.domain === 'speaker'
          ? new THREE.SphereGeometry(0.17, 28, 16).scale(1, 0.62, 1)
          : new THREE.CylinderGeometry(0.17, 0.17, 0.07, 28);
    const head = new THREE.Mesh(geo, mat);
    head.position.y = d.height;
    head.castShadow = d.domain !== 'light';
    head.userData.cast = head.castShadow;
    group.add(head);

    // área de toque bem maior que o objeto (dedo no tablet)
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(0.38, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    );
    hit.position.y = d.height;
    hit.userData = { kind: 'device', index: this.devices.length, floor: fv.floor.index };
    group.add(hit);
    this.pickables.push(hit);

    const labelEl = document.createElement('div');
    labelEl.className = 'dev-label';
    const label = new CSS2DObject(labelEl);
    label.position.y = d.height + 0.3;
    label.visible = false;
    group.add(label);

    fv.group.add(group);
    this.devices.push({
      device: d,
      room,
      fv,
      head,
      mat,
      glow: false,
      lightColor: '#ffc46b',
      level: 0,
      unavailable: false,
      label,
      labelEl,
    });
  }

  /** escada reta de `from` (embaixo) até `to` (chega no piso de cima) */
  private buildStairs(s: StairConfig, rise: number, fv: FloorView) {
    const [ax, ay] = s.from;
    const [bx, by] = s.to;
    const run = Math.hypot(bx - ax, by - ay);
    if (run < 0.1) return;
    const n = Math.max(2, Math.round(rise / STEP_RISE));
    const w = s.width ?? 0.9;
    const tread = run / n;
    const riser = rise / n;
    const mat = new THREE.MeshStandardMaterial({ color: '#b9a58a', roughness: 0.8 });
    fv.mats.push(mat);
    const yaw = -Math.atan2(by - ay, bx - ax);
    for (let i = 0; i < n; i++) {
      const h = riser * (i + 1);
      const k = (i + 0.5) / n;
      // degrau maciço até o chão: lê melhor de qualquer ângulo
      const step = new THREE.Mesh(new THREE.BoxGeometry(tread, h, w), mat);
      step.position.set(ax + (bx - ax) * k, h / 2, ay + (by - ay) * k);
      step.rotation.y = yaw;
      step.castShadow = step.receiveShadow = true;
      step.userData.cast = true;
      fv.group.add(step);
    }
  }

  // ---------- estado do HA ----------

  updateStates(states: Record<string, HassEntity>) {
    const lightsChanged = new Set<string>();
    for (const v of this.devices) {
      const st = states[v.device.entity];
      if (st === v.last) continue;
      v.last = st;
      const vis = deviceVisual(v.device.domain, st, v.device.speaker);
      v.glow = vis.glow;
      v.unavailable = vis.unavailable;
      v.mat.color.set(vis.color);
      v.mat.emissive.set(vis.glow ? vis.color : '#000000');
      v.mat.emissiveIntensity = vis.glow ? 1.4 : 0;
      v.lightColor = vis.color;
      v.level = vis.level;
      if (v.device.domain === 'light') lightsChanged.add(v.room.id);
      this.applyDeviceFade(v);
      v.labelEl.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = deviceName(v.device, this.roomNames.get(v.room.id) ?? roomLabel(v.room), st);
      const s = document.createElement('span');
      s.textContent = v.device.domain === 'speaker' ? speakerText(st, v.device.speaker) : stateText(st);
      v.labelEl.append(b, s);
      v.labelEl.classList.toggle('on', vis.glow || vis.active);
      this.dirty = true;
    }
    if (lightsChanged.size) this.updateRoomLights(lightsChanged);
    for (const rv of this.rooms.values()) {
      const r = rv.room;
      const parts = [
        r.temperature && fmtNum(states[r.temperature], '°'),
        r.humidity && fmtNum(states[r.humidity], '%'),
      ].filter(Boolean);
      const line = parts.join(' · ');
      const span = rv.labelEl.querySelector('span')!;
      if (span.textContent !== line) span.textContent = line;
      const motion = !!r.motion && states[r.motion]?.state === 'on';
      if (motion !== rv.motion) {
        rv.motion = motion;
        rv.labelEl.classList.toggle('motion', motion);
        this.paintRoom(rv);
      }
    }
  }

  /** recalcula a luz no piso dos cômodos cujas lâmpadas mudaram */
  private updateRoomLights(ids: Iterable<string>) {
    for (const id of ids) {
      const rv = this.rooms.get(id);
      if (!rv) continue;
      const on = this.devices.filter((v) => v.room.id === id && v.device.domain === 'light' && v.glow).slice(0, MAX_ROOM_LIGHTS);
      const u = rv.lightMat.uniforms;
      on.forEach((v, i) => {
        // abajur (baixo) ilumina menos área que luz de teto
        const r = rv.lightRadius * (v.device.height < 1.1 ? 0.6 : 1);
        u.uL.value[i].set(v.device.pos[0], v.device.pos[1], r, 0.3 + 0.7 * v.level);
        u.uC.value[i].set(v.lightColor);
      });
      u.uN.value = on.length;
      rv.lightCount = on.length;
      this.applyRoomLight(rv);
    }
    this.dirty = true;
  }

  private applyRoomLight(rv: RoomView) {
    const fv = this.floors[rv.room.floor];
    const o = fv?.opacity ?? 1;
    rv.light.visible = rv.lightCount > 0 && o > 0.05;
    rv.lightMat.uniforms.uOpacity.value = o;
    // de dia a luz da lâmpada quase não aparece; à noite é o destaque
    rv.lightMat.uniforms.uGain.value = this.night ? 0.7 : 0.26;
  }

  setNight(night: boolean) {
    this.night = night;
    this.hemi.intensity = night ? 0.22 : 0.7;
    this.scene.environmentIntensity = night ? 0.12 : 0.45;
    this.applySun();
    for (const rv of this.rooms.values()) this.applyRoomLight(rv);
    for (const rv of this.rooms.values()) this.paintRoom(rv);
    this.dirty = true;
  }

  private skySun = 1;

  /** céu do momento (cor ambiente, chão, quanto sol chega) */
  setSky(sky: { ambient: string; ground: string; sun: number; night: boolean }) {
    this.skySun = sky.night ? 1 : sky.sun;
    this.hemi.color.set(sky.ambient).lerp(new THREE.Color('#ffffff'), 0.55);
    (this.ground.material as THREE.MeshStandardMaterial).color.set(sky.ground);
    // sombra mais fraca com céu encoberto
    (this.sun.shadow as THREE.LightShadow & { intensity?: number }).intensity = 0.35 + 0.65 * Math.min(1, this.skySun);
    this.applySun();
  }

  private sunElev?: number;
  private sunAz?: number;

  /** posição real do sol (graus, do sun.sun); norte = topo da planta, ajustável com `north` */
  setSun(elevation?: number, azimuth?: number) {
    if (elevation === this.sunElev && azimuth === this.sunAz) return;
    this.sunElev = elevation;
    this.sunAz = azimuth;
    this.applySun();
  }

  private applySun() {
    const e = this.sunElev;
    const top = this.floors.at(-1)?.targetY ?? 0;
    const R = this.radius * 2.5 + top;
    let dir: THREE.Vector3;
    if (e === undefined || this.sunAz === undefined || this.night) {
      // sem dado (ou noite): luz de cima-esquerda, fixa
      dir = new THREE.Vector3(-0.4, 0.8, -0.3).normalize();
    } else {
      const el = THREE.MathUtils.degToRad(Math.max(8, e));
      const az = THREE.MathUtils.degToRad(this.sunAz - (this.opts.north ?? 0));
      dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    }
    this.sun.position.copy(this.center).addScaledVector(dir, R);
    this.sun.target.position.copy(this.center);
    if (this.night) {
      this.sun.intensity = 0.1 * this.skySun;
      this.sun.color.set('#9fb4ff');
    } else {
      const k = e === undefined ? 1 : THREE.MathUtils.clamp(e / 35, 0, 1);
      // nuvens e chuva tiram luz do sol (e suavizam a sombra)
      this.sun.intensity = (0.9 + 1.1 * k) * Math.max(0.25, this.skySun);
      // sol baixo = luz mais quente
      this.sun.color.set('#ffb36b').lerp(new THREE.Color('#fff4e0'), k);
    }
    this.dirty = true;
  }

  private paintRoom(rv: RoomView) {
    const dim = this.focused && this.focused !== rv.room.id;
    rv.mat.color.copy(rv.base).multiplyScalar(dim ? 0.45 : 1);
    if (rv.motion) rv.mat.emissive.set('#ff9f43').multiplyScalar(this.night ? 0.25 : 0.18);
    else if (this.focused === rv.room.id) rv.mat.emissive.set('#ffffff').multiplyScalar(0.06);
    else rv.mat.emissive.set('#000000');
    this.dirty = true;
  }

  // ---------- pisos ----------

  get floorCount() {
    return this.floors.length;
  }

  /** escolhe o piso: os de baixo viram "fantasma", os de cima sobem e somem */
  setFloor(sel: FloorSel, moveCamera = true) {
    this.sel = this.floors.length > 1 ? sel : 0;
    for (const fv of this.floors) {
      const i = fv.floor.index;
      const e = fv.floor.elevation;
      if (this.sel === 'all') {
        fv.targetY = e + i * EXPLODE_GAP;
        fv.targetOpacity = 1;
      } else if (i < this.sel) {
        fv.targetY = e;
        fv.targetOpacity = GHOST;
      } else if (i === this.sel) {
        fv.targetY = e;
        fv.targetOpacity = 1;
      } else {
        fv.targetY = e + 4;
        fv.targetOpacity = 0;
      }
    }
    this.dirty = true;
    if (moveCamera) this.overview(true);
  }

  private animateFloors(): boolean {
    let moving = false;
    for (const fv of this.floors) {
      const dy = fv.targetY - fv.y;
      const dop = fv.targetOpacity - fv.opacity;
      if (Math.abs(dy) < 0.002 && Math.abs(dop) < 0.004) {
        if (fv.y === fv.targetY && fv.opacity === fv.targetOpacity) continue;
        fv.y = fv.targetY;
        fv.opacity = fv.targetOpacity;
      } else {
        fv.y += dy * 0.14;
        fv.opacity += dop * 0.14;
        moving = true;
      }
      this.applyFloorFade(fv);
    }
    return moving;
  }

  private applyFloorFade(fv: FloorView) {
    const o = fv.opacity;
    fv.group.position.y = fv.y;
    fv.group.visible = o > 0.01;
    for (const m of fv.mats) setFade(m, o);
    for (const rv of this.rooms.values()) if (rv.room.floor === fv.floor.index) this.applyRoomLight(rv);
    const cast = o > 0.6;
    if (cast !== fv.casting) {
      fv.casting = cast;
      fv.group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh && obj.userData.cast !== false) obj.castShadow = cast && obj.userData.cast === true;
      });
    }
    // rótulos só nos pisos "cheios"; fantasma fica limpo
    for (const rv of this.rooms.values()) if (rv.room.floor === fv.floor.index) rv.label.visible = o > 0.9;
    for (const v of this.devices) if (v.fv === fv) this.applyDeviceFade(v);
    this.dirty = true;
  }

  private applyDeviceFade(v: DeviceView) {
    setFade(v.mat, v.fv.opacity * (v.unavailable ? 0.35 : 1));
    // a caixa tocando só brilha em verde; o que toca aparece no "tocando agora" do canto
    v.label.visible = v.room.id === this.focused && v.fv.opacity > 0.9;
  }

  private floorY(index: number) {
    return this.floors[index]?.targetY ?? 0;
  }

  // ---------- câmera ----------

  focusRoom(id: string | null) {
    this.focused = id;
    for (const rv of this.rooms.values()) this.paintRoom(rv);
    for (const v of this.devices) this.applyDeviceFade(v);
    if (!id) return this.overview(true);
    const r = this.rooms.get(id)!.room;
    const [x0, y0, x1, y1] = r.bbox;
    const rad = Math.max(1.5, Math.hypot(x1 - x0, y1 - y0) / 2);
    const target = new THREE.Vector3(r.center[0], this.floorY(r.floor), r.center[1]);
    this.flyTo(target, this.fitDistance(rad * 1.5), 0.62, true);
  }

  overview(animate = true) {
    const target = this.center.clone();
    let rad = this.radius * 1.05;
    if (this.sel === 'all') {
      const top = this.floorY(this.floors.length - 1);
      target.y = top / 2;
      rad = Math.hypot(this.radius, top / 2) * 1.02;
    } else {
      target.y = this.floorY(this.sel);
    }
    this.flyTo(target, this.fitDistance(rad), OVERVIEW_POLAR, animate);
  }

  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on;
  }

  private fitDistance(rad: number) {
    const v = THREE.MathUtils.degToRad(this.camera.fov);
    const h = 2 * Math.atan(Math.tan(v / 2) * this.camera.aspect);
    return rad / Math.sin(Math.min(v, h) / 2);
  }

  private flyTo(target: THREE.Vector3, dist: number, polar: number, animate: boolean) {
    const off = this.camera.position.clone().sub(this.controls?.target ?? new THREE.Vector3());
    const sph = new THREE.Spherical().setFromVector3(off.lengthSq() > 0 ? off : new THREE.Vector3(0.6, 1, 1));
    sph.radius = dist;
    sph.phi = polar;
    const pos = target.clone().add(new THREE.Vector3().setFromSpherical(sph));
    if (!animate || !this.controls) {
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
      this.controls?.target.copy(target);
      this.dirty = true;
      return;
    }
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: pos,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      t0: performance.now(),
      dur: 750,
    };
  }

  showCoordMarker(p: Vec2 | null, floor = 0) {
    this.coordMarker.visible = !!p;
    if (p) this.coordMarker.position.set(p[0], this.floorY(floor) + 0.07, p[1]);
    this.dirty = true;
  }

  // ---------- loop ----------

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.tween) {
      const tw = this.tween;
      const k = Math.min(1, (performance.now() - tw.t0) / tw.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      if (k >= 1) this.tween = undefined;
      this.dirty = true;
    }
    if (this.animateFloors()) this.dirty = true;
    if (this.animatePulses()) this.dirty = true;
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return; // render sob demanda: tablet parado não gasta GPU
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  private insetShift = 0;

  /** espaço ocupado por painéis por cima da cena (px): o centro da vista vai para a área livre */
  setViewInsets(left: number, right: number) {
    const shift = Math.round((left - right) / 2);
    if (shift === this.insetShift) return;
    this.insetShift = shift;
    this.resize();
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    // desloca a imagem sem mudar o enquadramento (o toque e os rótulos usam a mesma projeção)
    if (this.insetShift) this.camera.setViewOffset(w, h, -this.insetShift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // ---------- toque ----------

  private onDown = (e: PointerEvent) => {
    this.pointers.add(e.pointerId);
    this.tween = undefined;
    this.cb.onInteract();
    if (this.pointers.size > 1) {
      if (this.gesture) this.gesture.multi = true;
      clearTimeout(this.gesture?.timer);
      return;
    }
    const g = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, multi: false, held: false, timer: 0 };
    g.timer = window.setTimeout(() => {
      if (g.moved || g.multi || this.coordMode) return;
      const hit = this.pick(g.x, g.y);
      if (hit?.kind === 'device') {
        g.held = true;
        this.cb.onHoldDevice(this.devices[hit.index].device);
      }
    }, HOLD_MS);
    this.gesture = g;
  };

  private onMove = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g || g.moved) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > TAP_SLOP) {
      g.moved = true;
      clearTimeout(g.timer);
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g || this.pointers.size > 0) return;
    this.gesture = undefined;
    clearTimeout(g.timer);
    if (g.moved || g.multi || g.held || performance.now() - g.t > HOLD_MS) return;
    const hit = this.pick(e.clientX, e.clientY, this.coordMode);
    if (hit?.kind === 'device') this.cb.onTapDevice(this.devices[hit.index].device);
    else if (hit?.kind === 'room') {
      const room = this.rooms.get(hit.id)!.room;
      this.cb.onTapFloor([round2(hit.point.x), round2(hit.point.z)], room.floor);
      this.cb.onTapRoom(room);
    } else this.cb.onTapRoom(null);
  };

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    clearTimeout(this.gesture?.timer);
    this.gesture = undefined;
  };

  private pick(cx: number, cy: number, floorOnly = false) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster
      .intersectObjects(this.pickables, false)
      // pisos fantasma/escondidos não recebem toque
      .filter((h) => (this.floors[h.object.userData.floor]?.targetOpacity ?? 1) > 0.9)
      .filter((h) => !floorOnly || h.object.userData.kind === 'room');
    // dispositivo tem prioridade sobre o piso, mesmo que o piso esteja "na frente"
    const dev = hits.find((h) => h.object.userData.kind === 'device');
    const h = dev ?? hits[0];
    if (!h) return undefined;
    return { ...(h.object.userData as { kind: string; id: string; index: number }), point: h.point };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      mats.forEach((x) => x.dispose());
    });
    this.envTexture?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}

/** opacidade + modo transparente; trocar `transparent` exige recompilar o shader */
function setFade(m: THREE.Material, o: number) {
  // materiais já translúcidos (sombra de contato) guardam a opacidade-base e nunca escrevem profundidade
  const base: number | undefined = m.userData.baseOpacity;
  const transparent = base !== undefined || o < 0.995;
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.needsUpdate = true;
  }
  m.opacity = o * (base ?? 1);
  m.depthWrite = base === undefined && o > 0.5;
}


function fmtNum(st: HassEntity | undefined, unit: string) {
  const n = Number(st?.state);
  return Number.isFinite(n) ? `${n.toFixed(unit === '°' ? 1 : 0)}${unit}` : '';
}

const round2 = (n: number) => Math.round(n * 20) / 20;

/** degradê radial para o chão sumir nas bordas */
function groundFade() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, '#d8d8d8');
  grad.addColorStop(0.55, '#7a7a7a');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
