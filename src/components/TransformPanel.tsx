import { Upload, X, ChevronLeft, ChevronRight, CheckCircle, AlertCircle, Loader, Sparkles } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import type { TransformationSettings } from '../types';
import { backgroundOptions } from '../hooks/useFaceTransform';

interface TransformPanelProps {
  transformationSettings: TransformationSettings;
  setTransformationSettings: React.Dispatch<React.SetStateAction<TransformationSettings>>;
  referenceVideo: HTMLVideoElement | null;
  setReferenceVideo: (video: HTMLVideoElement | null) => void;
  onBackgroundChange: (backgroundId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  statusMessage: string;
}

export default function TransformPanel({
  transformationSettings,
  setTransformationSettings,
  referenceVideo: _referenceVideo,
  setReferenceVideo,
  onBackgroundChange,
  isCollapsed,
  onToggleCollapse,
  statusMessage,
}: TransformPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cleanup preview URL on unmount or when cleared
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const handleVideoUpload = (file: File) => {
    setUploadStatus('loading');

    // Clear any existing video first
    clearVideo(false);

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;

    video.onloadeddata = () => {
      video.play().catch(() => {});
      setUploadStatus('success');
      setReferenceVideo(video);
      setTransformationSettings(prev => ({
        ...prev,
        referenceVideo: url,
      }));
    };

    video.onerror = () => {
      setUploadStatus('error');
      URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  };

  const clearVideo = (resetSettings: boolean = true) => {
    // Stop any playing video
    if (_referenceVideo) {
      _referenceVideo.pause();
      _referenceVideo.src = '';
    }

    // Revoke URL
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setPreviewUrl(null);
    setUploadStatus('idle');
    setReferenceVideo(null);

    if (resetSettings) {
      setTransformationSettings(prev => ({
        ...prev,
        referenceVideo: null,
        enabled: false,
      }));
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      handleVideoUpload(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleVideoUpload(file);
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleClearClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearVideo(true);
  };

  const toggleTransformation = () => {
    setTransformationSettings(prev => ({
      ...prev,
      enabled: !prev.enabled,
    }));
  };

  const getStatusIcon = () => {
    if (uploadStatus === 'loading') {
      return <Loader size={14} className="animate-spin text-yellow-400" />;
    }
    if (uploadStatus === 'success' || transformationSettings.referenceVideo) {
      return <CheckCircle size={14} className="text-green-400" />;
    }
    if (uploadStatus === 'error') {
      return <AlertCircle size={14} className="text-red-400" />;
    }
    return null;
  };

  return (
    <div
      className={`fixed top-16 right-0 bottom-16 w-80 bg-dark-900 border-l border-dark-700
        transition-transform duration-300 z-20
        ${isCollapsed ? 'translate-x-full' : 'translate-x-0'}`}
    >
      <button
        onClick={onToggleCollapse}
        className="absolute -left-10 top-1/2 -translate-y-1/2 w-10 h-20 bg-dark-800
          border border-dark-700 rounded-l-lg flex items-center justify-center
          hover:bg-dark-700 transition-colors"
      >
        {isCollapsed ? (
          <ChevronLeft size={20} className="text-white" />
        ) : (
          <ChevronRight size={20} className="text-white" />
        )}
      </button>

      <div className="h-full overflow-y-auto p-4">
        <h2 className="text-lg font-semibold text-white mb-2">Transformation Controls</h2>
        <p className="text-xs text-dark-400 mb-4">
          Upload a reference video to transform. Only visible to you.
        </p>

        <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-dark-800 rounded-lg border border-dark-700">
          {getStatusIcon()}
          <span className="text-xs text-dark-300">{statusMessage}</span>
        </div>

        <div className="space-y-6">
          {/* Video Upload */}
          <div>
            <label className="text-sm font-medium text-dark-300 block mb-2">
              Reference Video
            </label>
            <div
              className={`relative border-2 border-dashed rounded-lg transition-colors cursor-pointer ${
                isDragging ? 'border-primary-400 bg-primary-400/10' :
                previewUrl ? 'border-primary-500' : 'border-dark-600 hover:border-dark-500'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleUploadClick}
            >
              {previewUrl ? (
                <div className="relative p-2">
                  <video
                    src={previewUrl}
                    className="w-full h-32 object-cover rounded-lg"
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                  {uploadStatus === 'success' && (
                    <div className="absolute top-4 left-4 px-2 py-1 bg-green-500/90 rounded text-xs text-white flex items-center gap-1">
                      <CheckCircle size={12} />
                      Loaded
                    </div>
                  )}
                  {uploadStatus === 'error' && (
                    <div className="absolute top-4 left-4 px-2 py-1 bg-red-500/90 rounded text-xs text-white flex items-center gap-1">
                      <AlertCircle size={12} />
                      Failed
                    </div>
                  )}
                  <button
                    onClick={handleClearClick}
                    className="absolute top-4 right-4 w-7 h-7 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors"
                  >
                    <X size={14} className="text-white" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-36 text-center p-4">
                  {uploadStatus === 'loading' ? (
                    <>
                      <Loader size={24} className="text-primary-400 animate-spin mb-2" />
                      <p className="text-sm text-dark-400">Processing...</p>
                    </>
                  ) : (
                    <>
                      <Upload size={24} className="text-dark-400 mb-2" />
                      <p className="text-sm text-dark-400">Drop video or click</p>
                      <p className="text-xs text-dark-500 mt-1">MP4, WebM</p>
                    </>
                  )}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={handleFileSelect}
              />
            </div>
          </div>

          {/* Background Selection */}
          <div>
            <label className="text-sm font-medium text-dark-300 block mb-3">
              Virtual Background
            </label>
            <div className="grid grid-cols-2 gap-2">
              {backgroundOptions.map((bg) => (
                <button
                  key={bg.id}
                  className={`relative rounded-lg overflow-hidden aspect-video border-2 transition-all ${
                    transformationSettings.background === bg.value
                      ? 'border-primary-400 ring-2 ring-primary-400/30'
                      : 'border-dark-600 hover:border-dark-500'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBackgroundChange(bg.id);
                  }}
                >
                  {bg.id === 'none' ? (
                    <div className="w-full h-full bg-dark-700 flex items-center justify-center">
                      <span className="text-xs text-dark-400">None</span>
                    </div>
                  ) : (
                    <img
                      src={bg.thumbnail}
                      alt={bg.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="absolute bottom-0 left-0 right-0 bg-dark-900/80 px-2 py-1">
                    <span className="text-xs text-white truncate">{bg.name}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Enable Transformation Button */}
          {transformationSettings.referenceVideo && (
            <div className="pt-4 border-t border-dark-700">
              <button
                onClick={toggleTransformation}
                className={`w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                  transformationSettings.enabled
                    ? 'bg-primary-500 text-white hover:bg-primary-600'
                    : 'bg-dark-700 text-dark-300 hover:bg-dark-600 hover:text-white'
                }`}
              >
                {transformationSettings.enabled ? (
                  <>
                    <Sparkles size={16} />
                    Transformation Active
                  </>
                ) : (
                  <>
                    <Sparkles size={16} className="opacity-50" />
                    Enable Transformation
                  </>
                )}
              </button>
              <p className="text-xs text-dark-400 mt-2 text-center">
                {transformationSettings.enabled
                  ? 'Your face is being transformed'
                  : 'Click to activate face transformation'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
