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
  { id: 'none', name: 'None', thumbnail: '', value: '' },
  { id: 'office', name: 'Modern Office', thumbnail: 'https://images.pexels.com/photos/1170412/pexels-photo-1170412.jpeg?auto=compress&cs=tinysrgb&w=200', value: 'https://images.pexels.com/photos/1170412/pexels-photo-1170412.jpeg?auto=compress&cs=tinysrgb&w=1280' },
  { id: 'luxury', name: 'Luxury Office', thumbnail: 'https://images.pexels.com/photos/3801740/pexels-photo-3801740.jpeg?auto=compress&cs=tinysrgb&w=200', value: 'https://images.pexels.com/photos/3801740/pexels-photo-3801740.jpeg?auto=compress&cs=tinysrgb&w=1280' },
  { id: 'studio', name: 'Studio', thumbnail: 'https://images.pexels.com/photos/1595385/pexels-photo-1595385.jpeg?auto=compress&cs=tinysrgb&w=200', value: 'https://images.pexels.com/photos/1595385/pexels-photo-1595385.jpeg?auto=compress&cs=tinysrgb&w=1280' },
  { id: 'conference', name: 'Conference Room', thumbnail: 'https://images.pexels.com/photos/159711/books-coffee-students-room-159711.jpeg?auto=compress&cs=tinysrgb&w=200', value: 'https://images.pexels.com/photos/159711/books-coffee-students-room-159711.jpeg?auto=compress&cs=tinysrgb&w=1280' },
  { id: 'apartment', name: 'Modern Apartment', thumbnail: 'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=200', value: 'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=1280' },
];

declare global {
  interface Window {
    FaceMesh: any;
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

  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const backgroundImgRef = useRef<HTMLImageElement | null>(null);
  const inputStreamRef = useRef<MediaStream | null>(null);
  const selfieSegmentationRef = useRef<any>(null);
  const isInitializedRef = useRef(false);
  const isProcessingRef = useRef(false);

  const currentBackgroundRef = useRef<string>('');
  const settingsRef = useRef(transformationSettings);
  const referenceVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    settingsRef.current = transformationSettings;
  }, [transformationSettings]);

  useEffect(() => {
    referenceVideoRef.current = referenceVideo;
  }, [referenceVideo]);

  const loadScript = useCallback((id: string, src: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById(id);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.id = id;
      script.src = src;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }, []);

  const initializeTransform = useCallback(async (stream: MediaStream) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    inputStreamRef.current = stream;
    setIsProcessing(true);
    setStatusMessage('Starting camera...');

    const video = document.createElement('video');
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;

    try {
      await video.play();
      videoRef.current = video;
      setStatusMessage('Camera Ready');
    } catch (err) {
      console.error('Video play error:', err);
      setStatusMessage('Camera Error');
      isProcessingRef.current = false;
      return;
    }

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = 1280;
    outputCanvas.height = 720;
    outputCanvasRef.current = outputCanvas;

    const outputStream = outputCanvas.captureStream(30);
    stream.getAudioTracks().forEach(track => outputStream.addTrack(track));
    setProcessedStream(outputStream);

    try {
      setStatusMessage('Loading AI model...');
      await loadScript('mediapipe-selfie', 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');

      if (!window.SelfieSegmentation) {
        throw new Error('SelfieSegmentation not loaded');
      }

      const selfieSegmentation = new window.SelfieSegmentation({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
      });

      selfieSegmentation.setOptions({
        modelSelection: 1,
        selfieMode: false,
      });

      selfieSegmentationRef.current = selfieSegmentation;
      setStatusMessage('AI Ready');

      startProcessingLoop();
    } catch (error) {
      console.error('Error loading MediaPipe:', error);
      setStatusMessage('AI model failed to load');

      const fallbackLoop = () => {
        if (!outputCanvasRef.current || !videoRef.current) {
          animationFrameRef.current = requestAnimationFrame(fallbackLoop);
          return;
        }
        const ctx = outputCanvasRef.current.getContext('2d');
        if (ctx) {
          ctx.drawImage(videoRef.current, 0, 0, outputCanvasRef.current.width, outputCanvasRef.current.height);
        }
        animationFrameRef.current = requestAnimationFrame(fallbackLoop);
      };
      fallbackLoop();
    }

    isProcessingRef.current = false;
  }, [loadScript]);

  const startProcessingLoop = useCallback(() => {
    const processFrame = async () => {
      const video = videoRef.current;
      const outputCanvas = outputCanvasRef.current;
      const selfieSegmentation = selfieSegmentationRef.current;

      if (!video || !outputCanvas || video.readyState < 2) {
        animationFrameRef.current = requestAnimationFrame(processFrame);
        return;
      }

      const ctx = outputCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        animationFrameRef.current = requestAnimationFrame(processFrame);
        return;
      }

      if (selfieSegmentation) {
        try {
          await selfieSegmentation.send({ image: video });
        } catch (e) {
          ctx.drawImage(video, 0, 0, outputCanvas.width, outputCanvas.height);
        }
      } else {
        ctx.drawImage(video, 0, 0, outputCanvas.width, outputCanvas.height);
      }

      animationFrameRef.current = requestAnimationFrame(processFrame);
    };

    if (selfieSegmentationRef.current) {
      selfieSegmentationRef.current.onResults((results: any) => {
        const outputCanvas = outputCanvasRef.current;
        if (!outputCanvas) return;

        const ctx = outputCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        const width = outputCanvas.width;
        const height = outputCanvas.height;

        const bgValue = currentBackgroundRef.current;
        const settings = settingsRef.current;
        const refVid = referenceVideoRef.current;

        ctx.clearRect(0, 0, width, height);

        // Step 1: Draw background if selected
        if (bgValue && backgroundImgRef.current && backgroundImgRef.current.complete) {
          ctx.drawImage(backgroundImgRef.current, 0, 0, width, height);
        } else {
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(0, 0, width, height);
        }

        // Step 2: Draw person on top with proper segmentation
        if (results.segmentationMask) {
          // Create temporary canvas for person
          const personCanvas = document.createElement('canvas');
          personCanvas.width = width;
          personCanvas.height = height;
          const personCtx = personCanvas.getContext('2d');

          if (personCtx) {
            // Draw the person
            personCtx.drawImage(results.image, 0, 0, width, height);

            // Use segmentation mask to extract person
            personCtx.globalCompositeOperation = 'destination-in';
            personCtx.drawImage(results.segmentationMask, 0, 0, width, height);
            personCtx.globalCompositeOperation = 'source-over';

            // Apply face transformation if enabled
            if (settings.enabled && refVid && refVid.readyState >= 2) {
              applyFaceTransformation(personCtx, personCanvas, refVid, width, height);
            }

            // Draw person on top of background
            ctx.drawImage(personCanvas, 0, 0);
          }
        } else {
          // Fallback: just draw the video
          ctx.drawImage(results.image, 0, 0, width, height);
        }

        // Update status
        if (settings.enabled && refVid && refVid.readyState >= 2) {
          setStatusMessage('Transformation Active');
        } else if (bgValue && backgroundImgRef.current?.complete) {
          setStatusMessage('Background Active');
        } else {
          setStatusMessage('Camera Ready');
        }
      });
    }

    animationFrameRef.current = requestAnimationFrame(processFrame);
  }, []);

  const applyFaceTransformation = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    refVid: HTMLVideoElement,
    width: number,
    height: number
  ) => {
    // Get reference frame from video
    const refCanvas = document.createElement('canvas');
    refCanvas.width = width;
    refCanvas.height = height;
    const refCtx = refCanvas.getContext('2d');

    if (!refCtx) return;

    refCtx.drawImage(refVid, 0, 0, width, height);

    const outputData = ctx.getImageData(0, 0, width, height);
    const refData = refCtx.getImageData(0, 0, width, height);

    const outputPixels = outputData.data;
    const refPixels = refData.data;

    // Face region estimation (center-top area where face typically is)
    const faceCenterX = width * 0.5;
    const faceCenterY = height * 0.35;
    const faceWidth = width * 0.4;
    const faceHeight = height * 0.5;

    // Sample every 2 pixels for performance
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const dx = (x - faceCenterX) / (faceWidth / 2);
        const dy = (y - faceCenterY) / (faceHeight / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1.0) {
          const blend = Math.pow(1 - dist, 1.5); // Smooth falloff
          const idx = (y * width + x) * 4;

          // Get colors
          const srcR = outputPixels[idx];
          const srcG = outputPixels[idx + 1];
          const srcB = outputPixels[idx + 2];

          const refR = refPixels[idx];
          const refG = refPixels[idx + 1];
          const refB = refPixels[idx + 2];

          // Brightness matching
          const srcBrightness = (srcR + srcG + srcB) / 3;
          const refBrightness = (refR + refG + refB) / 3;
          const brightnessRatio = srcBrightness > 0 ? refBrightness / srcBrightness : 1;
          const clampedRatio = Math.max(0.5, Math.min(2.0, brightnessRatio));

          const adjR = Math.min(255, Math.max(0, refR / clampedRatio));
          const adjG = Math.min(255, Math.max(0, refG / clampedRatio));
          const adjB = Math.min(255, Math.max(0, refB / clampedRatio));

          // Blend colors
          outputPixels[idx] = Math.round(srcR * (1 - blend) + adjR * blend);
          outputPixels[idx + 1] = Math.round(srcG * (1 - blend) + adjG * blend);
          outputPixels[idx + 2] = Math.round(srcB * (1 - blend) + adjB * blend);

          // Fill adjacent pixels for smooth result
          if (x + 1 < width) {
            const idx2 = idx + 4;
            outputPixels[idx2] = outputPixels[idx];
            outputPixels[idx2 + 1] = outputPixels[idx + 1];
            outputPixels[idx2 + 2] = outputPixels[idx + 2];
          }
          if (y + 1 < height) {
            const idx3 = idx + width * 4;
            outputPixels[idx3] = outputPixels[idx];
            outputPixels[idx3 + 1] = outputPixels[idx + 1];
            outputPixels[idx3 + 2] = outputPixels[idx + 2];
          }
        }
      }
    }

    ctx.putImageData(outputData, 0, 0);
  };

  const updateBackground = useCallback((backgroundId: string) => {
    const bgOption = backgroundOptions.find(opt => opt.id === backgroundId);
    const bgValue = bgOption?.value || '';

    currentBackgroundRef.current = bgValue;

    setTransformationSettings(prev => ({
      ...prev,
      background: bgValue,
    }));

    if (bgValue) {
      setStatusMessage('Loading background...');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = bgValue;

      img.onload = () => {
        backgroundImgRef.current = img;
        setStatusMessage('Background Active');
      };

      img.onerror = () => {
        backgroundImgRef.current = null;
        setStatusMessage('Background Load Failed');
      };
    } else {
      backgroundImgRef.current = null;
      setStatusMessage('Camera Ready');
    }
  }, []);

  const cleanup = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (selfieSegmentationRef.current) {
      try {
        selfieSegmentationRef.current.close();
      } catch (e) {}
      selfieSegmentationRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }

    if (referenceVideo) {
      referenceVideo.pause();
      referenceVideo.src = '';
    }

    inputStreamRef.current = null;
    backgroundImgRef.current = null;
    outputCanvasRef.current = null;
    currentBackgroundRef.current = '';
    referenceVideoRef.current = null;
    isInitializedRef.current = false;

    setProcessedStream(null);
    setIsProcessing(false);
    setStatusMessage('Camera Ready');
    isProcessingRef.current = false;
  }, [referenceVideo]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

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
