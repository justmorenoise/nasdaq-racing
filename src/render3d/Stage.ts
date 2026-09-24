import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

const SKY = 0xc9dde6;
/** Direction the sunlight comes from (normalised below): high, from the south-west. */
const SUN_DIR = new Vector3(-0.45, 1, 0.55).normalize();

/**
 * Renderer, scene, camera and lighting. A warm key light casts soft shadows
 * through a shadow frustum that follows whatever the camera is looking at
 * (`focusShadows`), so shadows stay crisp in a close chase and still cover the
 * whole circuit in the full view. Car labels render as DOM via CSS2DRenderer
 * stacked right above the canvas.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly labels = new CSS2DRenderer();
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 5, 60000);
  readonly sun = new DirectionalLight(0xfff1dc, 2.4);
  width = 1;
  height = 1;

  constructor(private host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.labels.domElement.className = "label-layer";
    host.appendChild(this.labels.domElement);

    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, 4000, 20000);

    this.scene.add(new HemisphereLight(0xdcefff, 0x5c7a3a, 1.35));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    this.resize();
  }

  resize(): void {
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.width, this.height);
    this.labels.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  setShadows(on: boolean): void {
    if (this.renderer.shadowMap.enabled === on) return;
    this.renderer.shadowMap.enabled = on;
    this.scene.traverse((o) => {
      const m = (o as { material?: { needsUpdate: boolean } }).material;
      if (m) m.needsUpdate = true;
    });
  }

  /** Centre the shadow frustum on (x, z), covering a square of half-size `radius`. */
  focusShadows(x: number, z: number, radius: number): void {
    const cam = this.sun.shadow.camera;
    const r = Math.max(200, radius);
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + SUN_DIR.x * r * 3, SUN_DIR.y * r * 3, z + SUN_DIR.z * r * 3);
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = r * 0.5;
    cam.far = r * 6;
    cam.updateProjectionMatrix();
    // Distance haze scales with the framing so the far field fades in every view.
    const fog = this.scene.fog as Fog;
    fog.near = r * 2.5;
    fog.far = r * 9;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
