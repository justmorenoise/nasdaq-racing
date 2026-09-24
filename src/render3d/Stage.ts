import {
  AgXToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HalfFloatType,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

const SKY = 0xcfdde3;
/** Where the sunlight comes from: a warm late-afternoon sun, low for long shadows. */
const SUN_DIR = new Vector3(-0.62, 0.66, 0.42).normalize();

/** Final grade: pull saturation down and warm the mids, like the reference renders. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, saturation: { value: 0.84 }, warmth: { value: 0.035 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float saturation; uniform float warmth; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 g = mix(vec3(l), c.rgb, saturation);
      g += vec3(warmth, warmth * 0.4, -warmth) * (1.0 - abs(l - 0.5) * 2.0);
      gl_FragColor = vec4(g, c.a);
    }`,
};

/**
 * Renderer, scene, camera, lighting and post-processing. A warm low sun casts
 * soft shadows through a frustum that follows the camera focus; a sky/ground
 * hemisphere fills; ground-truth ambient occlusion (GTAO) grounds every object
 * like the reference dioramas, then AgX tone mapping and a gentle desaturating
 * grade. AO is dropped on small/mobile views. Car labels are CSS2D DOM.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly labels = new CSS2DRenderer();
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 5, 60000);
  readonly sun = new DirectionalLight(0xffe4c4, 3.1);
  private composer: EffectComposer;
  private ao: GTAOPass;
  private aoOn = true;
  width = 1;
  height = 1;

  constructor(private host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = AgXToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.labels.domElement.className = "label-layer";
    host.appendChild(this.labels.domElement);

    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, 4000, 20000);

    this.scene.add(new HemisphereLight(0xd9e8f2, 0x8d7c5c, 1.25));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.8;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);

    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const target = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
    this.ao.blendIntensity = 0.85;
    this.ao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.4, thickness: 3, scale: 1.2, samples: 12 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(GradeShader));

    this.resize();
  }

  resize(): void {
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.width, this.height);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.width, this.height);
    this.labels.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    // AO is the costly pass: only on roomy views.
    this.aoOn = this.width * this.height > 500 * 400 && this.width >= 640;
    this.ao.enabled = this.aoOn;
  }

  setShadows(on: boolean): void {
    if (this.renderer.shadowMap.enabled === on) return;
    this.renderer.shadowMap.enabled = on;
    this.scene.traverse((o) => {
      const m = (o as { material?: { needsUpdate: boolean } }).material;
      if (m) m.needsUpdate = true;
    });
  }

  /** Centre the shadow frustum on (x, h, z), covering a square of half-size `radius`. */
  focusShadows(x: number, h: number, z: number, radius: number): void {
    const cam = this.sun.shadow.camera;
    const r = Math.max(220, radius);
    this.sun.target.position.set(x, h, z);
    this.sun.position.set(x + SUN_DIR.x * r * 3, h + SUN_DIR.y * r * 3, z + SUN_DIR.z * r * 3);
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = r * 0.5;
    cam.far = r * 7;
    cam.updateProjectionMatrix();
    const fog = this.scene.fog as Fog;
    fog.near = Math.max(1500, r * 4);
    fog.far = Math.max(6000, r * 14);
    // AO sampling radius follows the framing (world units).
    this.ao.updateGtaoMaterial({ radius: Math.max(4, r * 0.02) });
  }

  render(): void {
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
