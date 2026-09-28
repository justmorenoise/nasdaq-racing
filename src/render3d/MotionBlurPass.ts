import { Matrix4, Vector2, type PerspectiveCamera, type Texture } from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null as Texture | null },
    tDepth: { value: null as Texture | null },
    invViewProj: { value: new Matrix4() },
    prevViewProj: { value: new Matrix4() },
    strength: { value: 0 },
    focus: { value: new Vector2(0.5, 0.5) },
    aspect: { value: 1 },
    inner: { value: 0.12 },
    outer: { value: 0.55 },
    maxLen: { value: 0.07 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform mat4 invViewProj; uniform mat4 prevViewProj;
    uniform float strength; uniform vec2 focus; uniform float aspect;
    uniform float inner; uniform float outer; uniform float maxLen;
    varying vec2 vUv;
    const int TAPS = 10;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      // Nothing around the followed car, full strength toward the frame's edges.
      float mask = smoothstep(inner, outer, length((vUv - focus) * vec2(aspect, 1.0)));
      if (strength * mask < 0.002) { gl_FragColor = base; return; }
      // Where was this pixel's (static) world point last frame? That screen
      // offset is the camera's motion across it.
      float d = texture2D(tDepth, vUv).x;
      vec4 world = invViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      world /= world.w;
      vec4 prev = prevViewProj * world;
      vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
      vec2 vel = (vUv - prevUv) * strength * mask;
      float len = length(vel);
      if (len > maxLen) vel *= maxLen / len;
      vec4 acc = vec4(0.0);
      for (int i = 0; i < TAPS; i++) {
        float t = float(i) / float(TAPS - 1) - 0.5;
        acc += texture2D(tDiffuse, vUv - vel * t);
      }
      gl_FragColor = acc / float(TAPS);
    }`,
};

/**
 * Camera motion blur for the chase view: each pixel is smeared along the
 * screen path its world point took since the previous frame (reprojected from
 * the scene depth), faded out around the followed car so it stays sharp while
 * the scenery streams past at the edges.
 */
export class MotionBlurPass extends ShaderPass {
  private prev = new Matrix4();
  private cur = new Matrix4();
  private hasPrev = false;

  constructor(depth: Texture) {
    super(MotionBlurShader);
    this.uniforms.tDepth.value = depth;
    this.enabled = false;
  }

  /**
   * Per frame, after the camera moved: `strength` 0 turns it off; `focus` is
   * the car's position in 0..1 screen coordinates; `dt` normalises the smear
   * to a fixed shutter so it doesn't grow at low frame rates.
   */
  setup(camera: PerspectiveCamera, strength: number, focus: Vector2, aspect: number, dt: number): void {
    this.cur.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const on = strength > 0.01 && this.hasPrev && dt > 0;
    this.enabled = on;
    if (on) {
      this.uniforms.invViewProj.value.copy(this.cur).invert();
      this.uniforms.prevViewProj.value.copy(this.prev);
      this.uniforms.strength.value = strength * Math.min(1.5, 1 / 60 / dt);
      this.uniforms.focus.value.copy(focus);
      this.uniforms.aspect.value = aspect;
    }
    this.prev.copy(this.cur);
    this.hasPrev = true;
  }

  /** Forget the last camera (after a cut, so the jump isn't smeared). */
  reset(): void {
    this.hasPrev = false;
  }
}
