/**
 * JBC · signaling.js
 * WebRTC signaling and network bootstrap.
 *
 * What was missing from transport.js:
 *   - addRTCChannel() accepted a DataChannel, but nothing created them.
 *   - No ICE exchange, no offer/answer handshake.
 *   - No bootstrap mechanism to find initial peers.
 *
 * This module provides:
 *   1. SignalingChannel — relays SDP offers/answers + ICE candidates
 *      through whatever channel is available (BroadcastChannel for
 *      same-origin tabs; a URL-based signaling server for cross-origin).
 *
 *   2. RTCPeerManager — manages the full WebRTC lifecycle per peer:
 *      createOffer → sendOffer → receiveAnswer → ICE → DataChannel open.
 *
 *   3. Bootstrap — seed peer discovery from:
 *      a) a static peer list (known DIDs + signaling addresses)
 *      b) a rendezvous endpoint (POST did, GET peers)
 *      c) a BroadcastChannel announce (same-origin only)
 *
 * Integration:
 *   const pm = new RTCPeerManager({ nodeId, transport, signaling });
 *   await pm.bootstrap({ rendezvousUrl, staticPeers });
 *   // From now on, new peers are connected automatically.
 *   // transport.addRTCChannel() is called internally when channels open.
 *
 * Signal message body types (sent via Transport):
 *   consensus.rtc.offer         { sdp, fromId, toId }
 *   consensus.rtc.answer        { sdp, fromId, toId }
 *   consensus.rtc.ice_candidate { candidate, fromId, toId }
 *   consensus.rtc.announce      { fromId, address? }
 */

'use strict';

const RTC_CHANNEL_LABEL = 'jbc-data';

// Default ICE servers — use STUN to discover public IP; add TURN for NAT traversal
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ── SignalingChannel ───────────────────────────────────────────────────────────

class SignalingChannel {
  /**
   * @param {object} opts
   * @param {Transport}  opts.transport  - JBC Transport (for in-band signaling)
   * @param {string}     [opts.serverUrl] - Optional: URL of an out-of-band signaling server
   *                                        POST { type, payload } → 200
   *                                        GET  /peers → [{ id, address }]
   */
  constructor({ transport, serverUrl }) {
    if (!transport) throw new TypeError('SignalingChannel requires transport');
    this._transport  = transport;
    this._serverUrl  = serverUrl ?? null;
    this._handlers   = new Map(); // type → Set<fn(body)>
  }

  /**
   * send(toId, type, payload) → Promise<void>
   * Sends a signaling message to a specific peer.
   * Tries in-band transport first; falls back to HTTP server if configured.
   */
  async send(toId, type, payload) {
    const body = { type, ...payload, fromId: this._transport._nodeId, toId };

    // In-band: send via Transport (BroadcastChannel or existing DataChannel)
    try {
      await this._transport.send(body, null, null, toId);
      return;
    } catch {}

    // Out-of-band: POST to signaling server
    if (this._serverUrl) {
      await fetch(`${this._serverUrl}/signal`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ to: toId, type, payload }),
      }).catch(() => {});
    }
  }

  /**
   * on(type, handler) → SignalingChannel
   */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return this;
  }

  /**
   * _dispatch(type, body) → void
   * Called by RTCPeerManager when it intercepts a signaling envelope.
   */
  _dispatch(type, body) {
    const handlers = this._handlers.get(type) ?? new Set();
    for (const fn of handlers) {
      try { fn(body); } catch {}
    }
  }

  /**
   * fetchPeers() → Promise<Array<{ id, address? }>>
   * Queries the signaling server for known peers.
   */
  async fetchPeers() {
    if (!this._serverUrl) return [];
    try {
      const res = await fetch(`${this._serverUrl}/peers`);
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  }

  /**
   * register(nodeId) → Promise<void>
   * Registers this node with the signaling server so others can find it.
   */
  async register(nodeId, metadata = {}) {
    if (!this._serverUrl) return;
    await fetch(`${this._serverUrl}/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: nodeId, ...metadata }),
    }).catch(() => {});
  }
}

// ── RTCPeerManager ────────────────────────────────────────────────────────────

class RTCPeerManager {
  /**
   * @param {object} opts
   * @param {string}           opts.nodeId     - This node's stable ID
   * @param {Transport}        opts.transport  - JBC Transport instance
   * @param {SignalingChannel} opts.signaling  - SignalingChannel instance
   * @param {RTCConfiguration} [opts.iceConfig] - ICE server config
   * @param {Function}         [opts.onPeer]   - Called with peerId when a peer connects
   * @param {Function}         [opts.onPeerLost] - Called with peerId when a peer disconnects
   */
  constructor({ nodeId, transport, signaling, iceConfig, onPeer, onPeerLost }) {
    if (!nodeId)    throw new TypeError('RTCPeerManager requires nodeId');
    if (!transport) throw new TypeError('RTCPeerManager requires transport');
    if (!signaling) throw new TypeError('RTCPeerManager requires signaling');

    this._nodeId    = nodeId;
    this._transport = transport;
    this._signaling = signaling;
    this._iceConfig = iceConfig ?? { iceServers: DEFAULT_ICE_SERVERS };
    this._onPeer    = onPeer    ?? (() => {});
    this._onPeerLost = onPeerLost ?? (() => {});

    // peerId → { pc: RTCPeerConnection, channel: RTCDataChannel, state }
    this._peers     = new Map();
    // peerId → buffered ICE candidates received before remote description was set
    this._iceBuf    = new Map();

    this._registerSignalingHandlers();
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  /**
   * bootstrap({ rendezvousUrl?, staticPeers?, announceLocal? }) → Promise<void>
   *
   * rendezvousUrl:  URL of a signaling/rendezvous server
   * staticPeers:    [{ id, address? }] — known peer IDs to connect to immediately
   * announceLocal:  true → broadcast a 'consensus.rtc.announce' on BroadcastChannel
   *                 so same-origin tabs can find this node without a server
   */
  async bootstrap({ rendezvousUrl, staticPeers = [], announceLocal = true } = {}) {
    // Register with rendezvous server
    if (rendezvousUrl) {
      this._signaling._serverUrl = rendezvousUrl;
      await this._signaling.register(this._nodeId);
      const serverPeers = await this._signaling.fetchPeers();
      for (const peer of serverPeers) {
        if (peer.id !== this._nodeId && !this._peers.has(peer.id)) {
          staticPeers.push(peer);
        }
      }
    }

    // Connect to static/discovered peers
    for (const peer of staticPeers) {
      if (peer.id !== this._nodeId) {
        this._initiateConnection(peer.id).catch(() => {});
      }
    }

    // Local announce — same-origin tabs answer automatically
    if (announceLocal) {
      try {
        this._transport.send(
          { type: 'consensus.rtc.announce', fromId: this._nodeId },
          null, null, null
        ).catch(() => {});
      } catch {}
    }
  }

  /**
   * connect(peerId) → Promise<RTCDataChannel>
   * Explicitly connect to a specific peer.
   */
  connect(peerId) {
    return this._initiateConnection(peerId);
  }

  /**
   * disconnect(peerId) → void
   */
  disconnect(peerId) {
    const entry = this._peers.get(peerId);
    if (entry) {
      entry.pc.close();
      this._peers.delete(peerId);
      this._onPeerLost(peerId);
    }
  }

  peers() {
    return [...this._peers.keys()];
  }

  isConnected(peerId) {
    const entry = this._peers.get(peerId);
    return entry?.channel?.readyState === 'open';
  }

  // ── Offer/Answer handshake ─────────────────────────────────────────────────

  async _initiateConnection(peerId) {
    if (this._peers.has(peerId)) return this._peers.get(peerId).channel;

    const pc = this._createPeerConnection(peerId);
    const channel = pc.createDataChannel(RTC_CHANNEL_LABEL, {
      ordered:           true,
      maxRetransmits:    3,
    });

    this._peers.set(peerId, { pc, channel, state: 'connecting' });
    this._wireDataChannel(peerId, channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this._signaling.send(peerId, 'consensus.rtc.offer', {
      sdp: offer.sdp,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._peers.delete(peerId);
        reject(new Error(`Connection to ${peerId} timed out`));
      }, 15000);

      channel.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve(channel);
      }, { once: true });
    });
  }

  async _handleOffer({ sdp, fromId }) {
    if (fromId === this._nodeId) return;
    if (this._peers.has(fromId)) return; // already connected

    const pc = this._createPeerConnection(fromId);
    this._peers.set(fromId, { pc, channel: null, state: 'answering' });

    await pc.setRemoteDescription({ type: 'offer', sdp });
    await this._flushIceBuffer(fromId, pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await this._signaling.send(fromId, 'consensus.rtc.answer', { sdp: answer.sdp });

    // DataChannel will be created by the initiating side; we receive it via ondatachannel
    pc.ondatachannel = (e) => {
      const channel = e.channel;
      this._peers.get(fromId).channel = channel;
      this._wireDataChannel(fromId, channel);
    };
  }

  async _handleAnswer({ sdp, fromId }) {
    const entry = this._peers.get(fromId);
    if (!entry) return;

    await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    await this._flushIceBuffer(fromId, entry.pc);
  }

  async _handleIceCandidate({ candidate, fromId }) {
    if (!candidate) return;
    const entry = this._peers.get(fromId);

    if (!entry || !entry.pc.remoteDescription) {
      // Buffer until remote description is set
      if (!this._iceBuf.has(fromId)) this._iceBuf.set(fromId, []);
      this._iceBuf.get(fromId).push(candidate);
      return;
    }

    await entry.pc.addIceCandidate(candidate).catch(() => {});
  }

  async _flushIceBuffer(peerId, pc) {
    const buffered = this._iceBuf.get(peerId) ?? [];
    this._iceBuf.delete(peerId);
    for (const c of buffered) {
      await pc.addIceCandidate(c).catch(() => {});
    }
  }

  // ── RTCPeerConnection factory ──────────────────────────────────────────────

  _createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(this._iceConfig);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._signaling.send(peerId, 'consensus.rtc.ice_candidate', {
          candidate: e.candidate,
        }).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this._peers.delete(peerId);
        this._onPeerLost(peerId);
      }
    };

    return pc;
  }

  _wireDataChannel(peerId, channel) {
    channel.addEventListener('open', () => {
      const entry = this._peers.get(peerId);
      if (entry) entry.state = 'open';
      this._transport.addRTCChannel(peerId, channel);
      this._onPeer(peerId);
    });

    channel.addEventListener('close', () => {
      this._peers.delete(peerId);
      this._onPeerLost(peerId);
    });

    // Messages are handled by the transport's own onmessage wired in addRTCChannel
  }

  // ── Signaling handler registration ────────────────────────────────────────

  _registerSignalingHandlers() {
    // Intercept signaling envelopes from transport
    this._transport.on('consensus.rtc.offer',         (env) => this._handleOffer(env.body));
    this._transport.on('consensus.rtc.answer',        (env) => this._handleAnswer(env.body));
    this._transport.on('consensus.rtc.ice_candidate', (env) => this._handleIceCandidate(env.body));
    this._transport.on('consensus.rtc.announce',      (env) => {
      const { fromId } = env.body;
      if (fromId && fromId !== this._nodeId && !this._peers.has(fromId)) {
        // Someone announced themselves — we initiate the connection
        this._initiateConnection(fromId).catch(() => {});
      }
    });

    // Wire SignalingChannel dispatch into transport handlers (for server-relayed msgs)
    this._signaling.on('consensus.rtc.offer',         (b) => this._handleOffer(b));
    this._signaling.on('consensus.rtc.answer',        (b) => this._handleAnswer(b));
    this._signaling.on('consensus.rtc.ice_candidate', (b) => this._handleIceCandidate(b));
  }
}

// ── Convenience factory ────────────────────────────────────────────────────────

/**
 * createNetworkStack({ nodeId, transport, rendezvousUrl?, staticPeers?, iceConfig?, onPeer?, onPeerLost? })
 *   → Promise<{ signaling, peerManager }>
 *
 * One-call setup: creates SignalingChannel + RTCPeerManager and runs bootstrap.
 */
async function createNetworkStack({ nodeId, transport, rendezvousUrl, staticPeers, iceConfig, onPeer, onPeerLost }) {
  const signaling = new SignalingChannel({ transport, serverUrl: rendezvousUrl });
  const peerManager = new RTCPeerManager({ nodeId, transport, signaling, iceConfig, onPeer, onPeerLost });
  await peerManager.bootstrap({ rendezvousUrl, staticPeers, announceLocal: true });
  return { signaling, peerManager };
}

// ── Export ─────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.SignalingChannel  = SignalingChannel;
  window.JBC.RTCPeerManager    = RTCPeerManager;
  window.JBC.createNetworkStack = createNetworkStack;
}
if (typeof module !== 'undefined') module.exports = { SignalingChannel, RTCPeerManager, createNetworkStack };
