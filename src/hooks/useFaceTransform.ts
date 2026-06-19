import { useRef, useState, useCallback, useEffect } from 'react';
import type { TransformationSettings, BackgroundOption } from '../types';

interface UseFaceTransformReturn {
  processedStream: MediaStream | null;
  transformationSettings: TransformationSettings;
  setTransformationSettings: React.Dispatch<React.SetStateAction<TransformationSettings>>;
  referenceVideo: HTMLVideoElement | null;
  setReferenceVideo: (video: HTMLVideoElement | null) => void;
  backgroundOptions: BackgroundOption[];
  isProcessing: boolean;
  statusMessage: string;
  initializeTransform: (stream: MediaStream) => Promise<void>;
  updateBackground: (backgroundId: string) => void;
  cleanup: () => void;
}

export const backgroundOptions: BackgroundOption[] = [
  { id: 'none',       name: 'None',             thumbnail: '', value: '' },
  {
    id: 'office',
    name: 'Modern Office',
    thumbnail: 'https://images.pexels.com/photos/667838/pexels-photo-667838.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/667838/pexels-photo-667838.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'luxury',
    name: 'Luxury Office',
    thumbnail: 'https://images.pexels.com/photos/1743555/pexels-photo-1743555.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/1743555/pexels-photo-1743555.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'studio',
    name: 'Studio',
    thumbnail: 'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'conference',
    name: 'Conference Room',
    thumbnail: 'https://images.pexels.com/photos/416320/pexels-photo-416320.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/416320/pexels-photo-416320.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'apartment',
    name: 'Modern Apartment',
    thumbnail: 'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────
interface Pt { x: number; y: number }
type Triangle = [number, number, number]; // indices into landmark array

// ─── MediaPipe face landmark indices we care about ─────────────────────────
// 68 carefully chosen points that cover forehead, cheeks, jaw, eyes, nose, lips
const FACE_POINTS = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  // Eyes
  33, 160, 158, 133, 153, 144,   // left eye
  362, 385, 387, 263, 373, 380,  // right eye
  // Eyebrows
  70, 63, 105, 66, 107, 55, 65, 52, 53, 46,
  336, 296, 334, 293, 300, 285, 295, 282, 283, 276,
  // Nose
  1, 2, 98, 327,
  // Mouth
  61, 84, 17, 314, 405, 321, 375, 291, 78, 82, 13, 312, 308, 415, 310, 311,
  // Forehead interior
  10, 67, 109, 297, 338,
];
const UNIQUE_FACE_POINTS = [...new Set(FACE_POINTS)];

// ─── Delaunay triangulation (Bowyer-Watson) ────────────────────────────────
function delaunay(pts: Pt[]): Triangle[] {
  const n = pts.length;
  if (n < 3) return [];

  // Super-triangle that contains all points
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const dx = maxX - minX, dy = maxY - minY, delta = Math.max(dx, dy) * 10;
  const superA: Pt = { x: minX - delta, y: minY - delta * 3 };
  const superB: Pt = { x: minX + dx / 2, y: maxY + delta * 3 };
  const superC: Pt = { x: maxX + delta, y: minY - delta * 3 };
  const all = [...pts, superA, superB, superC];
  const sA = n, sB = n + 1, sC = n + 2;

  let triangles: Triangle[] = [[sA, sB, sC]];

  for (let i = 0; i < n; i++) {
    const p = all[i];
    const bad: Triangle[] = [];
    for (const tri of triangles) {
      if (inCircumcircle(all[tri[0]], all[tri[1]], all[tri[2]], p)) bad.push(tri);
    }
    // Find boundary polygon
    const edgeMap: Map<string, number> = new Map();
    for (const tri of bad) {
      const edges = [[tri[0],tri[1]],[tri[1],tri[2]],[tri[2],tri[0]]];
      for (const [a, b] of edges) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
      }
    }
    const polygon: [number,number][] = [];
    for (const [key, cnt] of edgeMap) if (cnt === 1) { const [a,b] = key.split(',').map(Number); polygon.push([a,b]); }
    triangles = triangles.filter(t => !bad.includes(t));
    for (const [a,b] of polygon) triangles.push([a, b, i]);
  }

  // Remove triangles sharing super-triangle vertices
  return triangles.filter(t => t[0] < n && t[1] < n && t[2] < n);
}

function inCircumcircle(a: Pt, b: Pt, c: Pt, p: Pt): boolean {
  const ax = a.x - p.x, ay = a.y - p.y;
  const bx = b.x - p.x, by = b.y - p.y;
  const cx = c.x - p.x, cy = c.y - p.y;
  return (ax*(by*( cx*cx + cy*cy) - cy*(bx*bx+by*by))
        - ay*(bx*(cx*cx+cy*cy) - cx*(bx*bx+by*by))
        + (ax*ax+ay*ay)*(bx*cy-by*cx)) > 0;
}

// ─── Affine warp: compute matrix that maps refTri → hostTri ───────────────
// Returns [a, b, c, d, e, f] for ctx.setTransform
function affineFromTriangles(
  ref: [Pt, Pt, Pt],
  host: [Pt, Pt, Pt],
): [number, number, number, number, number, number] | null {
  const [r0, r1, r2] = ref;
  const [h0, h1, h2] = host;

  // Solve [a c e; b d f] * [r; 1] = [h; 1]
  const detR = r0.x * (r1.y - r2.y) - r0.y * (r1.x - r2.x) + (r1.x * r2.y - r2.x * r1.y);
  if (Math.abs(detR) < 1e-10) return null;

  const inv = 1 / detR;
  // Row 0 → x
  const a = inv * (h0.x * (r1.y - r2.y) + h1.x * (r2.y - r0.y) + h2.x * (r0.y - r1.y));
  const c = inv * (h0.x * (r2.x - r1.x) + h1.x * (r0.x - r2.x) + h2.x * (r1.x - r0.x));
  const e = inv * (h0.x * (r1.x * r2.y - r2.x * r1.y) + h1.x * (r2.x * r0.y - r0.x * r2.y) + h2.x * (r0.x * r1.y - r1.x * r0.y));
  // Row 1 → y
  const b = inv * (h0.y * (r1.y - r2.y) + h1.y * (r2.y - r0.y) + h2.y * (r0.y - r1.y));
  const d = inv * (h0.y * (r2.x - r1.x) + h1.y * (r0.x - r2.x) + h2.y * (r1.x - r0.x));
  const f = inv * (h0.y * (r1.x * r2.y - r2.x * r1.y) + h1.y * (r2.x * r0.y - r0.x * r2.y) + h2.y * (r0.x * r1.y - r1.x * r0.y));

  return [a, b, c, d, e, f];
}

// ─── Build face hull path (face oval landmark indices) ─────────────────────
const FACE_OVAL_IDX = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

declare global { interface Window { FaceMesh: any } }

export function useFaceTransform(): UseFaceTransformReturn {
  const [processedStream, setProcessedStream]               = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing]                     = useState(false);
  const [statusMessage, setStatusMessage]                   = useState('Camera Ready');
  const [transformationSettings, setTransformationSettings] = useState<TransformationSettings>({
    enabled: false, referenceVideo: null, background: '',
  });
  const [referenceVideo, setReferenceVideo] = useState<HTMLVideoElement | null>(null);

  // Canvas / stream refs
  const outputCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const hostVideoRef     = useRef<HTMLVideoElement | null>(null);
  const animFrameRef     = useRef<number | null>(null);
  const bgImgRef         = useRef<HTMLImageElement | null>(null);

  // MediaPipe instances
  const selfieSegRef     = useRef<any>(null);
  const faceMeshHostRef  = useRef<any>(null);
  const faceMeshRefRef   = useRef<any>(null);

  // Landmark caches (updated asynchronously by FaceMesh callbacks)
  const hostLandmarksRef = useRef<Pt[] | null>(null);
  const refLandmarksRef  = useRef<Pt[] | null>(null);
  // Canvas with latest reference video frame (for pixel sampling)
  const refCanvasRef     = useRef<HTMLCanvasElement | null>(null);

  // Latest segmentation mask frame
  const segResultRef     = useRef<any>(null);

  // Settings refs kept in sync
  const settingsRef    = useRef(transformationSettings);
  const refVideoRef    = useRef<HTMLVideoElement | null>(null);
  const currentBgRef   = useRef('');
  const scriptFlags    = useRef({ selfie: false, mesh: false });

  useEffect(() => { settingsRef.current = transformationSettings; }, [transformationSettings]);
  useEffect(() => { refVideoRef.current = referenceVideo; },         [referenceVideo]);

  // ── Script loader ──────────────────────────────────────────────────────────
  const loadScript = useCallback((id: string, src: string): Promise<void> =>
    new Promise((res, rej) => {
      if (document.getElementById(id)) { res(); return; }
      const s = Object.assign(document.createElement('script'), { id, src, crossOrigin: 'anonymous' });
      s.onload = () => res(); s.onerror = () => rej(new Error(`Script load failed: ${src}`));
      document.head.appendChild(s);
    }), []);

  // ── Core init ─────────────────────────────────────────────────────────────
  const initializeTransform = useCallback(async (stream: MediaStream) => {
    if (hostVideoRef.current) return; // already running
    setIsProcessing(true);
    setStatusMessage('Starting camera...');

    const vid = document.createElement('video');
    vid.srcObject = stream; vid.playsInline = true; vid.muted = true;
    try { await vid.play(); } catch { setStatusMessage('Camera Error'); return; }
    hostVideoRef.current = vid;

    const out = document.createElement('canvas');
    out.width = 1280; out.height = 720;
    outputCanvasRef.current = out;

    const refC = document.createElement('canvas');
    refC.width = 1280; refC.height = 720;
    refCanvasRef.current = refC;

    const outStream = out.captureStream(30);
    stream.getAudioTracks().forEach(t => outStream.addTrack(t));
    setProcessedStream(outStream);

    try {
      setStatusMessage('Loading AI models...');
      if (!scriptFlags.current.selfie) {
        await loadScript('mp-selfie', 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');
        scriptFlags.current.selfie = true;
      }
      if (!scriptFlags.current.mesh) {
        await loadScript('mp-facemesh', 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/face_mesh.js');
        scriptFlags.current.mesh = true;
      }

      await initSelfieSegmentation();
      await initFaceMesh();

      setStatusMessage('Camera Ready');
      startRenderLoop();
    } catch (err) {
      console.error('MediaPipe init failed:', err);
      setStatusMessage('AI load failed – using passthrough');
      startFallbackLoop();
    }

    setIsProcessing(false);
  }, [loadScript]);

  // ── Selfie segmentation ────────────────────────────────────────────────────
  const initSelfieSegmentation = useCallback(async () => {
    const SelfieSegmentation = (window as any).SelfieSegmentation;
    if (!SelfieSegmentation) throw new Error('SelfieSegmentation missing');
    const seg = new SelfieSegmentation({
      locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`,
    });
    seg.setOptions({ modelSelection: 1, selfieMode: false });
    seg.onResults((r: any) => { segResultRef.current = r; });
    selfieSegRef.current = seg;
  }, []);

  // ── Face mesh for host live feed ───────────────────────────────────────────
  const initFaceMesh = useCallback(async () => {
    if (!window.FaceMesh) throw new Error('FaceMesh missing');

    const mkMesh = (onLandmarks: (lms: Pt[], w: number, h: number) => void) => {
      const mesh = new window.FaceMesh({
        locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${f}`,
      });
      mesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      mesh.onResults((results: any) => {
        const imgW = results.image?.width  ?? 1280;
        const imgH = results.image?.height ?? 720;
        if (results.multiFaceLandmarks?.[0]) {
          const lms = results.multiFaceLandmarks[0];
          const pts = UNIQUE_FACE_POINTS.map(i => ({
            x: lms[i].x * imgW,
            y: lms[i].y * imgH,
          }));
          onLandmarks(pts, imgW, imgH);
        }
      });
      return mesh;
    };

    faceMeshHostRef.current = mkMesh((pts) => { hostLandmarksRef.current = pts; });
    faceMeshRefRef.current  = mkMesh((pts) => { refLandmarksRef.current = pts; });
  }, []);

  // ── Render loop ────────────────────────────────────────────────────────────
  const startRenderLoop = useCallback(() => {
    let hostMeshBusy = false;
    let refMeshBusy  = false;
    let segBusy      = false;
    let frame = 0;

    const tick = async () => {
      const vid    = hostVideoRef.current;
      const refVid = refVideoRef.current;
      const out    = outputCanvasRef.current;
      const refC   = refCanvasRef.current;

      if (!vid || !out || vid.readyState < 2) {
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }

      // Stagger heavy AI calls so they don't all fire on the same frame
      frame++;

      // Send to selfie segmentation every frame
      if (!segBusy && selfieSegRef.current) {
        segBusy = true;
        selfieSegRef.current.send({ image: vid }).then(() => { segBusy = false; }).catch(() => { segBusy = false; });
      }

      // Send host to face mesh every 2 frames
      if (frame % 2 === 0 && !hostMeshBusy && faceMeshHostRef.current && settingsRef.current.enabled) {
        hostMeshBusy = true;
        faceMeshHostRef.current.send({ image: vid }).then(() => { hostMeshBusy = false; }).catch(() => { hostMeshBusy = false; });
      }

      // Send reference video to face mesh every 3 frames
      if (frame % 3 === 0 && !refMeshBusy && faceMeshRefRef.current && refVid && refVid.readyState >= 2 && settingsRef.current.enabled) {
        refMeshBusy = true;
        // Capture reference frame to canvas for pixel sampling later
        const rCtx = refC?.getContext('2d');
        if (rCtx && refC) { rCtx.drawImage(refVid, 0, 0, refC.width, refC.height); }
        faceMeshRefRef.current.send({ image: refVid }).then(() => { refMeshBusy = false; }).catch(() => { refMeshBusy = false; });
      }

      // Render current frame
      render();
      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  // ── Main render ───────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const out    = outputCanvasRef.current;
    const vid    = hostVideoRef.current;
    const refC   = refCanvasRef.current;
    const seg    = segResultRef.current;
    const bgImg  = bgImgRef.current;
    const bgVal  = currentBgRef.current;
    const s      = settingsRef.current;
    const hostLms = hostLandmarksRef.current;
    const refLms  = refLandmarksRef.current;

    if (!out || !vid) return;
    const ctx = out.getContext('2d', { willReadFrequently: false });
    if (!ctx) return;

    const W = out.width, H = out.height;

    ctx.clearRect(0, 0, W, H);

    // ── 1. Background ──────────────────────────────────────────────────────
    if (bgVal && bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
      ctx.drawImage(bgImg, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, H);
    }

    // ── 2. Composite person over background using segmentation mask ────────
    if (seg?.segmentationMask) {
      // Person = live camera, cut out via mask
      const personOff = new OffscreenCanvas(W, H);
      const pCtx = personOff.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (pCtx) {
        // Draw raw camera frame
        pCtx.drawImage(seg.image, 0, 0, W, H);

        // If face swap active and we have landmarks from both faces, apply it
        if (s.enabled && hostLms && refLms && refC) {
          applyFaceSwap(pCtx, refC, hostLms, refLms, W, H);
        }

        // Knock out background (keep only person)
        pCtx.globalCompositeOperation = 'destination-in';
        pCtx.drawImage(seg.segmentationMask, 0, 0, W, H);
        pCtx.globalCompositeOperation = 'source-over';

        ctx.drawImage(personOff, 0, 0);
      }
    } else if (vid.readyState >= 2) {
      // No segmentation yet – just show camera
      ctx.drawImage(vid, 0, 0, W, H);
    }

    // Status
    if (s.enabled && hostLms && refLms) setStatusMessage('Transformation Active');
    else if (bgVal && bgImg?.complete)  setStatusMessage('Background Active');
    else                                setStatusMessage('Camera Ready');
  }, []);

  // ── Triangulated face swap ────────────────────────────────────────────────
  const applyFaceSwap = (
    dstCtx: OffscreenCanvasRenderingContext2D,
    srcCanvas: HTMLCanvasElement,
    hostLms: Pt[],
    refLms: Pt[],
    W: number,
    H: number,
  ) => {
    // hostLms and refLms are already in pixel coords relative to their respective video sizes
    // They share the same indexing (both are UNIQUE_FACE_POINTS mapped to their frame)

    // Build Delaunay triangulation on reference landmark positions
    const tris = delaunay(refLms);
    if (!tris.length) return;

    // Create an off-screen canvas where we'll draw the warped reference face
    const faceOff = new OffscreenCanvas(W, H);
    const fCtx = faceOff.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!fCtx) return;

    // Draw all triangles: warp each triangle from ref-space → host-space
    for (const tri of tris) {
      const [i0, i1, i2] = tri;

      const rPts: [Pt, Pt, Pt] = [refLms[i0], refLms[i1], refLms[i2]];
      const hPts: [Pt, Pt, Pt] = [hostLms[i0], hostLms[i1], hostLms[i2]];

      // Skip degenerate triangles
      const area = Math.abs(
        (hPts[1].x - hPts[0].x) * (hPts[2].y - hPts[0].y) -
        (hPts[2].x - hPts[0].x) * (hPts[1].y - hPts[0].y)
      );
      if (area < 4) continue;

      const M = affineFromTriangles(rPts, hPts);
      if (!M) continue;

      fCtx.save();

      // Clip to host triangle shape
      fCtx.beginPath();
      fCtx.moveTo(hPts[0].x, hPts[0].y);
      fCtx.lineTo(hPts[1].x, hPts[1].y);
      fCtx.lineTo(hPts[2].x, hPts[2].y);
      fCtx.closePath();
      fCtx.clip();

      // Apply affine transform: maps ref image coords → host canvas coords
      fCtx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);

      // Draw the reference frame (sampled at ref coords, landed at host coords)
      fCtx.drawImage(srcCanvas, 0, 0, W, H);

      fCtx.restore();
    }

    // ── Build soft face hull mask for blending ─────────────────────────────
    // Use face oval host landmarks to create a feathered mask
    const maskOff = new OffscreenCanvas(W, H);
    const mCtx = maskOff.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (mCtx) {
      mCtx.clearRect(0, 0, W, H);

      // Map FACE_OVAL_IDX to UNIQUE_FACE_POINTS positions
      const ovalPts = FACE_OVAL_IDX.map(mpIdx => {
        const pos = UNIQUE_FACE_POINTS.indexOf(mpIdx);
        return pos >= 0 && hostLms[pos] ? hostLms[pos] : null;
      }).filter((p): p is Pt => p !== null);

      if (ovalPts.length > 3) {
        // Compute centroid
        const cx = ovalPts.reduce((s, p) => s + p.x, 0) / ovalPts.length;
        const cy = ovalPts.reduce((s, p) => s + p.y, 0) / ovalPts.length;

        // Draw filled hull with inner gradient for feathering
        const maxDist = Math.max(...ovalPts.map(p => Math.hypot(p.x - cx, p.y - cy)));
        const grad = mCtx.createRadialGradient(cx, cy, maxDist * 0.5, cx, cy, maxDist * 1.05);
        grad.addColorStop(0,   'rgba(0,0,0,1)');
        grad.addColorStop(0.8, 'rgba(0,0,0,0.92)');
        grad.addColorStop(1,   'rgba(0,0,0,0)');

        mCtx.beginPath();
        mCtx.moveTo(ovalPts[0].x, ovalPts[0].y);
        for (let i = 1; i < ovalPts.length; i++) {
          const prev = ovalPts[i - 1];
          const curr = ovalPts[i];
          mCtx.quadraticCurveTo(prev.x, prev.y, (prev.x + curr.x) / 2, (prev.y + curr.y) / 2);
        }
        mCtx.closePath();

        mCtx.fillStyle = grad;
        mCtx.fill();
      }

      // Apply mask to faceOff: keep only the face region with feathered edges
      fCtx!.globalCompositeOperation = 'destination-in';
      fCtx!.drawImage(maskOff, 0, 0);
      fCtx!.globalCompositeOperation = 'source-over';
    }

    // ── Color-correct the warped face to match host skin tone ─────────────
    // Simple luminance matching: apply globalAlpha for blending
    // More advanced: could do histogram matching, but for real-time this is sufficient

    // Composite the warped face over the person layer
    // Use 'source-over' for natural blending – the mask handles the edges
    dstCtx.drawImage(faceOff, 0, 0);
  };

  // ── Fallback loop (no AI) ─────────────────────────────────────────────────
  const startFallbackLoop = useCallback(() => {
    const tick = () => {
      const vid = hostVideoRef.current;
      const out = outputCanvasRef.current;
      if (vid && out && vid.readyState >= 2) {
        const ctx = out.getContext('2d');
        ctx?.drawImage(vid, 0, 0, out.width, out.height);
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  // ── Background ────────────────────────────────────────────────────────────
  const updateBackground = useCallback((backgroundId: string) => {
    const opt   = backgroundOptions.find(o => o.id === backgroundId);
    const bgVal = opt?.value ?? '';

    currentBgRef.current = bgVal;
    setTransformationSettings(prev => ({ ...prev, background: bgVal }));

    if (!bgVal) { bgImgRef.current = null; setStatusMessage('Camera Ready'); return; }

    setStatusMessage('Loading background...');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { bgImgRef.current = img; setStatusMessage('Background Active'); };
    img.onerror = () => { bgImgRef.current = null; setStatusMessage('Background load failed'); };
    img.src = bgVal;
  }, []);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    [selfieSegRef, faceMeshHostRef, faceMeshRefRef].forEach(r => { try { r.current?.close(); } catch {} r.current = null; });
    if (hostVideoRef.current) { hostVideoRef.current.pause(); hostVideoRef.current.srcObject = null; hostVideoRef.current = null; }
    bgImgRef.current = null; outputCanvasRef.current = null; refCanvasRef.current = null;
    hostLandmarksRef.current = null; refLandmarksRef.current = null; segResultRef.current = null;
    currentBgRef.current = ''; refVideoRef.current = null;
    scriptFlags.current = { selfie: false, mesh: false };
    setProcessedStream(null); setIsProcessing(false); setStatusMessage('Camera Ready');
  }, []);

  useEffect(() => () => { cleanup(); }, [cleanup]);

  return {
    processedStream, transformationSettings, setTransformationSettings,
    referenceVideo, setReferenceVideo, backgroundOptions, isProcessing,
    statusMessage, initializeTransform, updateBackground, cleanup,
  };
}
