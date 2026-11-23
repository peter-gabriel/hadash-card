import * as THREE from 'three';
import type { Vec2 } from './types';

/**
 * Efeitos visuais baratos para tablet: tudo aqui é geometria/textura gerada uma vez,
 * sem pós-processamento (que pesaria em GPU fraca).
 */

export type FloorKind = 'wood' | 'tile';

/** cômodos molhados/externos ganham cerâmica; o resto, madeira */
export function floorKind(name: string): FloorKind {
  const n = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /banh|wc|lavabo|cozinh|kitchen|bath|servic|lavand|laundry|sacada|varanda|terra|balcon|hall|circula|garag/.test(n)
    ? 'tile'
    : 'wood';
}

/** metros cobertos por uma repetição da textura */
export const FLOOR_TEX_METERS: Record<FloorKind, number> = { wood: 1.2, tile: 0.6 };

const texCache = new Map<string, THREE.Texture>();

/** textura quase branca (multiplica a cor do cômodo): tábuas de madeira ou cerâmica com rejunte */
export function floorTexture(kind: FloorKind, maxAniso = 4): THREE.Texture {
  const key = `floor-${kind}`;
  const cached = texCache.get(key);
  if (cached) return cached;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (kind === 'wood') {
    // 8 fileiras de tábuas de 15 cm, emendas desencontradas
    const rows = 8;
    const rh = S / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * S * 0.6;
      while (x < S) {
        const w = S * (0.45 + rnd() * 0.5);
        const v = 232 + Math.round((rnd() - 0.5) * 22);
        g.fillStyle = `rgb(${v},${v - 6},${v - 14})`;
        g.fillRect(x, r * rh, w, rh);
        // veios suaves
        g.strokeStyle = `rgba(120,90,60,${0.05 + rnd() * 0.05})`;
        g.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          const y = r * rh + rh * (0.15 + rnd() * 0.7);
          g.beginPath();
          g.moveTo(x, y);
          g.bezierCurveTo(x + w * 0.3, y + (rnd() - 0.5) * 6, x + w * 0.6, y + (rnd() - 0.5) * 6, x + w, y);
          g.stroke();
        }
        g.fillStyle = 'rgba(90,70,50,0.35)';
        g.fillRect(x, r * rh, 2, rh); // emenda
        x += w;
      }
      g.fillStyle = 'rgba(90,70,50,0.28)';
      g.fillRect(0, r * rh, S, 2); // junta entre fileiras
    }
  } else {
    g.fillStyle = '#f3f1ed';
    g.fillRect(0, 0, S, S);
    // leve variação da peça
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(0,0,0,${rnd() * 0.025})`;
      g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 6, 2 + rnd() * 6);
    }
    // rejunte nas bordas (a textura cobre exatamente uma peça)
    g.fillStyle = 'rgba(110,105,98,0.45)';
    g.fillRect(0, 0, S, 4);
    g.fillRect(0, 0, 4, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  const m = 1 / FLOOR_TEX_METERS[kind];
  t.repeat.set(m, m);
  texCache.set(key, t);
  return t;
}

/** degradê para a sombra de contato junto às paredes (canal verde = opacidade) */
export function aoTexture(): THREE.Texture {
  const cached = texCache.get('ao');
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 2;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 128, 0);
  // forte colado na parede, some rápido
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.25, '#7a7a7a');
  grad.addColorStop(0.6, '#1e1e1e');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 2);
  const t = new THREE.CanvasTexture(c);
  texCache.set('ao', t);
  return t;
}

/**
 * faixa de sombra de contato no piso ao longo de um trecho de parede
 * (a -> b no plano, `n` = normal para dentro do cômodo, começa depois da espessura da parede)
 */
export function aoBand(a: Vec2, b: Vec2, n: Vec2, offset: number, width: number, y: number): THREE.BufferGeometry {
  const p = (q: Vec2, k: number): [number, number, number] => [q[0] + n[0] * k, y, q[1] + n[1] * k];
  const [p0, p1, p2, p3] = [p(a, offset), p(b, offset), p(b, offset + width), p(a, offset + width)];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...p0, ...p1, ...p2, ...p0, ...p2, ...p3], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0.5, 0, 0.5, 1, 0.5, 0, 0.5, 1, 0.5, 1, 0.5], 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(18).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return geo;
}

/** caixa de parede com topo escuro (efeito "maquete cortada") via cor por vértice */
export function wallBox(len: number, h: number, t: number, side: THREE.Color, cap: THREE.Color): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(len, h, t);
  const nrm = geo.attributes.normal;
  const col = new Float32Array(nrm.count * 3);
  for (let i = 0; i < nrm.count; i++) {
    const c = nrm.getY(i) > 0.5 ? cap : side;
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export const MAX_ROOM_LIGHTS = 8;

/**
 * luz das lâmpadas recortada no formato do cômodo: soma das lâmpadas acesas,
 * com queda suave — nunca atravessa parede (é desenhada só sobre o piso do cômodo)
 */
export function roomLightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uL: { value: Array.from({ length: MAX_ROOM_LIGHTS }, () => new THREE.Vector4()) },
      uC: { value: Array.from({ length: MAX_ROOM_LIGHTS }, () => new THREE.Color()) },
      uN: { value: 0 },
      uGain: { value: 1 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vXZ = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec4 uL[${MAX_ROOM_LIGHTS}];
      uniform vec3 uC[${MAX_ROOM_LIGHTS}];
      uniform int uN;
      uniform float uGain;
      uniform float uOpacity;
      varying vec2 vXZ;
      void main() {
        vec3 acc = vec3(0.0);
        for (int i = 0; i < ${MAX_ROOM_LIGHTS}; i++) {
          if (i >= uN) break;
          float d = distance(vXZ, uL[i].xy);
          float f = clamp(1.0 - d / uL[i].z, 0.0, 1.0);
          // núcleo + halo: parece mais com luz real do que um disco
          // núcleo forte perto da lâmpada + halo que some suave até a borda do alcance
          acc += uC[i] * uL[i].w * (0.35 * f * f + 0.65 * f * f * f * f);
        }
        gl_FragColor = vec4(acc * uGain * uOpacity, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}
