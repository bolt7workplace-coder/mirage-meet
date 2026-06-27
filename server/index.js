import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import { initialize, registerReferenceFace, transformFrame, clearReference, getInitState } from './faceSwap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const rooms = new Map();

app.get('/', (req, res) => {
  res.json({
    name: 'Mirage Meet Signaling Server',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      'POST /create-room': 'Create a new meeting room',
      'Socket.IO': 'WebRTC signaling and real-time communication'
    }
  });
});

app.post('/create-room', (req, res) => {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    id: roomId,
    admin: null,
    participants: new Map(),
  });
  res.json({ roomId });
});

// ─── AI Transformation Endpoints ─────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Get AI engine status
app.get('/ai/status', (req, res) => {
  res.json(getInitState());
});

// Register reference face (host uploads a photo)
app.post('/ai/register-face', upload.single('image'), async (req, res) => {
  console.log('[Server] /ai/register-face hit, file:', req.file ? `${req.file.originalname} ${req.file.size}B mimetype=${req.file.mimetype}` : 'MISSING');
  try {
    if (!req.file) {
      console.error('[Server] register-face: no file in request. Fields:', Object.keys(req.body || {}));
      return res.status(400).json({ error: 'No image provided — ensure field name is "image"' });
    }
    const result = await registerReferenceFace(req.file.buffer);
    res.json(result);
  } catch (err) {
    console.error('[Server] register-face error:', err.message, err.stack?.split('\n')[1] || '');
    res.status(400).json({ error: err.message });
  }
});

// Transform a single JPEG frame
app.post('/ai/transform-frame', upload.single('frame'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No frame provided' });
    const resultJpeg = await transformFrame(req.file.buffer);
    if (!resultJpeg) return res.status(204).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(resultJpeg);
  } catch (err) {
    console.error('[Server] transform-frame error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clear reference face
app.post('/ai/clear-face', (req, res) => {
  clearReference();
  res.json({ success: true });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', ({ roomId: requestedRoomId, displayName }) => {
    const roomId = requestedRoomId || generateRoomId();

    if (rooms.has(roomId)) {
      const existingRoom = rooms.get(roomId);
      if (existingRoom.admin === null) {
        existingRoom.admin = socket.id;
        existingRoom.participants.set(socket.id, {
          id: socket.id,
          isAdmin: true,
          displayName: displayName || 'Host',
          cameraEnabled: true,
          microphoneEnabled: true,
        });
        socket.join(roomId);
        socket.emit('room-created', { roomId, isAdmin: true, displayName: displayName || 'Host' });
      } else {
        socket.emit('error', { message: 'Room already exists' });
      }
      return;
    }

    rooms.set(roomId, {
      id: roomId,
      admin: socket.id,
      participants: new Map([[socket.id, {
        id: socket.id,
        isAdmin: true,
        displayName: displayName || 'Host',
        cameraEnabled: true,
        microphoneEnabled: true,
      }]]),
    });
    socket.join(roomId);
    socket.emit('room-created', { roomId, isAdmin: true, displayName: displayName || 'Host' });
    console.log('Room created:', roomId, 'by', socket.id);
  });

  socket.on('join-room', ({ roomId, displayName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    const isAdmin = room.admin === socket.id;
    const participantName = displayName || 'Guest';

    room.participants.set(socket.id, {
      id: socket.id,
      isAdmin,
      displayName: participantName,
      cameraEnabled: true,
      microphoneEnabled: true,
    });

    socket.join(roomId);
    socket.emit('room-joined', {
      roomId,
      isAdmin,
      participant: { id: socket.id, isAdmin, displayName: participantName },
      participants: Array.from(room.participants.values()),
    });

    socket.to(roomId).emit('user-joined', {
      user: { id: socket.id, isAdmin, displayName: participantName, cameraEnabled: true, microphoneEnabled: true },
    });

    console.log('User joined room:', roomId, socket.id, 'as', participantName);
  });

  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      if (room.participants.has(socket.id)) {
        room.participants.delete(socket.id);
        socket.to(roomId).emit('user-left', { userId: socket.id });
        console.log('User left room:', roomId, socket.id);
      }
    });
  });

  socket.on('toggle-camera', ({ roomId, enabled }) => {
    const room = rooms.get(roomId);
    if (room && room.participants.has(socket.id)) {
      const participant = room.participants.get(socket.id);
      participant.cameraEnabled = enabled;
      socket.to(roomId).emit('participant-updated', {
        userId: socket.id,
        updates: { cameraEnabled: enabled },
      });
    }
  });

  socket.on('toggle-microphone', ({ roomId, enabled }) => {
    const room = rooms.get(roomId);
    if (room && room.participants.has(socket.id)) {
      const participant = room.participants.get(socket.id);
      participant.microphoneEnabled = enabled;
      socket.to(roomId).emit('participant-updated', {
        userId: socket.id,
        updates: { microphoneEnabled: enabled },
      });
    }
  });
});

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 9; i++) {
    if (i > 0 && i % 3 === 0) result += '-';
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);

  // Start AI model initialization in background (non-blocking)
  initialize((progress) => {
    console.log(`[AI] ${progress.state}: ${progress.message || ''}`);
  }).catch(err => {
    console.error('[AI] Initialization failed:', err.message);
  });
});
