import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { readStlTriangles } from "../model/stl-ascii.js";
import type { TilePreviewView } from "./tile-preview.js";

/** The sim's printed-tile grey (`sim-canvas.ts` COLOR_TILE), so the preview reads as the same plastic. */
const COLOR_TILE = 0xdfe3e8;
const COLOR_BACKGROUND = 0xf4f4f6;
/** Seen from above and to the side, z up, the way the sim first shows a model. */
const VIEW_DIRECTION = new THREE.Vector3(1, -1, 1.1).normalize();

/**
 * The Export dialog's 3D picture of the STL tiles: the triangles of the file that downloads, lit and flat-shaded,
 * framed to fit, and turned by dragging. It draws only when something changed (no animation loop), so an idle
 * dialog costs nothing, and {@link dispose} gives the WebGL context back. Loaded on demand by `main.ts`, so
 * three.js stays out of the dialog's own code.
 */
export class StlPreview implements TilePreviewView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly controls: OrbitControls;
  private readonly material = new THREE.MeshStandardMaterial({ color: COLOR_TILE, flatShading: true, roughness: 0.75 });
  private readonly resizer: ResizeObserver | null;
  private mesh: THREE.Mesh | null = null;
  /** The tiles' bounding radius when last framed, to tell a rescale (reframe) from a thickness edit (keep the view). */
  private radius = 1;
  /** Half the width and height the tiles take up on screen when framed, in model units, before the aspect is applied. */
  private readonly halfExtent = new THREE.Vector2(1, 1);

  constructor(private readonly mount: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(COLOR_BACKGROUND, 1);
    mount.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    // Lights ride with the camera, so whichever way the tiles are turned their top and sides stay told apart.
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(0.4, 0.8, 1);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1, -0.3, 0.4);
    this.camera.add(key, fill);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.addEventListener("change", this.render);

    this.resize();
    this.resizer = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.resize()) : null;
    this.resizer?.observe(mount);
  }

  show(stlText: string): void {
    const positions = readStlTriangles(stlText);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const firstShow = !this.mesh;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
    } else {
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.scene.add(this.mesh);
    }
    // Reframe on the first drawing only: an edit to the thickness keeps the turn and zoom the user chose, so the
    // change is what moves on screen. The size box rescales the tiles, so it reframes too.
    const sphere = geometry.boundingSphere;
    const radius = sphere && sphere.radius > 0 ? sphere.radius : 1;
    if (firstShow || Math.abs(radius - this.radius) > 0.05 * this.radius) this.frame(geometry, radius);
    this.render();
  }

  dispose(): void {
    this.resizer?.disconnect();
    this.controls.removeEventListener("change", this.render);
    this.controls.dispose();
    this.mesh?.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  /**
   * Point the camera at the tiles from {@link VIEW_DIRECTION} and fit the view to their box as seen from there.
   * A bounding sphere would leave a flat sheet small in the frame, since the sheet is far thinner than it is wide.
   */
  private frame(geometry: THREE.BufferGeometry, radius: number): void {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const center = box.getCenter(new THREE.Vector3());
    this.radius = radius;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(VIEW_DIRECTION, radius * 4);
    this.camera.near = radius * 0.5;
    this.camera.far = radius * 8;
    this.camera.zoom = 1;
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld();
    const toView = this.camera.matrixWorldInverse;
    const middle = center.clone().applyMatrix4(toView);
    let w = 0, h = 0;
    for (let i = 0; i < 8; i++) {
      const corner = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z,
      ).applyMatrix4(toView);
      w = Math.max(w, Math.abs(corner.x - middle.x));
      h = Math.max(h, Math.abs(corner.y - middle.y));
    }
    this.halfExtent.set(w || radius, h || radius);
    this.applyAspect();
    this.controls.update(); // syncs the controls with the new target; it renders through the "change" listener
  }

  private resize(): void {
    const w = this.mount.clientWidth || 320;
    const h = this.mount.clientHeight || 200;
    this.renderer.setSize(w, h);
    this.applyAspect();
    this.render();
  }

  private applyAspect(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    const aspect = size.y > 0 ? size.x / size.y : 1;
    const hh = Math.max(this.halfExtent.y, this.halfExtent.x / aspect) * 1.1; // a margin round the tiles
    const hw = hh * aspect;
    this.camera.left = -hw;
    this.camera.right = hw;
    this.camera.top = hh;
    this.camera.bottom = -hh;
    this.camera.updateProjectionMatrix();
  }

  private readonly render = (): void => {
    this.renderer.render(this.scene, this.camera);
  };
}
