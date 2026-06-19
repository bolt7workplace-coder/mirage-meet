import { useRef, useState, useCallback, useEffect } from 'react';
import { socket } from '../lib/socket';
import type { Participant } from '../types';

interface UseWebRTCReturn {
  localStream: MediaStream | null;
  participants: Map<string, Participant>;
  startLocalStream: () => Promise<MediaStream | void>;
  stopLocalStream: () => void;
  toggleCamera: () => void;
  toggleMicrophone: () => void;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  initPeerConnections: (roomId: string) => void;
  cleanup: () => void;
}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function useWebRTC(_roomId: string | null, _processedStream: MediaStream | null): UseWebRTCReturn {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map());
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    processedStreamRef.current = _processedStream;
  }, [_processedStream]);

  const startLocalStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'user' },
        audio: true,
      });
      setLocalStream(stream);
      localStreamRef.current = stream;
      return stream;
    } catch (error) {
      console.error('Error accessing media devices:', error);
      throw error;
    }
  }, []);

  const stopLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      localStreamRef.current = null;
    }
  }, []);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setCameraEnabled(videoTrack.enabled);
        socket.emit('toggle-camera', {
          roomId: roomIdRef.current,
          enabled: videoTrack.enabled,
        });
      }
    }
  }, []);

  const toggleMicrophone = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setMicrophoneEnabled(audioTrack.enabled);
        socket.emit('toggle-microphone', {
          roomId: roomIdRef.current,
          enabled: audioTrack.enabled,
        });
      }
    }
  }, []);


  const createPeerConnection = useCallback((userId: string) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          to: userId,
          signal: {
            type: 'ice-candidate',
            candidate: event.candidate.toJSON(),
          },
        });
      }
    };

    pc.ontrack = (event) => {
      setParticipants((prev) => {
        const updated = new Map(prev);
        const existing = updated.get(userId) || {
          id: userId,
          displayName: 'Guest',
          isAdmin: false,
        };
        updated.set(userId, {
          ...existing,
          stream: event.streams[0],
        });
        return updated;
      });
    };

    const streamToSend = processedStreamRef.current || localStreamRef.current;
    if (streamToSend) {
      streamToSend.getTracks().forEach((track) => {
        pc.addTrack(track, streamToSend);
      });
    }

    return pc;
  }, []);

  const createOffer = useCallback(async (pc: RTCPeerConnection, userId: string) => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', {
      to: userId,
      signal: {
        type: 'offer',
        sdp: offer,
      },
    });
  }, []);

  const createAnswer = useCallback(async (pc: RTCPeerConnection, userId: string, offer: RTCSessionDescriptionInit) => {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', {
      to: userId,
      signal: {
        type: 'answer',
        sdp: answer,
      },
    });
  }, []);

  const initPeerConnections = useCallback((currentRoomId: string) => {
    roomIdRef.current = currentRoomId;

    socket.on('signal', async ({ from, signal }) => {
      let pc = peerConnections.current.get(from);

      if (signal.type === 'offer') {
        pc = createPeerConnection(from);
        peerConnections.current.set(from, pc);
        await createAnswer(pc, from, signal.sdp!);
      } else if (signal.type === 'answer' && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp!));
      } else if (signal.type === 'ice-candidate' && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate!));
      }
    });

    socket.on('user-joined', async ({ user }: { user: Participant }) => {
      const pc = createPeerConnection(user.id);
      peerConnections.current.set(user.id, pc);
      setParticipants((prev) => {
        const updated = new Map(prev);
        updated.set(user.id, user);
        return updated;
      });
      await createOffer(pc, user.id);
    });

    socket.on('user-left', ({ userId }: { userId: string }) => {
      const pc = peerConnections.current.get(userId);
      if (pc) {
        pc.close();
        peerConnections.current.delete(userId);
      }
      setParticipants((prev) => {
        const updated = new Map(prev);
        updated.delete(userId);
        return updated;
      });
    });

    socket.on('participant-updated', ({ userId, updates }: { userId: string; updates: Partial<Participant> }) => {
      setParticipants((prev) => {
        const updated = new Map(prev);
        const participant = updated.get(userId);
        if (participant) {
          updated.set(userId, { ...participant, ...updates });
        }
        return updated;
      });
    });
  }, [createPeerConnection, createOffer, createAnswer]);

  const cleanup = useCallback(() => {
    peerConnections.current.forEach((pc) => pc.close());
    peerConnections.current.clear();
    setParticipants(new Map());
    socket.off('signal');
    socket.off('user-joined');
    socket.off('user-left');
    socket.off('participant-updated');
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
      stopLocalStream();
    };
  }, [cleanup, stopLocalStream]);

  return {
    localStream,
    participants,
    startLocalStream,
    stopLocalStream,
    toggleCamera,
    toggleMicrophone,
    cameraEnabled,
    microphoneEnabled,
    initPeerConnections,
    cleanup,
  };
}
