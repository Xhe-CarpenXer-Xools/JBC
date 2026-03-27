/**
 * JBC · signaling.js  (v2 — bootstrap BC fix)
 *
 * ── BUGS FIXED ────────────────────────────────────────────────────────────────
 *
 *   BUG 1 — Circular dependency (root cause of "peers never connect")
 *     Old: SignalingChannel.send() → transport.send() → needs WebRTC route
 *          But WebRTC route requires SignalingChannel to work first.
 *     Fix: Dedicated raw BroadcastChannel('jbc-signal:v1') is always open and
 *          always reachable for same-origin tabs, with NO envelope wrapping.
 *          This is tried FIRST, before transport. Bypasses the circular dep.
 *
 *   BUG 2 — Unsigned envelopes silently rejected
 *     Old: transport.send(body, null, null, toId)  → sig:null
 *          transport.receive() rejects "unsigned envelope rejected" (empty catch)
 *     Fix: Signaling no longer uses transport envelopes for delivery.
 *          Raw JSON over BC is not subject to transport signature validation.
 *
 *   BUG 3 — Offer collision / deadlock
 *     Old: Both peers received each other's announce simultaneously and both
 *          called _initiateConnection(). No tie-breaking → glare → deadlock.
 *     Fix: Deterministic rule: only the peer with the HIGHER nodeId initiates
 *          on receiving an announce. Lower-ID peer always answers.
 *          _handleOffer() also handles late glare via ID-based tie-breaking.
 *
 *   BUG 4 — signaling.js never loaded (file missing from index.html script tags)
 *     Fix: <script src="core/signaling.js"> added to index.html after transport.js
 *
 * ── Delivery layers (in order) ────────────────────────────────────────────────
 *   1. Bootstrap BroadcastChannel  — raw JSON, always works before WebRTC
 *   2. WebRTC DataChannel in-band  — used post-connection (via _transport._rtc)
 *   3. HTTP signaling server       — optional, for cross-origin / cross-device
 *
 * ── Integration (API unchanged) ───────────────────────────────────────────────
 *   const { signaling, peerManager } = await JBC.createNetworkStack({
 *     nodeId, transport, onPeer: (id) => log('connected', id),
 *   });
 *
 * Signal message types (raw JSON over bootstrap BC):
 *   consensus.rtc.announce      { type, fromId, toId }
 *   consensus.rtc.offer         { type, fromId, toId, sdp }
 *   consensus.rtc.answer        { type, fromId, toId, sdp }
 *   consensus.rtc.ice_candidate { type, fromId, toId, candidate }
 */

'use strict';

const RTC_CHANNEL_LABEL  = 'jbc-data';
const BOOTSTRAP_BC_NAME  = 'jbc-signal:v1';
const CONNECTION_TIMEOUT = 20_000;

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ── SignalingChannel ───────────────────────────────────────────────────────────

class SignalingChannel {
  constructor({ transport, serverUrl } = {}) {
    if (!transport) throw new TypeError('SignalingChannel requires transport');
    this._transport = transport;
    this._serverUrl = serverUrl ?? null;
    this._handlers  = new Map();

    // ── Bootstrap BroadcastChannel ──────────────────────────────────────────
    // Plain JSON only. NOT routed through Transport envelopes.
    // This is the ONLY path that exists before any WebRTC connection.
    this._bc = null;
    try {
      this._bc = new BroadcastChannel(BOOTSTRAP_BC_NAME);
      this._bc.onmessage = (e) => {
        const msg = e.data;
        if (!msg?.type || !msg?.fromId) return;
        if (msg.fromId === this._transport._nodeId) return; // own message
        this._dispatch(msg.type, msg);
      };
    } catch (err) {
      console.warn('[JBC signal] BroadcastChannel unavailable:', err.message);
    }
  }

  /**
   * send(toId, type, payload)
   *
   * 1. Bootstrap BC  — always; toId=null broadcasts to all same-origin tabs
   * 2. Open DataChannel — in-band, once connected
   * 3. HTTP server — if configured
   */
  async send(toId, type, payload) {
    const msg = {
      type,
      fromId: this._transport._nodeId,
      toId:   toId ?? null,
      ...payload,
    };

    // 1. Bootstrap BC (primary path — works before WebRTC)
    try { this._bc?.postMessage(msg); } catch {}

    // 2. In-band via open DataChannel (post-connection upgrade)
    if (toId) {
      const ch = this._transport._rtc?.get(toId);
      if (ch?.readyState === 'open') {
        try { ch.send(JSON.stringify({ _signaling: true, ...msg })); } catch {}
      }
    }

    // 3. HTTP fallback
    if (this._serverUrl) {
      await fetch(`${this._serverUrl}/signal`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ to: toId, type, payload: msg }),
      }).catch(() => {});
    }
  }

  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return this;
  }

  _dispatch(type, body) {
    for (const fn of (this._handlers.get(type) ?? new Set())) {
      try { fn(body); } catch (err) { console.warn('[JBC signal] handler error:', err); }
    }
  }

  destroy() {
    try { this._bc?.close(); } catch {}
    this._bc = null;
  }

  async fetchPeers() {
    if (!this._serverUrl) return [];
    try { const r = await fetch(`${this._serverUrl}/peers`); return r.ok ? r.json() : []; }
    catch { return []; }
  }

  async register(nodeId, meta = {}) {
    if (!this._serverUrl) return;
    await fetch(`${this._serverUrl}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: nodeId, ...meta }),
    }).catch(() => {});
  }
}

// ── RTCPeerManager ────────────────────────────────────────────────────────────

class RTCPeerManager {
  constructor({ nodeId, transport, signaling, iceConfig, onPeer, onPeerLost }) {
    if (!nodeId)    throw new TypeError('RTCPeerManager requires nodeId');
    if (!transport) throw new TypeError('RTCPeerManager requires transport');
    if (!signaling) throw new TypeError('RTCPeerManager requires signaling');

    this._nodeId     = nodeId;
    this._transport  = transport;
    this._signaling  = signaling;
    this._iceConfig  = iceConfig ?? { iceServers: DEFAULT_ICE_SERVERS };
    this._onPeer     = onPeer     ?? (() => {});
    this._onPeerLost = onPeerLost ?? (() => {});
    this._peers      = new Map();  // peerId → { pc, channel, state }
    this._iceBuf     = new Map();  // peerId → ICECandidate[]

    this._registerSignalingHandlers();

    // Intercept in-band signaling messages that arrive over open DataChannels
    this._transport.on('*', (envelope) => {
      const b = envelope.body;
      if (b?._signaling && b?.type?.startsWith('consensus.rtc.')) {
        this._signaling._dispatch(b.type, b);
      }
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  async bootstrap({ rendezvousUrl, staticPeers = [], announceLocal = true } = {}) {
    if (rendezvousUrl) {
      this._signaling._serverUrl = rendezvousUrl;
      await this._signaling.register(this._nodeId);
      const serverPeers = await this._signaling.fetchPeers();
      for (const p of serverPeers) {
        if (p.id !== this._nodeId && !this._peers.has(p.id)) staticPeers.push(p);
      }
    }

    // Initiate to explicitly known static peers (we always win initiator role here)
    for (const p of staticPeers) {
      if (p.id !== this._nodeId) this._initiateConnection(p.id).catch(() => {});
    }

    // Announce via raw BroadcastChannel so other same-origin tabs discover us.
    // This is plain JSON — NOT a Transport envelope, so no sig required.
    if (announceLocal) {
      try {
        this._signaling._bc?.postMessage({
          type:   'consensus.rtc.announce',
          fromId: this._nodeId,
          toId:   null,
        });
      } catch {}
    }
  }

  connect(peerId)    { return this._initiateConnection(peerId); }
  disconnect(peerId) {
    const e = this._peers.get(peerId);
    if (e) { e.pc.close(); this._peers.delete(peerId); this._onPeerLost(peerId); }
  }
  peers()            { return [...this._peers.keys()]; }
  isConnected(id)    { return this._peers.get(id)?.channel?.readyState === 'open'; }

  // ── Handshake ─────────────────────────────────────────────────────────────

  async _initiateConnection(peerId) {
    const existing = this._peers.get(peerId);
    if (existing?.state === 'open') return existing.channel;
    if (existing?.state === 'connecting') {
      // Already in progress — wait on the same channel object
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), CONNECTION_TIMEOUT);
        existing.channel?.addEventListener('open', () => { clearTimeout(t); resolve(existing.channel); }, { once: true });
      });
    }

    const pc      = this._createPeerConnection(peerId);
    const channel = pc.createDataChannel(RTC_CHANNEL_LABEL, { ordered: true, maxRetransmits: 3 });

    this._peers.set(peerId, { pc, channel, state: 'connecting' });
    this._wireDataChannel(peerId, channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._signaling.send(peerId, 'consensus.rtc.offer', { sdp: offer.sdp });

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this._peers.get(peerId)?.state !== 'open') {
          this._peers.delete(peerId);
          reject(new Error(`WebRTC timeout to ${peerId}`));
        }
      }, CONNECTION_TIMEOUT);
      channel.addEventListener('open', () => { clearTimeout(t); resolve(channel); }, { once: true });
    });
  }

  async _handleOffer({ sdp, fromId, toId }) {
    if (toId && toId !== this._nodeId) return;
    if (fromId === this._nodeId) return;

    // ── Glare resolution ────────────────────────────────────────────────────
    // Both peers called _initiateConnection simultaneously. The peer with the
    // LOWER nodeId yields: it drops its half-open PC and processes the offer.
    // The peer with the HIGHER nodeId ignores the offer (its own offer wins).
    if (this._peers.has(fromId)) {
      const e = this._peers.get(fromId);
      if (e.state === 'connecting') {
        if (this._nodeId < fromId) {
          // We are lower → yield to their offer
          e.pc.close();
          this._peers.delete(fromId);
          // fall through
        } else {
          // We are higher → our offer wins, ignore theirs
          return;
        }
      } else {
        return; // answering or open — ignore duplicate
      }
    }

    const pc = this._createPeerConnection(fromId);
    this._peers.set(fromId, { pc, channel: null, state: 'answering' });

    await pc.setRemoteDescription({ type: 'offer', sdp });
    await this._flushIceBuffer(fromId, pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._signaling.send(fromId, 'consensus.rtc.answer', { sdp: answer.sdp });

    pc.ondatachannel = (e) => {
      const ch    = e.channel;
      const entry = this._peers.get(fromId);
      if (entry) entry.channel = ch;
      this._wireDataChannel(fromId, ch);
    };
  }

  async _handleAnswer({ sdp, fromId, toId }) {
    if (toId && toId !== this._nodeId) return;
    const e = this._peers.get(fromId);
    if (!e) return;
    await e.pc.setRemoteDescription({ type: 'answer', sdp });
    await this._flushIceBuffer(fromId, e.pc);
  }

  async _handleIceCandidate({ candidate, fromId, toId }) {
    if (toId && toId !== this._nodeId) return;
    if (!candidate) return;
    const e = this._peers.get(fromId);
    if (!e || !e.pc.remoteDescription) {
      if (!this._iceBuf.has(fromId)) this._iceBuf.set(fromId, []);
      this._iceBuf.get(fromId).push(candidate);
      return;
    }
    await e.pc.addIceCandidate(candidate).catch(() => {});
  }

  async _flushIceBuffer(peerId, pc) {
    const buf = this._iceBuf.get(peerId) ?? [];
    this._iceBuf.delete(peerId);
    for (const c of buf) await pc.addIceCandidate(c).catch(() => {});
  }

  // ── RTCPeerConnection ──────────────────────────────────────────────────────

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
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this._peers.delete(peerId);
        this._onPeerLost(peerId);
      }
    };

    return pc;
  }

  _wireDataChannel(peerId, channel) {
    channel.addEventListener('open', () => {
      const e = this._peers.get(peerId);
      if (e) e.state = 'open';
      this._transport.addRTCChannel(peerId, channel);
      this._onPeer(peerId);
    });
    channel.addEventListener('close', () => {
      this._peers.delete(peerId);
      this._onPeerLost(peerId);
    });
  }

  // ── Handler wiring ─────────────────────────────────────────────────────────

  _registerSignalingHandlers() {
    const s = this._signaling;

    s.on('consensus.rtc.offer',         (b) => this._handleOffer(b));
    s.on('consensus.rtc.answer',        (b) => this._handleAnswer(b));
    s.on('consensus.rtc.ice_candidate', (b) => this._handleIceCandidate(b));

    s.on('consensus.rtc.announce', ({ fromId, toId }) => {
      if (toId && toId !== this._nodeId) return;
      if (!fromId || fromId === this._nodeId) return;
      if (this._peers.has(fromId)) return;

      // ── Deterministic initiator ────────────────────────────────────────────
      // Only the HIGHER-ID peer initiates. This prevents both sides from
      // calling _initiateConnection() simultaneously on announce receipt.
      if (this._nodeId > fromId) {
        this._initiateConnection(fromId).catch(() => {});
      }
      // Lower-ID peer waits for the inbound offer from the higher-ID peer.
    });
  }
}

// ── Convenience factory ────────────────────────────────────────────────────────

async function createNetworkStack({
  nodeId, transport, rendezvousUrl, staticPeers,
  iceConfig, onPeer, onPeerLost,
}) {
  const signaling   = new SignalingChannel({ transport, serverUrl: rendezvousUrl });
  const peerManager = new RTCPeerManager({
    nodeId, transport, signaling, iceConfig, onPeer, onPeerLost,
  });
  await peerManager.bootstrap({ rendezvousUrl, staticPeers, announceLocal: true });
  return { signaling, peerManager };
}

// ── Export ─────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.SignalingChannel   = SignalingChannel;
  window.JBC.RTCPeerManager     = RTCPeerManager;
  window.JBC.createNetworkStack = createNetworkStack;
}
if (typeof module !== 'undefined') {
  module.exports = { SignalingChannel, RTCPeerManager, createNetworkStack };
}
