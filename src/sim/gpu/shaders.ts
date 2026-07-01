/**
 * GLSL for the GPU bar-and-hinge solver. This is a per-texel transcription of `forces.ts`:
 * one fragment-shader thread per node gathers axial + crease + face + damping forces from its
 * incident elements (Gershenfeld §2–3). Normals and fold angles are recomputed inline per
 * crease (rather than in separate passes) so every texture stays node-sized and fits
 * `GPUComputationRenderer`'s ping-pong float-texture model — the same GPGPU mechanism the paper
 * uses, just packaged by three.js.
 *
 * `texturePosition` / `textureVelocity` are the auto-bound GPUComputationRenderer variables;
 * `resolution` is their (node) dimension. Everything else is a static DataTexture uniform from
 * `pack.ts`.
 */

/** Shared header: data-texture uniforms, index helpers, and the force-gather function. */
const COMMON = /* glsl */ `
  #define MAXDEG 64

  uniform sampler2D uMass;       // x=mass, y=fixed, z=driven
  uniform sampler2D uRest;       // flat rest position (static) — for driven boundary nodes
  uniform sampler2D uGoal;       // folded goal position (static) — for driven boundary nodes
  uniform sampler2D uNodeMeta;   // beamStart, numBeams, creaseStart, numCreases
  uniform sampler2D uNodeMeta2;  // faceStart, numFaces
  uniform sampler2D uBeamMeta;   uniform vec2 uBeamDim;        // k, other, l0, c(damp)
  uniform sampler2D uCreaseList; uniform vec2 uCreaseListDim;  // creaseIndex, role(1..4)
  uniform sampler2D uCreaseNodes;uniform vec2 uCreaseDim;      // n1,n2,n3,n4
  uniform sampler2D uCreaseParams;                              // k, targetTheta
  uniform sampler2D uCreaseFace1;                               // a,b,c (winding) of face1
  uniform sampler2D uCreaseFace2;                               // a,b,c (winding) of face2
  uniform sampler2D uFaceList;   uniform vec2 uFaceListDim;     // faceIndex, role(0..2)
  uniform sampler2D uFaceNodes;  uniform vec2 uFaceDim;         // a,b,c
  uniform sampler2D uFaceAngles;                                // nominal angles
  uniform float uDt;
  uniform float uFoldPercent;
  uniform float uKFace;
  uniform float uReset;          // >0.5 ⇒ global quench pass: zero all velocity, hold position

  vec4 fetch(sampler2D t, float i, vec2 dim){
    float c = mod(i, dim.x);
    float r = floor(i / dim.x);
    return texture2D(t, vec2((c + 0.5) / dim.x, (r + 0.5) / dim.y));
  }
  vec3 nodePos(float i){ return fetch(texturePosition, i, resolution).xyz; }
  vec3 nodeVel(float i){ return fetch(textureVelocity, i, resolution).xyz; }

  vec3 faceNormalOf(sampler2D faceTex, float c){
    vec3 abc = fetch(faceTex, c, uCreaseDim).xyz;
    vec3 a = nodePos(abc.x); vec3 b = nodePos(abc.y); vec3 cc = nodePos(abc.z);
    return normalize(cross(b - a, cc - a));
  }

  // Total force on node 'self' (paper Eqs 1–6, §2.4 + viscous damping).
  vec3 computeForce(float self){
    vec3 p = nodePos(self);
    vec3 v = nodeVel(self);
    vec3 force = vec3(0.0);

    // --- axial + damping over incident beams ---
    vec4 meta = fetch(uNodeMeta, self, resolution);
    for (int j = 0; j < MAXDEG; j++){
      if (float(j) >= meta.y) break;
      vec4 bm = fetch(uBeamMeta, meta.x + float(j), uBeamDim); // k, other, l0, c
      vec3 pj = nodePos(bm.y);
      vec3 d = pj - p;
      float l = max(length(d), 1e-9);
      force += (bm.x * (l - bm.z) / l) * d;          // k(l-l0) along edge
      force += bm.w * (nodeVel(bm.y) - v);           // c(v_other - v)
    }

    // --- crease torsion over incident creases ---
    vec4 meta2 = fetch(uNodeMeta, self, resolution);
    for (int j = 0; j < MAXDEG; j++){
      if (float(j) >= meta2.w) break;
      vec4 cl = fetch(uCreaseList, meta2.z + float(j), uCreaseListDim); // creaseIndex, role
      float c = cl.x; float role = cl.y;
      vec4 nodes = fetch(uCreaseNodes, c, uCreaseDim);   // n1,n2,n3,n4
      vec2 prm = fetch(uCreaseParams, c, uCreaseDim).xy; // k, target
      vec3 normal1 = faceNormalOf(uCreaseFace1, c);
      vec3 normal2 = faceNormalOf(uCreaseFace2, c);
      vec3 p3 = nodePos(nodes.z); vec3 p4 = nodePos(nodes.w);
      vec3 e = p4 - p3; float el = max(length(e), 1e-9); vec3 eh = e / el;
      // fold angle θ (signed). No cross-step unwrap on GPU: valid for |θ| < π (our targets are).
      float x = clamp(dot(normal1, normal2), -1.0, 1.0);
      float y = dot(cross(normal1, eh), normal2);
      float theta = atan(y, x);
      // moment arms + projection coefficients
      vec3 p1 = nodePos(nodes.x); vec3 p2 = nodePos(nodes.y);
      vec3 r1 = p1 - p3; float proj1 = dot(r1, eh);
      float h1 = max(sqrt(max(dot(r1, r1) - proj1 * proj1, 0.0)), 1e-6); float coef1 = proj1 / el;
      vec3 r2 = p2 - p3; float proj2 = dot(r2, eh);
      float h2 = max(sqrt(max(dot(r2, r2) - proj2 * proj2, 0.0)), 1e-6); float coef2 = proj2 / el;
      float angForce = prm.x * (prm.y * uFoldPercent - theta);
      if (role < 1.5)       force += (angForce / h1) * normal1;                       // n1 wing
      else if (role < 2.5)  force += (angForce / h2) * normal2;                       // n2 wing
      else if (role < 3.5)  force += -angForce * ((1.0 - coef1) / h1 * normal1 + (1.0 - coef2) / h2 * normal2); // n3
      else                  force += -angForce * (coef1 / h1 * normal1 + coef2 / h2 * normal2);                 // n4
    }

    // --- face interior-angle springs ---
    vec4 fmeta = fetch(uNodeMeta2, self, resolution);
    for (int j = 0; j < MAXDEG; j++){
      if (float(j) >= fmeta.y) break;
      vec4 fl = fetch(uFaceList, fmeta.x + float(j), uFaceListDim); // faceIndex, role
      float f = fl.x; float role = fl.y;
      vec3 abc = fetch(uFaceNodes, f, uFaceDim).xyz;
      vec3 nom = fetch(uFaceAngles, f, uFaceDim).xyz;
      vec3 A = nodePos(abc.x); vec3 B = nodePos(abc.y); vec3 C = nodePos(abc.z);
      vec3 ab = B - A; vec3 ac = C - A; vec3 bc = C - B;
      float lAB = max(length(ab), 1e-9), lAC = max(length(ac), 1e-9), lBC = max(length(bc), 1e-9);
      float angA = acos(clamp(dot(ab / lAB, ac / lAC), -1.0, 1.0));
      float angB = acos(clamp(dot(-ab / lAB, bc / lBC), -1.0, 1.0));
      float angC = acos(clamp(dot(ac / lAC, bc / lBC), -1.0, 1.0));
      float d0 = uKFace * (nom.x - angA);
      float d1 = uKFace * (nom.y - angB);
      float d2 = uKFace * (nom.z - angC);
      vec3 n = normalize(cross(ab, ac));
      vec3 ncAB = cross(n, ab) / (lAB * lAB);
      vec3 ncAC = cross(n, ac) / (lAC * lAC);
      vec3 ncBC = cross(n, bc) / (lBC * lBC);
      if (role < 0.5)      force += (-d0 + d2) * ncAC + (d0 - d1) * ncAB; // a
      else if (role < 1.5) force += (-d0 + d1) * ncAB + (d1 - d2) * ncBC; // b
      else                 force += (d0 - d2) * ncAC + (-d1 + d2) * ncBC; // c
    }

    return force;
  }

  float selfIndex(){
    return floor(gl_FragCoord.y) * resolution.x + floor(gl_FragCoord.x);
  }
`;

/** Velocity update: v += (F/m)·dt (paper §2.5). Fixed nodes stay at zero velocity. */
export const VELOCITY_SHADER = /* glsl */ `
  ${COMMON}
  void main(){
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    // Global quench pass (Otter quenched dynamics, triggered from the CPU when total kinetic energy
    // stops rising): zero every velocity. This descends a frustrated kirigami mesh to a TRUE static
    // rest — plain viscous ζ only asymptotes to a limit cycle that never stops (the GPU jitter).
    if (uReset > 0.5) { gl_FragColor = vec4(0.0); return; }
    float self = selfIndex();
    vec4 m = fetch(uMass, self, resolution);
    vec3 v = texture2D(textureVelocity, uv).xyz;
    if (m.y > 0.5) { gl_FragColor = vec4(0.0); return; } // fixed
    vec3 f = computeForce(self);
    v += (f / m.x) * uDt;
    gl_FragColor = vec4(v, 0.0);
  }
`;

/**
 * Position update: p += v_new·dt with v_new = v + (F/m)·dt recomputed inline, giving symplectic
 * (semi-implicit) Euler — matching `forces.ts` without relying on GPUComputationRenderer pass
 * ordering. Fixed nodes hold position.
 */
export const POSITION_SHADER = /* glsl */ `
  ${COMMON}
  void main(){
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    float self = selfIndex();
    vec4 m = fetch(uMass, self, resolution);
    vec3 p = texture2D(texturePosition, uv).xyz;
    if (uReset > 0.5) { gl_FragColor = vec4(p, 0.0); return; } // global quench: hold position
    if (m.z > 0.5) { // driven boundary node — kinematically moved rest→goal by foldPercent
      vec3 rest = texture2D(uRest, uv).xyz;
      vec3 goal = texture2D(uGoal, uv).xyz;
      gl_FragColor = vec4(mix(rest, goal, uFoldPercent), 0.0);
      return;
    }
    if (m.y > 0.5) { gl_FragColor = vec4(p, 0.0); return; } // fixed
    vec3 v = texture2D(textureVelocity, uv).xyz;
    vec3 f = computeForce(self);
    vec3 vNew = v + (f / m.x) * uDt;
    p += vNew * uDt;
    gl_FragColor = vec4(p, 0.0);
  }
`;
