'use strict';

const { Game } = require('./game');
const { diffSnapshot } = require('./delta');
const { TICK_RATE, BROADCAST_RATE, COUNTDOWN_SECONDS, MIN_PLAYERS } = require('./config');

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP_MS = 250;
const BEAMER_ROOM = 'beamers';

/** Steuert den Ablauf Lobby → Countdown → Runde → Scoreboard und die feste Tick-Rate. */
class Match {
  constructor({ io, lobby, onPhaseChange }) {
    this.io = io;
    this.lobby = lobby;
    this.onPhaseChange = onPhaseChange;
    this.phase = 'lobby';
    this.game = null;
    this.countdown = 0;
    this.result = null;
    this.lastSnapshot = null;
    this.sentStatus = new Map();
    this.lastTickAt = Date.now();
    this.accumulatedMs = 0;

    setInterval(() => this.guard(() => this.runTicks()), TICK_MS);
    setInterval(() => this.guard(() => this.broadcast()), 1000 / BROADCAST_RATE);
  }

  guard(action) {
    try {
      action();
    } catch (error) {
      console.error('Fehler in der Spielschleife:', error);
    }
  }

  get roundActive() {
    return this.phase === 'countdown' || this.phase === 'playing';
  }

  setPhase(phase) {
    this.phase = phase;
    this.lobby.setLocked(this.roundActive);
    this.onPhaseChange();
    this.sendFullSnapshot();
    this.syncStatuses();
  }

  // Befehle vom Host

  start() {
    if (this.roundActive) return { ok: false, error: 'Es läuft schon eine Runde.' };
    const roster = this.lobby.list().filter((player) => player.connected && !player.leaving);
    if (roster.length < MIN_PLAYERS) {
      return { ok: false, error: `Mindestens ${MIN_PLAYERS} Spieler nötig.` };
    }
    this.game = new Game(roster.map(({ slot }) => ({ slot, connected: true })));
    this.countdown = COUNTDOWN_SECONDS;
    this.result = null;
    this.accumulatedMs = 0;
    this.lastTickAt = Date.now();
    this.setPhase('countdown');
    return { ok: true };
  }

  backToLobby() {
    this.game = null;
    this.result = null;
    this.lobby.setLocked(false);
    this.lobby.resetScores();
    this.setPhase('lobby');
    return { ok: true };
  }

  // Eingaben der Spieler

  move(player, x, y) {
    if (this.roundActive && this.game && this.phase === 'playing') this.game.setMove(player.slot, x, y);
  }

  bomb(player) {
    return this.phase === 'playing' && this.game ? this.game.placeBomb(player.slot) : false;
  }

  setConnected(player, connected) {
    if (this.roundActive && this.game) this.game.setConnected(player.slot, connected);
    this.sentStatus.delete(player.token);
    this.syncStatuses();
  }

  playerLeft(player) {
    if (this.roundActive && this.game) this.game.eliminate(player.slot);
    this.sentStatus.delete(player.token);
  }

  // Feste Tick-Rate mit Ausgleich für ungenaue Timer

  runTicks() {
    const now = Date.now();
    this.accumulatedMs += Math.min(now - this.lastTickAt, MAX_CATCH_UP_MS);
    this.lastTickAt = now;
    while (this.accumulatedMs >= TICK_MS) {
      this.accumulatedMs -= TICK_MS;
      this.tick(1 / TICK_RATE);
    }
  }

  tick(dt) {
    if (!this.game) return;
    if (this.phase === 'countdown') {
      this.game.idle(dt);
      this.countdown -= dt;
      if (this.countdown <= 0) this.setPhase('playing');
    } else if (this.phase === 'playing') {
      this.game.step(dt);
      if (this.game.over) this.finishRound();
    }
  }

  finishRound() {
    const { game } = this;
    for (const player of this.lobby.list()) {
      const entity = game.players.get(player.slot);
      if (!entity) continue;
      player.hits += entity.hits;
      if (game.winnerSlot === player.slot) player.wins += 1;
    }
    this.result = { winnerSlot: game.winnerSlot };
    this.setPhase('scoreboard');
  }

  // Versand

  snapshot() {
    const snapshot = this.game.snapshot();
    snapshot.meta.count = this.phase === 'countdown' ? Math.ceil(this.countdown) : 0;
    return snapshot;
  }

  sendFullSnapshot(target = this.io.to(BEAMER_ROOM)) {
    if (!this.game) {
      this.lastSnapshot = null;
      return;
    }
    this.lastSnapshot = this.snapshot();
    target.emit('game:full', this.lastSnapshot);
  }

  addBeamer(socket) {
    socket.join(BEAMER_ROOM);
    if (this.game) socket.emit('game:full', this.lastSnapshot || this.snapshot());
  }

  broadcast() {
    if (!this.roundActive || !this.game) return;
    const snapshot = this.snapshot();
    if (this.lastSnapshot) {
      this.io.to(BEAMER_ROOM).emit('game:delta', diffSnapshot(this.lastSnapshot, snapshot));
    }
    this.lastSnapshot = snapshot;
    this.syncStatuses();
  }

  statusFor(player) {
    const entity = this.game ? this.game.players.get(player.slot) : null;
    const status = {
      phase: this.phase,
      inRound: Boolean(entity),
      alive: Boolean(entity && entity.alive),
      lives: entity ? entity.lives : 0,
      bombs: entity ? entity.maxBombs : 0,
      range: entity ? entity.range : 0,
      speed: entity ? entity.speedUps : 0,
      shielded: Boolean(entity && entity.invulnerable > 0),
      count: this.phase === 'countdown' ? Math.ceil(this.countdown) : 0,
    };
    if (this.phase === 'scoreboard' && this.result) {
      status.won = this.result.winnerSlot === player.slot;
      status.draw = this.result.winnerSlot === null;
    }
    return status;
  }

  syncStatuses() {
    for (const player of this.lobby.players.values()) {
      if (!player.socketId) continue;
      const status = this.statusFor(player);
      const encoded = JSON.stringify(status);
      if (this.sentStatus.get(player.token) !== encoded) {
        this.sentStatus.set(player.token, encoded);
        this.io.to(player.socketId).emit('player:status', status);
      }
    }
  }

  publicState() {
    return { phase: this.phase, result: this.result, minPlayers: MIN_PLAYERS };
  }
}

module.exports = { Match };
