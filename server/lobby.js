'use strict';

const crypto = require('crypto');
const { MAX_PLAYERS, MAX_NAME_LENGTH, LOBBY_GRACE_MS, PLAYER_COLORS } = require('./config');

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  const compact = raw
    .slice(0, 200)
    .normalize('NFC')
    .replace(/\p{C}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(compact).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** Spielerverwaltung. Tokens bleiben hier und werden nie an andere Clients gesendet. */
class Lobby {
  constructor({ onChange = () => {}, graceMs = LOBBY_GRACE_MS } = {}) {
    this.players = new Map();
    this.onChange = onChange;
    this.graceMs = graceMs;
    // Während einer Runde bleiben Plätze belegt, damit keine fremde Figur übernommen wird.
    this.locked = false;
  }

  list() {
    return [...this.players.values()].sort((a, b) => a.slot - b.slot);
  }

  findBySocket(socketId) {
    for (const player of this.players.values()) {
      if (player.socketId === socketId) return player;
    }
    return null;
  }

  freeSlot() {
    const taken = new Set([...this.players.values()].map((player) => player.slot));
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (!taken.has(slot)) return slot;
    }
    return -1;
  }

  join(rawName, socketId) {
    const existing = this.findBySocket(socketId);
    if (existing) return { ok: true, player: existing };

    const name = cleanName(rawName);
    if (!name) return { ok: false, error: 'Bitte gib einen Namen ein.' };

    const slot = this.freeSlot();
    if (slot < 0) return { ok: false, error: `Das Spiel ist voll (${MAX_PLAYERS} Spieler).` };

    const player = {
      token: crypto.randomUUID(),
      slot,
      name,
      color: PLAYER_COLORS[slot],
      socketId,
      connected: true,
      leaving: false,
      removalTimer: null,
      wins: 0,
      hits: 0,
    };
    this.players.set(player.token, player);
    this.onChange();
    return { ok: true, player };
  }

  resume(token, socketId) {
    const player = typeof token === 'string' ? this.players.get(token) : null;
    if (!player) return { ok: false };

    const replacedSocketId =
      player.connected && player.socketId !== socketId ? player.socketId : null;
    clearTimeout(player.removalTimer);
    player.removalTimer = null;
    player.socketId = socketId;
    player.connected = true;
    player.leaving = false;
    this.onChange();
    return { ok: true, player, replacedSocketId };
  }

  disconnect(socketId) {
    const player = this.findBySocket(socketId);
    if (!player) return null;

    player.connected = false;
    player.socketId = null;
    player.removalTimer = setTimeout(() => this.remove(player), this.graceMs);
    player.removalTimer.unref();
    this.onChange();
    return player;
  }

  leave(socketId) {
    const player = this.findBySocket(socketId);
    if (player) this.remove(player);
    return player;
  }

  remove(player) {
    clearTimeout(player.removalTimer);
    player.removalTimer = null;
    if (this.locked) {
      player.leaving = true;
      player.connected = false;
      player.socketId = null;
    } else {
      this.players.delete(player.token);
    }
    this.onChange();
  }

  setLocked(locked) {
    this.locked = locked;
    if (locked) return;
    for (const player of [...this.players.values()]) {
      if (player.leaving) this.players.delete(player.token);
    }
  }

  resetScores() {
    for (const player of this.players.values()) {
      player.wins = 0;
      player.hits = 0;
    }
  }

  publicPlayer(player) {
    return {
      slot: player.slot,
      name: player.name,
      color: player.color,
      connected: player.connected,
      wins: player.wins,
      hits: player.hits,
    };
  }

  publicState() {
    return {
      maxPlayers: MAX_PLAYERS,
      players: this.list().map((player) => this.publicPlayer(player)),
    };
  }
}

module.exports = { Lobby, cleanName };
