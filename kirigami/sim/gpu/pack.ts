import type { BarHingeModel } from "../model.js";

/**
 * Pack a `BarHingeModel` into flat per-element arrays for GPU textures — the CPU-side of
 * Gershenfeld's texture layout (his `dynamicSolver.initTypedArrays`). One texel per node holds
 * its position/velocity; "meta" arrays give each node the index ranges of its incident beams,
 * creases and faces so the per-node fragment shader can *gather* forces (paper §3, the 5 passes
 * collapsed into an inline gather here, which keeps every texture the same node size so it fits
 * `GPUComputationRenderer`).
 *
 * No `three` import — this is plain data and is unit-testable in Node; `gpu-solver.ts` wraps the
 * arrays into `THREE.DataTexture`s.
 */
export interface PackedModel {
  /** Node texture dims [W,H] with W*H ≥ numNodes. */
  dim: [number, number];
  numNodes: number;

  position: Float32Array; // W*H*4 — xyz = flat-net position, w = 0 (strain out)
  velocity: Float32Array; // W*H*4 — 0
  mass: Float32Array; // W*H*4 — x = mass, y = fixed(0/1), z = driven(0/1)
  goal: Float32Array; // W*H*4 — xyz = folded goal position for driven boundary nodes
  nodeMeta: Float32Array; // W*H*4 — beamStart, numBeams, creaseStart, numCreases
  nodeMeta2: Float32Array; // W*H*4 — faceStart, numFaces, 0, 0

  beamDim: [number, number];
  beamMeta: Float32Array; // per incident-beam entry — x = k, y = otherNode, z = l0, w = 2ζ√(k·m)

  creaseListDim: [number, number];
  creaseList: Float32Array; // per incident-crease entry — x = creaseIndex, y = role(1..4)

  creaseDim: [number, number];
  creaseNodes: Float32Array; // per crease — x=n1, y=n2, z=n3, w=n4
  creaseParams: Float32Array; // per crease — x = k, y = targetTheta
  creaseFace1: Float32Array; // per crease — xyz = face1 winding (a,b,c) for normal1
  creaseFace2: Float32Array; // per crease — xyz = face2 winding (a,b,c) for normal2

  faceListDim: [number, number];
  faceList: Float32Array; // per incident-face entry — x = faceIndex, y = role(0..2)

  faceDim: [number, number];
  faceNodes: Float32Array; // per face — x=a, y=b, z=c
  faceAngles: Float32Array; // per face — x,y,z = nominal interior angles at a,b,c
}

/** Square-ish texture dims that hold at least `n` texels. */
export function texDim(n: number): [number, number] {
  const w = Math.max(1, Math.ceil(Math.sqrt(n)));
  const h = Math.max(1, Math.ceil(n / w));
  return [w, h];
}

export function packModel(m: BarHingeModel, zeta: number): PackedModel {
  const N = m.numNodes;
  const [W, H] = texDim(N);
  const node4 = () => new Float32Array(W * H * 4);

  const position = node4(); // also serves as the static "rest" (flat) texture for driven nodes
  const velocity = node4();
  const mass = node4();
  const goal = node4();
  for (let i = 0; i < N; i++) {
    position[4 * i] = m.position[3 * i];
    position[4 * i + 1] = m.position[3 * i + 1];
    position[4 * i + 2] = m.position[3 * i + 2];
    mass[4 * i] = m.mass[i];
    mass[4 * i + 1] = m.fixed[i];
    mass[4 * i + 2] = m.driven[i];
    goal[4 * i] = m.goal[3 * i];
    goal[4 * i + 1] = m.goal[3 * i + 1];
    goal[4 * i + 2] = m.goal[3 * i + 2];
  }

  // --- per-node incidence lists --------------------------------------------------------
  const beamsOf: number[][] = Array.from({ length: N }, () => []); // beam ids
  for (let b = 0; b < m.beams.count; b++) {
    beamsOf[m.beams.n0[b]].push(b);
    beamsOf[m.beams.n1[b]].push(b);
  }
  // crease incidence with role 1=n1,2=n2,3=n3,4=n4
  const creasesOf: { c: number; role: number }[][] = Array.from({ length: N }, () => []);
  for (let c = 0; c < m.creases.count; c++) {
    creasesOf[m.creases.n1[c]].push({ c, role: 1 });
    creasesOf[m.creases.n2[c]].push({ c, role: 2 });
    creasesOf[m.creases.n3[c]].push({ c, role: 3 });
    creasesOf[m.creases.n4[c]].push({ c, role: 4 });
  }
  const facesOf: { f: number; role: number }[][] = Array.from({ length: N }, () => []);
  for (let f = 0; f < m.faces.count; f++) {
    facesOf[m.faces.a[f]].push({ f, role: 0 });
    facesOf[m.faces.b[f]].push({ f, role: 1 });
    facesOf[m.faces.c[f]].push({ f, role: 2 });
  }

  const numBeamEntries = beamsOf.reduce((a, l) => a + l.length, 0);
  const numCreaseEntries = creasesOf.reduce((a, l) => a + l.length, 0);
  const numFaceEntries = facesOf.reduce((a, l) => a + l.length, 0);

  const beamDim = texDim(Math.max(1, numBeamEntries));
  const creaseListDim = texDim(Math.max(1, numCreaseEntries));
  const faceListDim = texDim(Math.max(1, numFaceEntries));
  const beamMeta = new Float32Array(beamDim[0] * beamDim[1] * 4);
  const creaseList = new Float32Array(creaseListDim[0] * creaseListDim[1] * 4);
  const faceList = new Float32Array(faceListDim[0] * faceListDim[1] * 4);

  const nodeMeta = node4();
  const nodeMeta2 = node4();

  let bIdx = 0;
  let cIdx = 0;
  let fIdx = 0;
  for (let i = 0; i < N; i++) {
    nodeMeta[4 * i] = bIdx;
    nodeMeta[4 * i + 1] = beamsOf[i].length;
    for (const b of beamsOf[i]) {
      const other = m.beams.n0[b] === i ? m.beams.n1[b] : m.beams.n0[b];
      const k = m.beams.k[b];
      beamMeta[4 * bIdx] = k;
      beamMeta[4 * bIdx + 1] = other;
      beamMeta[4 * bIdx + 2] = m.beams.rest[b];
      beamMeta[4 * bIdx + 3] = 2 * zeta * Math.sqrt(k * Math.min(m.mass[i], m.mass[other]));
      bIdx++;
    }
    nodeMeta[4 * i + 2] = cIdx;
    nodeMeta[4 * i + 3] = creasesOf[i].length;
    for (const { c, role } of creasesOf[i]) {
      creaseList[4 * cIdx] = c;
      creaseList[4 * cIdx + 1] = role;
      cIdx++;
    }
    nodeMeta2[4 * i] = fIdx;
    nodeMeta2[4 * i + 1] = facesOf[i].length;
    for (const { f, role } of facesOf[i]) {
      faceList[4 * fIdx] = f;
      faceList[4 * fIdx + 1] = role;
      fIdx++;
    }
  }

  // --- per-crease / per-face data ------------------------------------------------------
  const creaseDim = texDim(Math.max(1, m.creases.count));
  const creaseNodes = new Float32Array(creaseDim[0] * creaseDim[1] * 4);
  const creaseParams = new Float32Array(creaseDim[0] * creaseDim[1] * 4);
  const creaseFace1 = new Float32Array(creaseDim[0] * creaseDim[1] * 4);
  const creaseFace2 = new Float32Array(creaseDim[0] * creaseDim[1] * 4);
  for (let c = 0; c < m.creases.count; c++) {
    creaseNodes[4 * c] = m.creases.n1[c];
    creaseNodes[4 * c + 1] = m.creases.n2[c];
    creaseNodes[4 * c + 2] = m.creases.n3[c];
    creaseNodes[4 * c + 3] = m.creases.n4[c];
    creaseParams[4 * c] = m.creases.k[c];
    creaseParams[4 * c + 1] = m.creases.targetTheta[c];
    const f1 = m.creases.face1[c];
    const f2 = m.creases.face2[c];
    creaseFace1[4 * c] = m.faces.a[f1];
    creaseFace1[4 * c + 1] = m.faces.b[f1];
    creaseFace1[4 * c + 2] = m.faces.c[f1];
    creaseFace2[4 * c] = m.faces.a[f2];
    creaseFace2[4 * c + 1] = m.faces.b[f2];
    creaseFace2[4 * c + 2] = m.faces.c[f2];
  }

  const faceDim = texDim(Math.max(1, m.faces.count));
  const faceNodes = new Float32Array(faceDim[0] * faceDim[1] * 4);
  const faceAngles = new Float32Array(faceDim[0] * faceDim[1] * 4);
  for (let f = 0; f < m.faces.count; f++) {
    faceNodes[4 * f] = m.faces.a[f];
    faceNodes[4 * f + 1] = m.faces.b[f];
    faceNodes[4 * f + 2] = m.faces.c[f];
    faceAngles[4 * f] = m.faces.nominalAngles[3 * f];
    faceAngles[4 * f + 1] = m.faces.nominalAngles[3 * f + 1];
    faceAngles[4 * f + 2] = m.faces.nominalAngles[3 * f + 2];
  }

  return {
    dim: [W, H],
    numNodes: N,
    position,
    velocity,
    mass,
    goal,
    nodeMeta,
    nodeMeta2,
    beamDim,
    beamMeta,
    creaseListDim,
    creaseList,
    creaseDim,
    creaseNodes,
    creaseParams,
    creaseFace1,
    creaseFace2,
    faceListDim,
    faceList,
    faceDim,
    faceNodes,
    faceAngles,
  };
}
