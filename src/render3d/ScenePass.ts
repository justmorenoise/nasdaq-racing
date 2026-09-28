import {
  DepthTexture,
  HalfFloatType,
  ShaderMaterial,
  UniformsUtils,
  UnsignedIntType,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";

/**
 * The scene, rendered multisampled into its own target with a depth texture,
 * then copied into the composer chain. The later passes (AO, motion blur) read
 * that depth, and the composer's own ping-pong targets can stay single-sampled
 * and depthless — cheaper for every full-screen pass after this one.
 */
export class ScenePass extends Pass {
  readonly target: WebGLRenderTarget;
  private quad: FullScreenQuad;

  constructor(
    private scene: Scene,
    private camera: Camera,
    width: number,
    height: number,
  ) {
    super();
    this.target = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      samples: 4,
      depthTexture: new DepthTexture(width, height, UnsignedIntType),
    });
    const mat = new ShaderMaterial({
      uniforms: UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    mat.uniforms.tDiffuse.value = this.target.texture;
    this.quad = new FullScreenQuad(mat);
  }

  get depth(): DepthTexture {
    return this.target.depthTexture as DepthTexture;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.target.dispose();
    this.quad.dispose();
  }
}
