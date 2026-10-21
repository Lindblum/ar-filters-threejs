import * as THREE from 'three';

// Small copies of the camera image, for the depth model and for colouring
// the depth grid. The XR camera texture only exists during its frame, so it
// is drawn into a render target then and read back asynchronously (a pixel
// buffer and a fence, via three), which doesn't stall the frame.

export class CameraCapture {
  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, type: THREE.UnsignedByteType });
    // a full-target quad; flipped so the read-back rows run top to bottom
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: null } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = vec2(uv.x, 1.0 - uv.y);
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      // the raw bytes (sRGB), with no colour conversion
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /**
   * Draws the camera texture into the target at `size` ({ width, height })
   * now (during the XR frame) and resolves with { rgba, width, height } once
   * the GPU has it.
   */
  captureTexture(gl, texture, { width, height }) {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.material.uniforms.map.value = texture;
    const previous = gl.getRenderTarget();
    const xrEnabled = gl.xr.enabled;
    gl.xr.enabled = false; // a plain pass: keep three from substituting the XR camera
    gl.setRenderTarget(this.target);
    gl.render(this.scene, this.camera);
    gl.setRenderTarget(previous);
    gl.xr.enabled = xrEnabled;
    this.material.uniforms.map.value = null;
    const rgba = new Uint8Array(width * height * 4);
    return gl.readRenderTargetPixelsAsync(this.target, 0, 0, width, height, rgba).then(() => ({ rgba, width, height }));
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
