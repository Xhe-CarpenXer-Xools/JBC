/**
 * JBC · consensus.js
 * Raft-lite consensus layer.
 *
 * Provides:
 *   - Leader election (term-based, majority required)
 *   - Log replication agreement (entries only committed when majority acks)
 *   - Divergence prevention: followers reject AppendEntry if prev-hash mismatches
 *   - Heartbeat liveness: missing heartbeat triggers election
 *
 * Role lifecycle:
 *   FOLLOWER → (timeout) → CANDIDATE → (majority votes) → LEADER
 *   LEADER   → (higher term seen) → FOLLOWER
 *
 * Wire messages (sent via Transport envelope body):
 *   { type: 'consensus.vote_request',  term, candidateId, lastLogIndex, lastLogHash }
 *   { type: 'consensus.vote_response', term, granted, voterId }
 *   { type: 'consensus.append',        term, leaderId, prevIndex, prevHash, entries[], commitIndex }
 *   { type: 'consensus.append_ack',    term, followerId, success, matchIndex }
 *   { type: 'consensus.heartbeat',     term, leaderId, commitIndex }
 */

'use strict';

const ROLE = Object.freeze({ FOLLOWER: 'follower', CANDIDATE: 'candidate', LEADER: 'leader' });

// Randomised election timeout: 150–300ms (standard Raft recommendation)
function electionTimeout() {
  return 150 + Math.floor(Math.random() * 150);
}
const HEARTBEAT_MS = 50;

class ConsensusEngine {
  /**
   * @param {object} opts
   * @param {string}    opts.nodeId         - This node's stable DID/ID
   * @param {string[]}  opts.peers          - All peer node IDs (including self)
   * @param {Transport} opts.transport      - JBC Transport instance
   * @param {Ledger}    opts.ledger         - JBC Ledger instance
   * @param {Function}  [opts.onCommit]     - Called with entry when majority committed
   * @param {Function}  [opts.onLeaderChange] - Called with { leader, term } on change
   */
  constructor({ nodeId, peers, transport, ledger, onCommit, onLeaderChange }) {
    if (!nodeId)    throw new TypeError('ConsensusEngine requires nodeId');
    if (!peers?.length) throw new TypeError('ConsensusEngine requires peers[]');
    if (!transport) throw new TypeError('ConsensusEngine requires transport');
    if (!ledger)    throw new TypeError('ConsensusEngine requires ledger');

    this._nodeId    = nodeId;
    this._peers     = new Set(peers);
    this._transport = transport;
    this._ledger    = ledger;
    this._onCommit  = onCommit    ?? (() => {});
    this._onLeaderChange = onLeaderChange ?? (() => {});

    // Raft state
    this._role        = ROLE.FOLLOWER;
    this._term        = 0;
    this._votedFor    = null;        // nodeId we voted for in current term
    this._leader      = null;        // known current leader
    this._votes       = new Set();   // votes received as candidate

    // Log state (mirrors ledger but consensus-tracked)
    this._log         = [];          // [{ index, term, entry }]
    this._commitIndex = -1;          // highest index known committed
    this._lastApplied = -1;          // highest index applied to state machine

    // Leader-only: per-follower replication state
    this._nextIndex   = new Map();   // followerId → next log index to send
    this._matchIndex  = new Map();   // followerId → highest index known replicated

    // Pending proposals waiting for commit ack
    this._pendingProposals = new Map(); // index → { resolve, reject, entry }

    // Timers
    this._electionTimer   = null;
    this._heartbeatTimer  = null;

    this._registerHandlers();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * start() → ConsensusEngine
   * Begin participating in consensus. Starts election timeout.
   */
  start() {
    this._resetElectionTimer();
    return this;
  }

  /**
   * stop() → void
   */
  stop() {
    clearTimeout(this._electionTimer);
    clearInterval(this._heartbeatTimer);
  }

  /**
   * propose(entry) → Promise<entry>
   * Leader proposes an entry for consensus. Resolves when majority committed.
   * Throws if not leader.
   */
  propose(entry) {
    if (this._role !== ROLE.LEADER) {
      return Promise.reject(new Error(`Not leader. Current leader: ${this._leader ?? 'unknown'}`));
    }

    return new Promise((resolve, reject) => {
      const index = this._log.length;
      const logEntry = { index, term: this._term, entry };
      this._log.push(logEntry);

      // Leader counts itself
      this._matchIndex.set(this._nodeId, index);
      this._pendingProposals.set(index, { resolve, reject, entry });

      // Immediately try to replicate to all followers
      this._replicateToAll();

      // Check if we already have majority (single-node cluster)
      this._tryAdvanceCommit();
    });
  }

  /**
   * status() → object
   * Returns current consensus status.
   */
  status() {
    return {
      nodeId:      this._nodeId,
      role:        this._role,
      term:        this._term,
      leader:      this._leader,
      commitIndex: this._commitIndex,
      logSize:     this._log.length,
      peers:       [...this._peers],
    };
  }

  isLeader()   { return this._role === ROLE.LEADER;    }
  isFollower() { return this._role === ROLE.FOLLOWER;  }
  getLeader()  { return this._leader; }
  getTerm()    { return this._term;   }

  // ── Internal: Election ─────────────────────────────────────────────────────

  _resetElectionTimer() {
    clearTimeout(this._electionTimer);
    this._electionTimer = setTimeout(() => this._startElection(), electionTimeout());
  }

  _startElection() {
    if (this._role === ROLE.LEADER) return;

    this._term++;
    this._role     = ROLE.CANDIDATE;
    this._votedFor = this._nodeId;
    this._votes    = new Set([this._nodeId]); // vote for self
    this._leader   = null;

    const lastLog = this._log[this._log.length - 1];
    const req = {
      type:         'consensus.vote_request',
      term:          this._term,
      candidateId:   this._nodeId,
      lastLogIndex:  lastLog?.index ?? -1,
      lastLogHash:   lastLog?.entry?.hash ?? null,
    };

    for (const peer of this._peers) {
      if (peer !== this._nodeId) {
        this._send(peer, req);
      }
    }

    this._resetElectionTimer();
  }

  _handleVoteRequest(envelope) {
    const { term, candidateId, lastLogIndex, lastLogHash } = envelope.body;
    let granted = false;

    // Update term if stale
    if (term > this._term) {
      this._stepDown(term);
    }

    const myLastLog  = this._log[this._log.length - 1];
    const myLastIdx  = myLastLog?.index ?? -1;
    const logOk      = lastLogIndex >= myLastIdx; // candidate at least as up-to-date

    if (
      term === this._term &&
      logOk &&
      (this._votedFor === null || this._votedFor === candidateId)
    ) {
      granted          = true;
      this._votedFor   = candidateId;
      this._resetElectionTimer(); // back off — a real candidate is running
    }

    this._send(candidateId, {
      type:    'consensus.vote_response',
      term:    this._term,
      granted,
      voterId: this._nodeId,
    });
  }

  _handleVoteResponse(envelope) {
    const { term, granted, voterId } = envelope.body;

    if (term > this._term) { this._stepDown(term); return; }
    if (this._role !== ROLE.CANDIDATE) return;
    if (term !== this._term) return;

    if (granted) {
      this._votes.add(voterId);
      if (this._votes.size >= this._majority()) {
        this._becomeLeader();
      }
    }
  }

  // ── Internal: Replication ──────────────────────────────────────────────────

  _becomeLeader() {
    if (this._role === ROLE.LEADER) return;
    this._role   = ROLE.LEADER;
    this._leader = this._nodeId;
    clearTimeout(this._electionTimer);

    // Initialise replication state for each follower
    const nextIdx = this._log.length;
    for (const peer of this._peers) {
      if (peer !== this._nodeId) {
        this._nextIndex.set(peer, nextIdx);
        this._matchIndex.set(peer, -1);
      }
    }

    this._onLeaderChange({ leader: this._nodeId, term: this._term });

    // Start heartbeat loop
    this._heartbeatTimer = setInterval(() => this._sendHeartbeats(), HEARTBEAT_MS);
    this._sendHeartbeats();
  }

  _stepDown(term) {
    clearInterval(this._heartbeatTimer);
    this._role      = ROLE.FOLLOWER;
    this._term      = term;
    this._votedFor  = null;
    this._votes     = new Set();
    this._resetElectionTimer();
  }

  _sendHeartbeats() {
    for (const peer of this._peers) {
      if (peer !== this._nodeId) {
        this._sendAppend(peer);
      }
    }
  }

  _replicateToAll() {
    for (const peer of this._peers) {
      if (peer !== this._nodeId) {
        this._sendAppend(peer);
      }
    }
  }

  _sendAppend(followerId) {
    const nextIdx = this._nextIndex.get(followerId) ?? this._log.length;
    const prevIdx = nextIdx - 1;
    const prev    = prevIdx >= 0 ? this._log[prevIdx] : null;
    const entries = this._log.slice(nextIdx); // entries follower needs

    this._send(followerId, {
      type:        'consensus.append',
      term:        this._term,
      leaderId:    this._nodeId,
      prevIndex:   prevIdx,
      prevHash:    prev?.entry?.hash ?? null,
      entries,
      commitIndex: this._commitIndex,
    });
  }

  _handleAppend(envelope) {
    const { term, leaderId, prevIndex, prevHash, entries, commitIndex } = envelope.body;

    // Reject stale leader
    if (term < this._term) {
      this._send(leaderId, {
        type:       'consensus.append_ack',
        term:       this._term,
        followerId: this._nodeId,
        success:    false,
        matchIndex: -1,
      });
      return;
    }

    // Update term and recognise leader
    if (term > this._term) this._stepDown(term);
    this._leader = leaderId;
    this._role   = ROLE.FOLLOWER;
    this._resetElectionTimer(); // valid heartbeat

    // Consistency check: our log must match leader's prev entry
    if (prevIndex >= 0) {
      const myPrev = this._log[prevIndex];
      if (!myPrev || myPrev.entry?.hash !== prevHash) {
        // Log divergence — reject, leader will back up nextIndex
        this._send(leaderId, {
          type:       'consensus.append_ack',
          term:       this._term,
          followerId: this._nodeId,
          success:    false,
          matchIndex: this._log.length - 1,
        });
        return;
      }
    }

    // Append new entries (truncate any conflicting suffix first)
    if (entries && entries.length > 0) {
      const insertAt = prevIndex + 1;
      this._log.splice(insertAt); // truncate diverging tail
      for (const e of entries) {
        this._log.push(e);
      }
    }

    // Advance commit
    if (commitIndex > this._commitIndex) {
      this._commitIndex = Math.min(commitIndex, this._log.length - 1);
      this._applyCommitted();
    }

    this._send(leaderId, {
      type:       'consensus.append_ack',
      term:       this._term,
      followerId: this._nodeId,
      success:    true,
      matchIndex: this._log.length - 1,
    });
  }

  _handleAppendAck(envelope) {
    const { term, followerId, success, matchIndex } = envelope.body;

    if (term > this._term) { this._stepDown(term); return; }
    if (this._role !== ROLE.LEADER) return;

    if (success) {
      this._matchIndex.set(followerId, matchIndex);
      this._nextIndex.set(followerId, matchIndex + 1);
      this._tryAdvanceCommit();
    } else {
      // Back up nextIndex and retry
      const next = (this._nextIndex.get(followerId) ?? 1) - 1;
      this._nextIndex.set(followerId, Math.max(0, next));
      this._sendAppend(followerId);
    }
  }

  /**
   * Advance commitIndex to the highest N where a majority have matchIndex >= N.
   */
  _tryAdvanceCommit() {
    if (this._role !== ROLE.LEADER) return;

    const indices = [...this._matchIndex.values()].sort((a, b) => b - a);
    const majorityIdx = indices[this._majority() - 1] ?? -1;

    if (majorityIdx > this._commitIndex) {
      // Only commit entries from current term (Raft safety)
      if (this._log[majorityIdx]?.term === this._term) {
        this._commitIndex = majorityIdx;
        this._applyCommitted();
      }
    }
  }

  _applyCommitted() {
    while (this._lastApplied < this._commitIndex) {
      this._lastApplied++;
      const logEntry = this._log[this._lastApplied];
      if (!logEntry) break;

      // Resolve any pending proposal
      const pending = this._pendingProposals.get(this._lastApplied);
      if (pending) {
        pending.resolve(logEntry.entry);
        this._pendingProposals.delete(this._lastApplied);
      }

      // Notify application layer
      try { this._onCommit(logEntry.entry, this._lastApplied); } catch {}
    }
  }

  // ── Internal: Helpers ──────────────────────────────────────────────────────

  _majority() {
    return Math.floor(this._peers.size / 2) + 1;
  }

  _send(peerId, body) {
    // Fire-and-forget via transport (no private key here — consensus msgs signed by transport layer)
    try {
      this._transport.send(body, null, null, peerId).catch(() => {});
    } catch {}
  }

  _registerHandlers() {
    this._transport.on('consensus.vote_request',  (env) => this._handleVoteRequest(env));
    this._transport.on('consensus.vote_response', (env) => this._handleVoteResponse(env));
    this._transport.on('consensus.append',        (env) => this._handleAppend(env));
    this._transport.on('consensus.append_ack',    (env) => this._handleAppendAck(env));
    this._transport.on('consensus.heartbeat',     (env) => {
      // Alias heartbeat as an empty append
      this._handleAppend({ body: { ...envelope.body, entries: [] } });
    });
  }
}

// ── Export ─────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.ConsensusEngine = ConsensusEngine;
  window.JBC.CONSENSUS_ROLE  = ROLE;
}
if (typeof module !== 'undefined') module.exports = { ConsensusEngine, CONSENSUS_ROLE: ROLE };
