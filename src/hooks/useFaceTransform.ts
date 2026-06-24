import { useRef, useState, useCallback, useEffect } from 'react';
import type * as OrtType from 'onnxruntime-web';
import type * as FaceLandmarksDetectionType from '@tensorflow-models/face-landmarks-detection';
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
  modelLoadProgress: number;
  initializeTransform: (stream: MediaStream) => Promise<void>;
  updateBackground: (backgroundId: string) => void;
  cleanup: () => void;
}

export const backgroundOptions: BackgroundOption[] = [
  { id: 'none', name: 'None', thumbnail: '', value: '' },
  {
    id: 'office',
    name: 'Modern Office',
    thumbnail: 'https://images.pexels.com/photos/667838/pexels-photo-667838.jpeg?auto=compress&cs=tinysrgb&w=200',
    value: 'https://images.pexels.com/photos/667838/pexels-photo-667838.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'luxury',
    name: 'Luxury Office',
    thumbnail: 'https://images.pexels.com/photos/1743555/pexels-photo-1743555.jpeg?auto=compress&cs=tinysrgb&w=200',
    value: 'https://images.pexels.com/photos/1743555/pexels-photo-1743555.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'studio',
    name: 'Studio',
    thumbnail: 'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg?auto=compress&cs=tinysrgb&w=200',
    value: 'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'conference',
    name: 'Conference Room',
    thumbnail: 'https://images.pexels.com/photos/416320/pexels-photo-416320.jpeg?auto=compress&cs=tinysrgb&w=200',
    value: 'https://images.pexels.com/photos/416320/pexels-photo-416320.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
  {
    id: 'apartment',
    name: 'Modern Apartment',
    thumbnail: 'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=200',
    value: 'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=1280',
  },
];

// Suppress TF.js console warnings
const suppressTFLogs = () => {
  const orig = console.warn.bind(console);
  console.warn = (...args) => { if (String(args[0]).includes('tf')) return; orig(...args); };
};

// ONNX model URLs (these are publicly available open-source models)
const FACE_SWAP_MODEL_URL = 'https://huggingface.co/facefusion/yolo_2023sep_535356/resolve/main/inswapper_128.onnx';

// Face detection landmark indices for face bounding box estimation
const LEFT_EYE_INDICES = [33, 133];
const RIGHT_EYE_INDICES = [362, 263];

interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  landmarks: { x: number; y: number }[];
}

interface FaceEmbedding {
  embedding: Float32Array;
  box: FaceBox;
}

export function useFaceTransform(): UseFaceTransformReturn {
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Camera Ready');
  const [modelLoadProgress, setModelLoadProgress] = useState(0);
  const [transformationSettings, setTransformationSettings] = useState<TransformationSettings>({
    enabled: false,
    referenceVideo: null,
    background: '',
  });
  const [referenceVideo, setReferenceVideo] = useState<HTMLVideoElement | null>(null);

  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostVideoRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const bgImgRef = useRef<HTMLImageElement | null>(null);

  // TensorFlow.js face landmark detector (loaded lazily)
  const detectorRef = useRef<FaceLandmarksDetectionType.FaceLandmarksDetector | null>(null);

  // Lazily-loaded onnxruntime-web module (dynamic import to avoid blocking page load)
  const ortRef = useRef<typeof OrtType | null>(null);

  // ONNX inference session
  const faceSwapSessionRef = useRef<OrtType.InferenceSession | null>(null);

  // MediaPipe Selfie Segmentation
  const selfieSegRef = useRef<any>(null);
  const segResultRef = useRef<any>(null);

  // Reference face embedding cache
  const refEmbeddingRef = useRef<FaceEmbedding | null>(null);
  const refEmbeddingBusyRef = useRef(false);

  // Processing flags
  const frameRef = useRef(0);
  const swapBusyRef = useRef(false);
  const segBusyRef = useRef(false);

  const settingsRef = useRef(transformationSettings);
  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentBgRef = useRef('');
  const statusCacheRef = useRef('');

  // Debounced status update
  const setStatus = useCallback((msg: string) => {
    if (statusCacheRef.current !== msg) {
      statusCacheRef.current = msg;
      setStatusMessage(msg);
    }
  }, []);

  useEffect(() => { settingsRef.current = transformationSettings; }, [transformationSettings]);
  useEffect(() => { refVideoRef.current = referenceVideo; }, [referenceVideo]);

  // Load script helper for MediaPipe
  const loadScript = useCallback((id: string, src: string): Promise<void> =>
    new Promise((res, rej) => {
      if (document.getElementById(id)) { res(); return; }
      const s = Object.assign(document.createElement('script'), { id, src, crossOrigin: 'anonymous' });
      s.onload = () => res(); s.onerror = () => rej(new Error(`Failed: ${src}`));
      document.head.appendChild(s);
    }), []);

  // Initialize MediaPipe Selfie Segmentation
  const initSelfie = useCallback(async () => {
    await loadScript('mp-selfie', 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');
    const SS = (window as any).SelfieSegmentation;
    if (!SS) return;
    const seg = new SS({ locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}` });
    seg.setOptions({ modelSelection: 1, selfieMode: false });
    seg.onResults((r: any) => { segResultRef.current = r; });
    selfieSegRef.current = seg;
  }, [loadScript]);

  // Initialize TensorFlow.js face detector (dynamically imported to avoid blocking page render)
  const initDetector = useCallback(async () => {
    suppressTFLogs();
    setStatus('Loading face detection model...');
    const faceLandmarksDetection = await import('@tensorflow-models/face-landmarks-detection');
    const detector = await faceLandmarksDetection.createDetector(
      faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
      { runtime: 'tfjs', maxFaces: 1, refineLandmarks: false },
    );
    detectorRef.current = detector;
    setStatus('Camera Ready');
  }, []);

  // Initialize ONNX face swap model — loaded lazily so it never blocks page render
  const initFaceSwapModel = useCallback(async () => {
    try {
      setStatus('Loading AI transformation model...');
      setModelLoadProgress(10);

      // Dynamically import onnxruntime-web only when needed
      const ort = await import('onnxruntime-web');
      ortRef.current = ort;

      setModelLoadProgress(20);

      // Try WebGPU first, fall back to WASM
      let executionProviders: string[] = ['wasm'];
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        executionProviders = ['webgpu'];
      } else {
        setStatus('Using WASM backend...');
      }

      setModelLoadProgress(30);

      const session = await ort.InferenceSession.create(FACE_SWAP_MODEL_URL, {
        executionProviders,
        graphOptimizationLevel: 'all',
      });

      faceSwapSessionRef.current = session;
      setModelLoadProgress(100);
      setStatus('AI model loaded');
    } catch (error) {
      console.error('Failed to load face swap model:', error);
      setStatus('AI model load failed - check connection');
      setModelLoadProgress(0);
    }
  }, []);

  // Extract face bounding box from landmarks
  const getFaceBoxFromLandmarks = useCallback((keypoints: any[], canvasW: number, canvasH: number): FaceBox | null => {
    if (!keypoints || keypoints.length < 468) return null;

    // Get eye centers
    const leftEye = keypoints[LEFT_EYE_INDICES[0]];
    const rightEye = keypoints[RIGHT_EYE_INDICES[0]];

    if (!leftEye || !rightEye) return null;

    // Calculate face center and size based on eye distance
    const eyeDistance = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
    const faceSize = eyeDistance * 2.5;

    const centerX = (leftEye.x + rightEye.x) / 2;
    const centerY = (leftEye.y + rightEye.y) / 2;

    // Expand box to include full face
    const halfSize = faceSize / 2;

    return {
      x: Math.max(0, centerX - halfSize) * (canvasW / 640),
      y: Math.max(0, centerY - halfSize * 1.2) * (canvasH / 480),
      width: Math.min(canvasW, faceSize * (canvasW / 640)),
      height: Math.min(canvasH, faceSize * 1.2 * (canvasH / 480)),
      landmarks: keypoints.slice(0, 468).map((k: any) => ({
        x: k.x * (canvasW / 640),
        y: k.y * (canvasH / 480),
      })),
    };
  }, []);

  // Detect face and return bounding box
  const detectFaceBox = useCallback(async (
    element: HTMLVideoElement | HTMLCanvasElement,
    canvasW: number,
    canvasH: number,
  ): Promise<FaceBox | null> => {
    const detector = detectorRef.current;
    if (!detector) return null;

    try {
      const faces = await detector.estimateFaces(element, { flipHorizontal: false });
      if (!faces.length) return null;

      return getFaceBoxFromLandmarks(faces[0].keypoints, canvasW, canvasH);
    } catch {
      return null;
    }
  }, [getFaceBoxFromLandmarks]);

  // Extract aligned face crop (128x128) for inswapper
  const extractAlignedFace = useCallback((
    _ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    srcCanvas: HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas,
    faceBox: FaceBox,
    targetSize: number = 128,
  ): ImageData | null => {
    // Create a square crop around the face
    const cropCanvas = new OffscreenCanvas(targetSize, targetSize);
    const cropCtx = cropCanvas.getContext('2d');
    if (!cropCtx) return null;

    // Calculate crop region with padding
    const padding = 0.3;
    const cropX = Math.max(0, faceBox.x - faceBox.width * padding);
    const cropY = Math.max(0, faceBox.y - faceBox.height * padding);
    const srcWidth = srcCanvas instanceof HTMLVideoElement ? srcCanvas.videoWidth : srcCanvas.width;
    const srcHeight = srcCanvas instanceof HTMLVideoElement ? srcCanvas.videoHeight : srcCanvas.height;
    const cropW = Math.min(
      srcWidth - cropX,
      faceBox.width * (1 + 2 * padding)
    );
    const cropH = Math.min(
      srcHeight - cropY,
      faceBox.height * (1 + 2 * padding)
    );

    // Draw and scale to target size
    cropCtx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, targetSize, targetSize);

    return cropCtx.getImageData(0, 0, targetSize, targetSize);
  }, []);

  // Generate face embedding using simple feature extraction
  // (For full accuracy, this would use ArcFace - using simplified approach here)
  const generateFaceEmbedding = useCallback((faceImageData: ImageData): Float32Array => {
    // Simplified embedding: flatten and normalize pixel data
    // In production, this would use a proper face recognition model
    const data = faceImageData.data;
    const embedding = new Float32Array(512);

    // Simple feature extraction based on color distribution
    // This is a placeholder - real implementation would use ArcFace ONNX
    for (let i = 0; i < 512; i++) {
      const startIdx = Math.floor((i / 512) * data.length / 4) * 4;
      embedding[i] = ((data[startIdx] || 0) + (data[startIdx + 1] || 0) + (data[startIdx + 2] || 0)) / (3 * 255);
    }

    // Normalize embedding
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0)) || 1;
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }

    return embedding;
  }, []);

  // Run face swap using ONNX inswapper model
  const runFaceSwap = useCallback(async (
    targetImageData: ImageData,
    sourceEmbedding: Float32Array,
  ): Promise<ImageData | null> => {
    const session = faceSwapSessionRef.current;
    const ort = ortRef.current;
    if (!session || !ort) return null;

    try {
      // Prepare input tensors
      // inswapper expects: target face (128x128 RGB) and source embedding (512)
      const targetTensor = new ort.Tensor(
        'float32',
        new Float32Array(128 * 128 * 3),
        [1, 3, 128, 128]
      );

      // Convert ImageData to NCHW format with normalization
      const targetData = targetImageData.data;
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const srcIdx = (y * 128 + x) * 4;
          const dstIdx = y * 128 + x;
          (targetTensor.data as Float32Array)[dstIdx] = targetData[srcIdx] / 255.0;
          (targetTensor.data as Float32Array)[128 * 128 + dstIdx] = targetData[srcIdx + 1] / 255.0;
          (targetTensor.data as Float32Array)[2 * 128 * 128 + dstIdx] = targetData[srcIdx + 2] / 255.0;
        }
      }

      const sourceTensor = new ort.Tensor('float32', sourceEmbedding, [1, 512]);

      // Run inference
      const feeds: Record<string, OrtType.Tensor> = {
        target: targetTensor,
        source: sourceTensor,
      };

      const results = await session.run(feeds);

      // Get output tensor (swapped face)
      const outputName = session.outputNames[0];
      const outputTensor = results[outputName];

      if (!outputTensor || !outputTensor.data) return null;

      // Convert output back to ImageData
      const outputData = new Uint8ClampedArray(128 * 128 * 4);
      const tensorData = outputTensor.data as Float32Array;
      for (let i = 0; i < 128 * 128; i++) {
        const r = Math.min(255, Math.max(0, tensorData[i] * 255));
        const g = Math.min(255, Math.max(0, tensorData[128 * 128 + i] * 255));
        const b = Math.min(255, Math.max(0, tensorData[2 * 128 * 128 + i] * 255));
        outputData[i * 4] = r;
        outputData[i * 4 + 1] = g;
        outputData[i * 4 + 2] = b;
        outputData[i * 4 + 3] = 255;
      }

      return new ImageData(outputData, 128, 128);
    } catch (error) {
      console.error('Face swap inference error:', error);
      return null;
    }
  }, []);

  // Extract and cache reference face embedding
  const updateReferenceEmbedding = useCallback(async () => {
    if (refEmbeddingBusyRef.current) return;
    const refVid = refVideoRef.current;
    if (!refVid || refVid.readyState < 2) return;

    refEmbeddingBusyRef.current = true;

    try {
      // Capture current frame from reference video onto a proper canvas
      const refCanvas = document.createElement('canvas');
      refCanvas.width = 640;
      refCanvas.height = 360;
      const refCtx = refCanvas.getContext('2d');
      if (!refCtx) return;

      refCtx.drawImage(refVid, 0, 0, 640, 360);

      // Detect face in reference
      const faceBox = await detectFaceBox(refCanvas, 640, 360);
      if (!faceBox) {
        setStatus('No face in reference video');
        return;
      }

      // Extract face crop
      const faceCrop = extractAlignedFace(refCtx, refCanvas, faceBox);
      if (!faceCrop) return;

      // Generate embedding
      const embedding = generateFaceEmbedding(faceCrop);

      refEmbeddingRef.current = {
        embedding,
        box: faceBox,
      };

      setStatus('Reference face locked');
    } catch (error) {
      console.error('Failed to extract reference embedding:', error);
    } finally {
      refEmbeddingBusyRef.current = false;
    }
  }, [detectFaceBox, extractAlignedFace, generateFaceEmbedding, setStatus]);

  // Main render loop
  const startRenderLoop = useCallback(() => {
    const tick = async () => {
      const vid = hostVideoRef.current;
      const refVid = refVideoRef.current;
      const out = outputCanvasRef.current;
      const s = settingsRef.current;

      frameRef.current++;
      const frame = frameRef.current;

      if (vid && out && vid.readyState >= 2) {
        // Run selfie segmentation
        if (!segBusyRef.current && selfieSegRef.current) {
          segBusyRef.current = true;
          selfieSegRef.current.send({ image: vid })
            .then(() => { segBusyRef.current = false; })
            .catch(() => { segBusyRef.current = false; });
        }

        // Update reference embedding when video is active
        if (s.enabled && refVid && frame % 30 === 0) {
          updateReferenceEmbedding();
        }

        // Run face swap if enabled and we have reference embedding
        if (s.enabled && refEmbeddingRef.current && !swapBusyRef.current && frame % 2 === 0) {
          swapBusyRef.current = true;

          try {
            // Detect host face
            const hostFaceBox = await detectFaceBox(vid, 1280, 720);

            if (hostFaceBox) {
              // Extract aligned face crop from host
              const tempCanvas = new OffscreenCanvas(1280, 720);
              const tempCtx = tempCanvas.getContext('2d');
              if (tempCtx) {
                tempCtx.drawImage(vid, 0, 0, 1280, 720);
                const hostFaceCrop = extractAlignedFace(tempCtx, tempCanvas, hostFaceBox);

                if (hostFaceCrop && faceSwapSessionRef.current) {
                  // Run AI face swap
                  const swappedFace = await runFaceSwap(hostFaceCrop, refEmbeddingRef.current.embedding);

                  if (swappedFace) {
                    // Store swapped face for compositing
                    (window as any).__swappedFace = {
                      imageData: swappedFace,
                      box: hostFaceBox,
                      frame: frame,
                    };
                  }
                }
              }
            }
          } catch (error) {
            console.error('Face swap processing error:', error);
          } finally {
            swapBusyRef.current = false;
          }
        }

        renderFrame();
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
  }, [detectFaceBox, extractAlignedFace, runFaceSwap, updateReferenceEmbedding]);

  // Frame renderer
  const renderFrame = useCallback(() => {
    const out = outputCanvasRef.current;
    const vid = hostVideoRef.current;
    const seg = segResultRef.current;
    const bgImg = bgImgRef.current;
    const bgVal = currentBgRef.current;
    const s = settingsRef.current;

    if (!out || !vid) return;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    const W = out.width, H = out.height;

    ctx.clearRect(0, 0, W, H);

    // 1. Draw background
    if (bgVal && bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
      ctx.drawImage(bgImg, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, H);
    }

    // 2. Draw person with optional face swap
    if (seg?.segmentationMask && vid.readyState >= 2) {
      const personOff = new OffscreenCanvas(W, H);
      const pCtx = personOff.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (pCtx) {
        // Draw live camera frame
        pCtx.drawImage(seg.image, 0, 0, W, H);

        // Composite AI-swapped face if available
        const swappedData = (window as any).__swappedFace;
        if (s.enabled && swappedData && swappedData.frame >= frameRef.current - 5) {
          const { imageData, box } = swappedData;

          // Create temporary canvas for swapped face
          const faceCanvas = new OffscreenCanvas(128, 128);
          const faceCtx = faceCanvas.getContext('2d');
          if (faceCtx) {
            faceCtx.putImageData(imageData, 0, 0);

            // Draw swapped face scaled to face box with blending
            pCtx.save();

            // Soft edge mask for face
            const centerX = box.x + box.width / 2;
            const centerY = box.y + box.height / 2;
            const radius = Math.max(box.width, box.height) / 2 * 0.9;

            const gradient = pCtx.createRadialGradient(
              centerX, centerY, radius * 0.6,
              centerX, centerY, radius * 1.2
            );
            gradient.addColorStop(0, 'rgba(255,255,255,1)');
            gradient.addColorStop(0.7, 'rgba(255,255,255,0.8)');
            gradient.addColorStop(1, 'rgba(255,255,255,0)');

            pCtx.globalCompositeOperation = 'source-over';
            pCtx.drawImage(
              faceCanvas,
              box.x - box.width * 0.1,
              box.y - box.height * 0.1,
              box.width * 1.2,
              box.height * 1.2
            );

            // Apply soft edge
            pCtx.globalCompositeOperation = 'destination-in';
            pCtx.fillStyle = gradient;
            pCtx.fillRect(box.x - box.width, box.y - box.height, box.width * 3, box.height * 3);

            pCtx.restore();
          }
        }

        // Apply segmentation mask
        pCtx.globalCompositeOperation = 'destination-in';
        pCtx.drawImage(seg.segmentationMask, 0, 0, W, H);
        pCtx.globalCompositeOperation = 'source-over';

        ctx.drawImage(personOff, 0, 0);
      }
    } else if (vid.readyState >= 2) {
      ctx.drawImage(vid, 0, 0, W, H);
    }

    // Update status
    if (s.enabled && refEmbeddingRef.current) setStatus('AI Transformation Active');
    else if (s.enabled && !faceSwapSessionRef.current) setStatus('Loading AI model...');
    else if (s.enabled && !refEmbeddingRef.current) setStatus('Detecting reference face...');
    else if (s.enabled) setStatus('Processing...');
    else if (bgVal && bgImg?.complete) setStatus('Background Active');
    else setStatus('Camera Ready');
  }, [setStatus]);

  // Initialize transformation pipeline
  const initializeTransform = useCallback(async (stream: MediaStream) => {
    if (hostVideoRef.current) return;
    setIsProcessing(true);
    setStatus('Starting camera...');

    const vid = document.createElement('video');
    vid.srcObject = stream;
    vid.playsInline = true;
    vid.muted = true;

    try {
      await vid.play();
    } catch {
      setStatus('Camera Error');
      setIsProcessing(false);
      return;
    }

    hostVideoRef.current = vid;

    const out = document.createElement('canvas');
    out.width = 1280;
    out.height = 720;
    outputCanvasRef.current = out;

    const outStream = out.captureStream(30);
    stream.getAudioTracks().forEach(t => outStream.addTrack(t));
    setProcessedStream(outStream);

    // Initialize components in parallel
    await Promise.all([
      initSelfie().catch(err => console.warn('Selfie segmentation failed:', err)),
      initDetector().catch(err => console.warn('Face detector failed:', err)),
      initFaceSwapModel().catch(err => console.warn('Face swap model failed:', err)),
    ]);

    startRenderLoop();
    setIsProcessing(false);
  }, [initSelfie, initDetector, initFaceSwapModel, startRenderLoop]);

  // Update background
  const updateBackground = useCallback((backgroundId: string) => {
    const opt = backgroundOptions.find(o => o.id === backgroundId);
    const bgVal = opt?.value ?? '';
    currentBgRef.current = bgVal;
    setTransformationSettings(prev => ({ ...prev, background: bgVal }));

    if (!bgVal) {
      bgImgRef.current = null;
      setStatus('Camera Ready');
      return;
    }

    setStatus('Loading background...');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      bgImgRef.current = img;
      setStatus('Background Active');
    };
    img.onerror = () => {
      bgImgRef.current = null;
      setStatus('Background load failed');
    };
    img.src = bgVal;
  }, [setStatus]);

  // Cleanup
  const cleanup = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    try {
      selfieSegRef.current?.close();
    } catch { /* noop */ }

    selfieSegRef.current = null;
    detectorRef.current?.dispose?.();
    detectorRef.current = null;

    // Release ONNX session
    faceSwapSessionRef.current = null;

    if (hostVideoRef.current) {
      hostVideoRef.current.pause();
      hostVideoRef.current.srcObject = null;
      hostVideoRef.current = null;
    }

    bgImgRef.current = null;
    outputCanvasRef.current = null;
    refEmbeddingRef.current = null;
    segResultRef.current = null;
    currentBgRef.current = '';
    refVideoRef.current = null;
    frameRef.current = 0;
    swapBusyRef.current = false;
    segBusyRef.current = false;

    (window as any).__swappedFace = null;

    setProcessedStream(null);
    setIsProcessing(false);
    setStatusMessage('Camera Ready');
    setModelLoadProgress(0);
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
    modelLoadProgress,
    initializeTransform,
    updateBackground,
    cleanup,
  };
}
