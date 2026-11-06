/**
 * FreeRetro - Serverless P2P Collaborative Engine
 *
 * Uses 3 transport layers without depending on `0.peerjs.com` (eliminating 429 rate-limit errors):
 * 1. BroadcastChannel: 0ms sync between tabs in the same browser.
 * 2. MQTT-over-WebSockets (WSS): Instant room discovery, signaling, and real-time state sync
 *    across different browsers and networks (`broker.emqx.io` / `broker.hivemq.com`).
 * 3. Native WebRTC (`RTCPeerConnection` + `RTCDataChannel`): Direct P2P data channels negotiated
 *    automatically via the signaling topic.
 */

const WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export class RetroSyncEngine {
  constructor({
    roomId,
    userProfile,
    getLocalSession,
    onRemoteState,
    onPeersChange,
    onStatusChange
  }) {
    this.roomId = this.sanitizeId(roomId);
    this.userProfile = userProfile;
    this.getLocalSession = getLocalSession;
    this.onRemoteState = onRemoteState;
    this.onPeersChange = onPeersChange;
    this.onStatusChange = onStatusChange;

    this.nodeId = `${this.userProfile.id}_${Math.random().toString(36).slice(2, 7)}`;
    this.roomTopic = `freeretro/v1/room/${this.roomId}`;
    this.signalTopic = `freeretro/v1/signal/${this.roomId}/${this.nodeId}`;

    this.mqttClient = null;
    this.mqttConnected = false;
    this.rtcPeers = new Map();     // remoteNodeId -> { pc, dc }
    this.peersInfo = new Map();    // userId -> { id, name, color, nodeId, lastSeen, isSelf }
    this.broadcastChannel = null;
    this.destroyed = false;
    this.heartbeatTimer = null;

    this.registerSelfPeer();
  }

  sanitizeId(id) {
    return String(id || 'default').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  }

  registerSelfPeer() {
    this.peersInfo.set(this.userProfile.id, {
      id: this.userProfile.id,
      name: this.userProfile.name || 'Participante',
      avatar: this.userProfile.avatar || '🦊',
      color: this.userProfile.color || '#6366f1',
      nodeId: this.nodeId,
      lastSeen: Date.now(),
      isSelf: true
    });
    this.emitPeers();
  }

  updateUserProfile(profile) {
    this.userProfile = profile;
    this.registerSelfPeer();
    this.broadcastMessage({
      type: 'PEER_ANNOUNCE',
      user: this.getSelfUserPayload()
    });
  }

  getSelfUserPayload() {
    return {
      id: this.userProfile.id,
      name: this.userProfile.name || 'Participante',
      avatar: this.userProfile.avatar || '🦊',
      color: this.userProfile.color || '#6366f1',
      nodeId: this.nodeId,
      lastSeen: Date.now()
    };
  }

  start() {
    this.unloadHandler = () => this.destroy();
    window.addEventListener('beforeunload', this.unloadHandler);

    this.setupBroadcastChannel();
    this.initWssSignaling(0);
    this.startHeartbeat();
  }

  // =========================================================================
  // 1. BROADCAST CHANNEL (Same-browser tabs, 0ms)
  // =========================================================================

  setupBroadcastChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.broadcastChannel = new BroadcastChannel(`freeretro_bc_${this.roomId}`);
      this.broadcastChannel.onmessage = (event) => {
        if (this.destroyed || !event.data) return;
        this.handleIncomingMessage(event.data);
      };
      this.broadcastChannel.postMessage({
        type: 'SYNC_FULL',
        user: this.getSelfUserPayload(),
        session: this.getLocalSession()
      });
    } catch (e) {
      console.warn('BroadcastChannel error:', e);
    }
  }

  // =========================================================================
  // 2. WSS SIGNALING & REAL-TIME SYNC + 3. NATIVE WEBRTC DATA CHANNELS
  // =========================================================================

  initWssSignaling(brokerIndex = 0) {
    if (this.destroyed) return;
    if (typeof window.mqtt === 'undefined') {
      this.setStatus('offline', 'Modo local activo');
      return;
    }

    this.setStatus('connecting', 'Conectando sala P2P...');
    const brokerUrl = WSS_BROKERS[brokerIndex % WSS_BROKERS.length];

    try {
      const client = window.mqtt.connect(brokerUrl, {
        clientId: `fr_${this.nodeId}`,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 6000
      });

      this.mqttClient = client;

      client.on('connect', () => {
        if (this.destroyed) {
          client.end(true);
          return;
        }
        this.mqttConnected = true;
        this.setStatus('online', 'Sala P2P activa');

        // Subscribe to room broadcast topic and our direct WebRTC signaling inbox
        client.subscribe([this.roomTopic, this.signalTopic], { qos: 0 }, (err) => {
          if (!err && !this.destroyed) {
            this.publishWss(this.roomTopic, {
              type: 'SYNC_FULL',
              user: this.getSelfUserPayload(),
              session: this.getLocalSession()
            });
          }
        });
      });

      client.on('message', (topic, payloadBuffer) => {
        if (this.destroyed) return;
        try {
          const msg = JSON.parse(payloadBuffer.toString());
          if (!msg || msg.user?.nodeId === this.nodeId) return;

          if (topic === this.signalTopic) {
            this.handleWebRtcSignal(msg);
          } else if (topic === this.roomTopic) {
            this.handleIncomingMessage(msg, true);
          }
        } catch (e) {
          // Ignore malformed packet
        }
      });

      client.on('error', () => {
        if (this.destroyed) return;
        if (!this.mqttConnected && brokerIndex + 1 < WSS_BROKERS.length) {
          try { client.end(true); } catch (e) {}
          this.initWssSignaling(brokerIndex + 1);
        }
      });
    } catch (e) {
      this.setStatus('offline', 'Guardado local activo');
    }
  }

  publishWss(topic, payload) {
    if (!this.mqttClient || !this.mqttConnected || this.destroyed) return;
    try {
      this.mqttClient.publish(topic, JSON.stringify(payload), { qos: 0 });
    } catch (e) {}
  }

  /**
   * Initiates a direct native WebRTC DataChannel with a discovered peer
   * (Deterministic initiator: node with lexicographically larger nodeId initiates)
   */
  ensureWebRtcConnection(remoteNodeId) {
    if (
      this.destroyed ||
      !remoteNodeId ||
      remoteNodeId === this.nodeId ||
      this.rtcPeers.has(remoteNodeId) ||
      typeof RTCPeerConnection === 'undefined'
    ) {
      return;
    }

    // Only one side initiates the offer to avoid glare
    if (this.nodeId < remoteNodeId) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('freeretro', { ordered: true });
    this.setupDataChannel(remoteNodeId, pc, dc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.publishWss(`freeretro/v1/signal/${this.roomId}/${remoteNodeId}`, {
          type: 'RTC_ICE',
          user: this.getSelfUserPayload(),
          candidate: e.candidate
        });
      }
    };

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        this.publishWss(`freeretro/v1/signal/${this.roomId}/${remoteNodeId}`, {
          type: 'RTC_OFFER',
          user: this.getSelfUserPayload(),
          sdp: pc.localDescription
        });
      })
      .catch(() => {});
  }

  async handleWebRtcSignal(msg) {
    const remoteNodeId = msg.user?.nodeId;
    if (!remoteNodeId || typeof RTCPeerConnection === 'undefined') return;

    try {
      if (msg.type === 'RTC_OFFER') {
        const pc = new RTCPeerConnection(RTC_CONFIG);
        pc.ondatachannel = (event) => {
          this.setupDataChannel(remoteNodeId, pc, event.channel);
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            this.publishWss(`freeretro/v1/signal/${this.roomId}/${remoteNodeId}`, {
              type: 'RTC_ICE',
              user: this.getSelfUserPayload(),
              candidate: e.candidate
            });
          }
        };
        this.rtcPeers.set(remoteNodeId, { pc, dc: null });
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.publishWss(`freeretro/v1/signal/${this.roomId}/${remoteNodeId}`, {
          type: 'RTC_ANSWER',
          user: this.getSelfUserPayload(),
          sdp: pc.localDescription
        });
      } else if (msg.type === 'RTC_ANSWER') {
        const entry = this.rtcPeers.get(remoteNodeId);
        if (entry?.pc && entry.pc.signalingState === 'have-local-offer') {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
      } else if (msg.type === 'RTC_ICE') {
        const entry = this.rtcPeers.get(remoteNodeId);
        if (entry?.pc && msg.candidate) {
          await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      }
    } catch (e) {
      // Ignore transient WebRTC negotiation errors
    }
  }

  setupDataChannel(remoteNodeId, pc, dc) {
    this.rtcPeers.set(remoteNodeId, { pc, dc });

    dc.onopen = () => {
      if (this.destroyed) {
        dc.close();
        return;
      }
      try {
        dc.send(JSON.stringify({
          type: 'SYNC_FULL',
          isReply: true,
          user: this.getSelfUserPayload(),
          session: this.getLocalSession()
        }));
      } catch (e) {}
    };

    dc.onmessage = (event) => {
      if (this.destroyed || !event.data) return;
      try {
        const msg = JSON.parse(event.data);
        this.handleIncomingMessage(msg, false);
      } catch (e) {}
    };

    const cleanup = () => {
      this.rtcPeers.delete(remoteNodeId);
      try { pc.close(); } catch (e) {}
    };

    dc.onclose = cleanup;
    dc.onerror = cleanup;
  }

  // =========================================================================
  // MESSAGE HANDLING & BROADCASTING
  // =========================================================================

  handleIncomingMessage(msg, fromWss = false) {
    if (!msg || !msg.type) return;

    if (msg.user && msg.user.id && msg.user.id !== this.userProfile.id) {
      this.peersInfo.set(msg.user.id, {
        ...msg.user,
        lastSeen: Date.now(),
        isSelf: false
      });
      this.emitPeers();
      this.setStatus('online', `P2P sincronizado (${this.peersInfo.size} en línea)`);

      if (msg.user.nodeId) {
        this.ensureWebRtcConnection(msg.user.nodeId);
      }
    }

    if (msg.type === 'SYNC_FULL' || msg.type === 'STATE_UPDATE') {
      if (msg.session && this.onRemoteState) {
        this.onRemoteState(msg.session);
      }

      if (msg.type === 'SYNC_FULL' && !msg.isReply) {
        const reply = {
          type: 'SYNC_FULL',
          isReply: true,
          user: this.getSelfUserPayload(),
          session: this.getLocalSession()
        };
        if (fromWss) {
          this.publishWss(this.roomTopic, reply);
        } else if (this.broadcastChannel) {
          this.broadcastChannel.postMessage(reply);
        }
      }
    }
  }

  broadcastState() {
    const payload = {
      type: 'STATE_UPDATE',
      user: this.getSelfUserPayload(),
      session: this.getLocalSession()
    };
    this.broadcastMessage(payload);
  }

  broadcastMessage(payload) {
    if (this.destroyed) return;

    // 1. Same-browser tabs
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(payload);
      } catch (e) {}
    }

    // 2. WSS room topic
    this.publishWss(this.roomTopic, payload);

    // 3. Direct WebRTC DataChannels
    const serialized = JSON.stringify(payload);
    for (const { dc } of this.rtcPeers.values()) {
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(serialized);
        } catch (e) {}
      }
    }
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.destroyed) return;
      const now = Date.now();
      this.registerSelfPeer();

      // Prune stale peers (> 25s without heartbeat)
      let changed = false;
      for (const [uid, info] of this.peersInfo.entries()) {
        if (!info.isSelf && now - (info.lastSeen || 0) > 25000) {
          this.peersInfo.delete(uid);
          changed = true;
        }
      }
      if (changed) this.emitPeers();

      this.broadcastMessage({
        type: 'PEER_ANNOUNCE',
        user: this.getSelfUserPayload()
      });
    }, 8000);
  }

  emitPeers() {
    if (this.onPeersChange) {
      this.onPeersChange(Array.from(this.peersInfo.values()));
    }
  }

  setStatus(state, label) {
    if (this.lastLogLabel !== label) {
      this.lastLogLabel = label;
      console.info(`[FreeRetro P2P] (${state}) ${label}`);
    }
    if (this.onStatusChange) {
      this.onStatusChange({ state, label, peerCount: this.peersInfo.size });
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    clearInterval(this.heartbeatTimer);
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (e) {}
      this.broadcastChannel = null;
    }
    if (this.mqttClient) {
      try { this.mqttClient.end(true); } catch (e) {}
      this.mqttClient = null;
    }
    for (const { pc, dc } of this.rtcPeers.values()) {
      try { dc?.close(); } catch (e) {}
      try { pc?.close(); } catch (e) {}
    }
    this.rtcPeers.clear();
  }
}
