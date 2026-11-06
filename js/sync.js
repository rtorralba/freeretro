/**
 * FreeRetro - P2P Collaborative Engine (WebRTC via PeerJS + BroadcastChannel)
 *
 * Architecture:
 * 1. Deterministic Room Hub Election:
 *    - Every room has a deterministic Hub ID: `freeretro-hub-${roomId}`.
 *    - When a user joins, they first attempt to claim the Hub ID on PeerJS.
 *    - If available, this user acts as the Room Hub (accepts connections from all peers,
 *      merges CRDT state, broadcasts updates, and shares the peer list).
 *    - If taken (`unavailable-id`), the user registers a unique client ID and connects to the Hub,
 *      plus connects directly to other peers in the room (hybrid mesh).
 *    - If the Hub disconnects, remaining peers automatically attempt to claim the Hub ID so the room stays alive!
 * 2. BroadcastChannel Fallback:
 *    - Synchronizes tabs in the same browser in 0ms even without internet.
 * 3. Automatic Offline/Pre-Session Merge:
 *    - Any cards created hours before the meeting in `localStorage` are merged automatically
 *      via CRDT `mergeSessions()` the moment two peers connect.
 */

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

    this.hubPeerId = `freeretro-v1-hub-${this.roomId}`;
    this.peer = null;
    this.isHub = false;
    this.connections = new Map(); // peerId -> DataConnection
    this.peersInfo = new Map();   // userId -> { id, name, color, peerId, lastSeen, isSelf }
    this.broadcastChannel = null;
    this.destroyed = false;
    this.reconnectTimer = null;
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
      color: this.userProfile.color || '#6366f1',
      peerId: 'local',
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
      color: this.userProfile.color || '#6366f1',
      peerId: this.peer?.id || 'local',
      lastSeen: Date.now()
    };
  }

  start() {
    this.setupBroadcastChannel();
    this.initPeerJS(true);
    this.startHeartbeat();
  }

  setupBroadcastChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.broadcastChannel = new BroadcastChannel(`freeretro_bc_${this.roomId}`);
      this.broadcastChannel.onmessage = (event) => {
        if (this.destroyed || !event.data) return;
        this.handleIncomingMessage(event.data, null);
      };
      // Announce presence & state to same-browser tabs immediately
      this.broadcastChannel.postMessage({
        type: 'SYNC_FULL',
        user: this.getSelfUserPayload(),
        session: this.getLocalSession(),
        knownPeers: []
      });
    } catch (e) {
      console.warn('BroadcastChannel error:', e);
    }
  }

  initPeerJS(tryAsHub = true) {
    if (this.destroyed) return;
    if (typeof window.Peer === 'undefined') {
      this.setStatus('offline', 'Modo local (PeerJS no disponible)');
      return;
    }

    this.cleanupPeerInstance();
    this.setStatus('connecting', 'Conectando P2P...');

    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const targetId = tryAsHub
      ? this.hubPeerId
      : `freeretro-v1-peer-${this.roomId}-${randomSuffix}`;

    try {
      const peer = new window.Peer(targetId, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      this.peer = peer;

      peer.on('open', (id) => {
        if (this.destroyed) return;
        this.isHub = (id === this.hubPeerId);
        this.registerSelfPeer();

        if (this.isHub) {
          this.setStatus('online', 'Sala P2P activa (Coordinador)');
        } else {
          this.setStatus('online', 'Conectado a sala P2P');
          this.connectToPeer(this.hubPeerId);
        }
      });

      peer.on('connection', (conn) => {
        this.setupConnection(conn);
      });

      peer.on('error', (err) => {
        if (this.destroyed) return;
        if (err.type === 'unavailable-id' && tryAsHub) {
          // Someone else is already the Hub for this room! Connect as a regular peer.
          this.initPeerJS(false);
          return;
        }
        if (err.type === 'peer-unavailable') {
          // If we tried connecting to the Hub and it's gone, try becoming the Hub!
          if (!this.isHub && !this.connections.has(this.hubPeerId)) {
            this.scheduleHubPromotion();
          }
          return;
        }
        console.warn('PeerJS notice:', err.type, err.message);
        if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
          this.setStatus('reconnecting', 'Reconectando P2P...');
          this.scheduleReconnect();
        }
      });

      peer.on('disconnected', () => {
        if (this.destroyed) return;
        this.setStatus('reconnecting', 'Reconectando...');
        try {
          peer.reconnect();
        } catch (e) {
          this.scheduleReconnect();
        }
      });
    } catch (e) {
      console.warn('Failed to initialize PeerJS:', e);
      this.setStatus('offline', 'Guardado local activo');
    }
  }

  scheduleHubPromotion() {
    clearTimeout(this.reconnectTimer);
    // Random jitter (400-1200ms) so multiple peers don't collide at the exact millisecond
    const delay = 400 + Math.floor(Math.random() * 800);
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed && !this.isHub && !this.connections.has(this.hubPeerId)) {
        this.initPeerJS(true);
      }
    }, delay);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.initPeerJS(true);
      }
    }, 4000);
  }

  connectToPeer(remotePeerId) {
    if (
      this.destroyed ||
      !this.peer ||
      !this.peer.open ||
      !remotePeerId ||
      remotePeerId === 'local' ||
      remotePeerId === this.peer.id ||
      this.connections.has(remotePeerId)
    ) {
      return;
    }

    try {
      const conn = this.peer.connect(remotePeerId, { reliable: true });
      this.setupConnection(conn);
    } catch (e) {
      console.warn('Could not connect to peer:', remotePeerId, e);
    }
  }

  setupConnection(conn) {
    if (!conn) return;

    conn.on('open', () => {
      if (this.destroyed) {
        conn.close();
        return;
      }
      this.connections.set(conn.peer, conn);
      this.setStatus('online', `P2P sincronizado (${this.connections.size + 1} en línea)`);

      // Immediately exchange full CRDT state + known peer list
      conn.send({
        type: 'SYNC_FULL',
        user: this.getSelfUserPayload(),
        session: this.getLocalSession(),
        knownPeers: Array.from(this.connections.keys())
      });
    });

    conn.on('data', (data) => {
      if (this.destroyed || !data) return;
      this.handleIncomingMessage(data, conn);
    });

    const handleClose = () => {
      this.connections.delete(conn.peer);
      // Remove peer info associated with this peerId
      for (const [uid, info] of this.peersInfo.entries()) {
        if (!info.isSelf && info.peerId === conn.peer) {
          this.peersInfo.delete(uid);
        }
      }
      this.emitPeers();

      if (!this.destroyed) {
        if (conn.peer === this.hubPeerId && !this.isHub) {
          // Hub disconnected; try to become the new Hub
          this.scheduleHubPromotion();
        } else {
          this.setStatus(
            'online',
            this.connections.size > 0
              ? `P2P sincronizado (${this.connections.size + 1} en línea)`
              : 'Sala P2P lista'
          );
        }
      }
    };

    conn.on('close', handleClose);
    conn.on('error', handleClose);
  }

  handleIncomingMessage(msg, sourceConn) {
    if (!msg || !msg.type) return;

    if (msg.user && msg.user.id && msg.user.id !== this.userProfile.id) {
      this.peersInfo.set(msg.user.id, {
        ...msg.user,
        lastSeen: Date.now(),
        isSelf: false
      });
      this.emitPeers();
    }

    if (msg.type === 'SYNC_FULL' || msg.type === 'STATE_UPDATE') {
      if (msg.session && this.onRemoteState) {
        this.onRemoteState(msg.session);
      }

      // Connect to any additional peers shared by the Hub (mesh resilience)
      if (Array.isArray(msg.knownPeers)) {
        msg.knownPeers.forEach(pid => this.connectToPeer(pid));
      }

      // If we are the Hub and received an update from one peer, relay it to other connected peers
      if (this.isHub && sourceConn) {
        const relayPayload = {
          type: 'STATE_UPDATE',
          user: msg.user,
          session: this.getLocalSession(),
          knownPeers: Array.from(this.connections.keys())
        };
        for (const [peerId, conn] of this.connections.entries()) {
          if (peerId !== sourceConn.peer && conn.open) {
            conn.send(relayPayload);
          }
        }
      }

      // Also reply with our merged state on initial SYNC_FULL if needed
      if (msg.type === 'SYNC_FULL' && !msg.isReply) {
        const reply = {
          type: 'SYNC_FULL',
          isReply: true,
          user: this.getSelfUserPayload(),
          session: this.getLocalSession(),
          knownPeers: Array.from(this.connections.keys())
        };
        if (sourceConn && sourceConn.open) {
          sourceConn.send(reply);
        } else if (this.broadcastChannel) {
          this.broadcastChannel.postMessage(reply);
        }
      }
    } else if (msg.type === 'PEER_ANNOUNCE') {
      if (this.isHub && sourceConn) {
        for (const [peerId, conn] of this.connections.entries()) {
          if (peerId !== sourceConn.peer && conn.open) {
            conn.send(msg);
          }
        }
      }
    }
  }

  /**
   * Broadcast current session state to all connected WebRTC peers & local tabs
   */
  broadcastState() {
    const payload = {
      type: 'STATE_UPDATE',
      user: this.getSelfUserPayload(),
      session: this.getLocalSession(),
      knownPeers: Array.from(this.connections.keys())
    };
    this.broadcastMessage(payload);
  }

  broadcastMessage(payload) {
    if (this.destroyed) return;

    // 1. Send via BroadcastChannel (same browser tabs)
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(payload);
      } catch (e) {
        // Ignore
      }
    }

    // 2. Send via WebRTC DataConnections
    for (const conn of this.connections.values()) {
      if (conn && conn.open) {
        try {
          conn.send(payload);
        } catch (e) {
          console.warn('Error sending to peer:', e);
        }
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

      // Send lightweight heartbeat
      this.broadcastMessage({
        type: 'PEER_ANNOUNCE',
        user: this.getSelfUserPayload()
      });

      // If we are not the Hub and have no connection to the Hub, periodically retry
      if (!this.isHub && this.peer?.open && !this.connections.has(this.hubPeerId)) {
        this.connectToPeer(this.hubPeerId);
      }
    }, 8000);
  }

  emitPeers() {
    if (this.onPeersChange) {
      this.onPeersChange(Array.from(this.peersInfo.values()));
    }
  }

  setStatus(state, label) {
    if (this.onStatusChange) {
      this.onStatusChange({ state, label, peerCount: this.peersInfo.size });
    }
  }

  cleanupPeerInstance() {
    for (const conn of this.connections.values()) {
      try { conn.close(); } catch (e) {}
    }
    this.connections.clear();
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (e) {}
      this.broadcastChannel = null;
    }
    this.cleanupPeerInstance();
  }
}

