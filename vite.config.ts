import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
      '/create-room': {
        target: 'http://localhost:3001',
      },
    },
  },
  optimizeDeps: {
    exclude: [
      'lucide-react',
      'onnxruntime-web',
      '@tensorflow/tfjs',
      '@tensorflow-models/face-landmarks-detection',
    ],
  },
});
