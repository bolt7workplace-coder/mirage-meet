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

// People-free professional backgrounds
export const backgroundOptions: BackgroundOption[] = [
  { id: 'none',       name: 'None',             thumbnail: '', value: '' },
  // Clean empty office interior – no people
  {
    id: 'office',
    name: 'Modern Office',
    thumbnail: 'https://images.pexels.com/photos/667838/pexels-photo-667838.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/667838/pexels-photo-667838.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  // High-end executive office / glass partition – empty
  {
    id: 'luxury',
    name: 'Luxury Office',
    thumbnail: 'https://images.pexels.com/photos/1743555/pexels-photo-1743555.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/1743555/pexels-photo-1743555.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  // Clean minimalist white studio / content creator backdrop – no people
  {
    id: 'studio',
    name: 'Studio',
    thumbnail: 'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  // Empty board-room style conference room – chairs + long table, no people
  {
    id: 'conference',
    name: 'Conference Room',
    thumbnail: 'https://images.pexels.com/photos/416320/pexels-photo-416320.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/416320/pexels-photo-416320.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  // Modern living-room apartment – warm, inviting, no people
  {
    id: 'apartment',
    name: 'Modern Apartment',
    thumbnail: 'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=200',
    value:     'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
];

declare global {
  interface Window {
    SelfieSegmentation: any;
  }
}

export function useFaceTransform(): UseFaceTransformReturn {
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Camera Ready');
  const [transformationSettings, setTransformationSettings] = useState<TransformationSettings>({
    enabled: false,
    referenceVideo: null,
    background: '',
  });
  const [referenceVideo, setReferenceVideo] = useState<HTMLVideoElement | null>(null);

  const outputCanvasRef    = useRef<HTMLCanvasElement | null>(null);
  const videoRef           = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef  = useRef<number | null>(null);
  const backgroundImgRef   = useRef<HTMLImageElement | null>(null);
  const selfieSegRef       = useRef<any>(null);
  const isProcessingRef    = useRef(false);
  const scriptLoadedRef    = useRef(false);

  // Keep refs in sync so the render callback always reads the latest values
  const currentBgRef   = useRef<string>('');
  const settingsRef    = useRef(transformationSettings);
  const refVideoRef    = useRef<HTMLVideoElement | null>(null);

  useEffect(() => { settingsRef.current = transformationSettings; }, [transformationSettings]);
  useEffect(() => { refVideoRef.current = referenceVideo; },         [referenceVideo]);

  // ─── Script loader ──────────────────────────────────────────────────────────
  const loadScript = useCallback((id: string, src: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (document.getElementById(id)) { resolve(); return; }
      const s = document.createElement('script');
      s.id  = id; s.src = src; s.crossOrigin = 'anonymous';
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error(`Failed: ${src}`));
      document.head.appendChild(s);
    }), []);

  // ─── Main init ──────────────────────────────────────────────────────────────
  const initializeTransform = useCallback(async (stream: MediaStream) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setIsProcessing(true);
    setStatusMessage('Starting camera...');

    /* Source video */
    const srcVid = document.createElement('video');
    srcVid.srcObject = stream;
    srcVid.playsInline = true;
    srcVid.muted = true;
    try { await srcVid.play(); } catch { setStatusMessage('Camera Error'); isProcessingRef.current = false; return; }
    videoRef.current = srcVid;

    /* Output canvas → stream */
    const outCanvas = document.createElement('canvas');
    outCanvas.width  = 1280;
    outCanvas.height = 720;
    outputCanvasRef.current = outCanvas;

    const outStream = outCanvas.captureStream(30);
    stream.getAudioTracks().forEach(t => outStream.addTrack(t));
    setProcessedStream(outStream);

    /* Load MediaPipe */
    try {
      setStatusMessage('Loading AI model...');
      if (!scriptLoadedRef.current) {
        await loadScript('mp-selfie', 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');
        scriptLoadedRef.current = true;
      }

      if (!window.SelfieSegmentation) throw new Error('SelfieSegmentation not available');

      const seg = new window.SelfieSegmentation({
        locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`,
      });
      seg.setOptions({ modelSelection: 1, selfieMode: false });
      selfieSegRef.current = seg;

      /* ── Results callback ── */
      seg.onResults((results: any) => {
        const canvas = outputCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        const W = canvas.width;
        const H = canvas.height;
        const settings  = settingsRef.current;
        const refVid    = refVideoRef.current;
        const bgValue   = currentBgRef.current;
        const bgImg     = backgroundImgRef.current;

        ctx.clearRect(0, 0, W, H);

        /* 1 ▸ Draw background layer */
        if (bgValue && bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
          ctx.drawImage(bgImg, 0, 0, W, H);
        } else {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, W, H);
        }

        /* 2 ▸ Extract the person using the segmentation mask */
        if (results.segmentationMask) {
          /* Off-screen canvas that holds just the person (foreground) */
          const personCanvas = new OffscreenCanvas(W, H);
          const pCtx = personCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
          if (pCtx) {
            /* Draw the raw camera frame */
            pCtx.drawImage(results.image, 0, 0, W, H);

            /* If face-transformation is on, blend the reference face */
            if (settings.enabled && refVid && refVid.readyState >= 2) {
              applyFaceBlend(pCtx, refVid, W, H);
            }

            /* Knock out the background using the inverted mask */
            pCtx.globalCompositeOperation = 'destination-in';
            pCtx.drawImage(results.segmentationMask, 0, 0, W, H);
            pCtx.globalCompositeOperation = 'source-over';

            /* Paint person on top of background */
            ctx.drawImage(personCanvas, 0, 0);
          }
        } else {
          /* Fallback: no mask, just draw camera */
          ctx.drawImage(results.image, 0, 0, W, H);
        }

        /* 3 ▸ Status text */
        if (settings.enabled && refVid && refVid.readyState >= 2) {
          setStatusMessage('Transformation Active');
        } else if (bgValue && bgImg?.complete) {
          setStatusMessage('Background Active');
        } else {
          setStatusMessage('Camera Ready');
        }
      });

      /* ── Processing loop ── */
      setStatusMessage('Camera Ready');
      const loop = async () => {
        const vid = videoRef.current;
        if (vid && vid.readyState >= 2 && selfieSegRef.current) {
          try { await selfieSegRef.current.send({ image: vid }); } catch { /* skip frame */ }
        }
        animationFrameRef.current = requestAnimationFrame(loop);
      };
      animationFrameRef.current = requestAnimationFrame(loop);

    } catch (err) {
      console.error('MediaPipe failed, using fallback:', err);
      setStatusMessage('AI model unavailable – background disabled');
      /* Plain passthrough loop */
      const fallback = () => {
        const vid    = videoRef.current;
        const canvas = outputCanvasRef.current;
        if (vid && canvas && vid.readyState >= 2) {
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(vid, 0, 0, canvas.width, canvas.height);
        }
        animationFrameRef.current = requestAnimationFrame(fallback);
      };
      fallback();
    }

    isProcessingRef.current = false;
  }, [loadScript]);

  // ─── Face blend helper ───────────────────────────────────────────────────────
  // Strategy: draw reference video frame scaled to face area, then composite
  // with the live camera frame so expressions/movement show through naturally.
  const applyFaceBlend = (
    ctx: OffscreenCanvasRenderingContext2D,
    refVid: HTMLVideoElement,
    W: number,
    H: number,
  ) => {
    // Estimate face region (upper-centre of frame)
    const fx = W * 0.25;
    const fy = H * 0.03;
    const fw = W * 0.50;
    const fh = H * 0.70;

    // Temp canvas: reference video cropped to same face region
    const tmp = new OffscreenCanvas(W, H);
    const tCtx = tmp.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!tCtx) return;

    // Draw reference video filling entire canvas (it will be clipped by ellipse)
    tCtx.drawImage(refVid, 0, 0, W, H);

    // Soft elliptical mask for the face/body region → no hard edge
    const grad = tCtx.createRadialGradient(
      W * 0.5, H * 0.38, 0,
      W * 0.5, H * 0.38, Math.min(fw, fh) * 0.62,
    );
    grad.addColorStop(0,   'rgba(0,0,0,1)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.85)');
    grad.addColorStop(1,   'rgba(0,0,0,0)');

    tCtx.globalCompositeOperation = 'destination-in';
    tCtx.fillStyle = grad;
    tCtx.fillRect(0, 0, W, H);
    tCtx.globalCompositeOperation = 'source-over';

    // Blend reference frame on top of live frame with ~75 % opacity inside the ellipse
    ctx.globalAlpha = 0.80;
    ctx.drawImage(tmp, 0, 0);
    ctx.globalAlpha = 1.0;
  };

  // ─── Background update ───────────────────────────────────────────────────────
  const updateBackground = useCallback((backgroundId: string) => {
    const opt    = backgroundOptions.find(o => o.id === backgroundId);
    const bgVal  = opt?.value ?? '';

    currentBgRef.current = bgVal;
    setTransformationSettings(prev => ({ ...prev, background: bgVal }));

    if (!bgVal) {
      backgroundImgRef.current = null;
      setStatusMessage('Camera Ready');
      return;
    }

    setStatusMessage('Loading background...');
    const img   = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { backgroundImgRef.current = img; setStatusMessage('Background Active'); };
    img.onerror = () => { backgroundImgRef.current = null; setStatusMessage('Background load failed'); };
    img.src     = bgVal;
  }, []);

  // ─── Cleanup ────────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (animationFrameRef.current) { cancelAnimationFrame(animationFrameRef.current); animationFrameRef.current = null; }
    try { selfieSegRef.current?.close(); } catch { /* noop */ }
    selfieSegRef.current = null;
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.srcObject = null; videoRef.current = null; }
    backgroundImgRef.current   = null;
    outputCanvasRef.current    = null;
    currentBgRef.current       = '';
    refVideoRef.current        = null;
    isProcessingRef.current    = false;
    scriptLoadedRef.current    = false;
    setProcessedStream(null);
    setIsProcessing(false);
    setStatusMessage('Camera Ready');
  }, []);

  useEffect(() => () => { cleanup(); }, [cleanup]);

  return {
    processedStream,
    transformationSettings,
    setTransformationSettings,
    referenceVideo,
    setReferenceVideo,
    backgroundOptions,
    isProcessing,
    statusMessage,
    initializeTransform,
    updateBackground,
    cleanup,
  };
}
