'use strict';

module.exports = {
  HOST: '0.0.0.0',
  PORT: Number(process.env.PORT) || 3000,
  MAX_PLAYERS: 8,
  MIN_PLAYERS: 2,
  MAX_NAME_LENGTH: 12,
  // Wer außerhalb einer Runde so lange weg ist, gibt seinen Platz wieder frei.
  LOBBY_GRACE_MS: 60_000,
  // Obergrenzen pro Verbindung und Sekunde.
  RATE_LIMITS: { control: 10, move: 60, bomb: 10 },
  NETWORK_CHECK_MS: 3_000,

  TICK_RATE: 30,
  BROADCAST_RATE: 20,
  COUNTDOWN_SECONDS: 3,

  GAME: {
    width: 15,
    height: 13,
    softBlockChance: 0.72,
    powerupChance: 0.32,
    startLives: 2,
    respawnInvulnerability: 2.5,
    playerHalfSize: 0.38,
    hitHalfSize: 0.24,
    cornerTolerance: 0.3,
    baseSpeed: 3.3,
    speedPerPowerup: 0.55,
    maxSpeedPowerups: 4,
    startBombs: 1,
    maxBombs: 6,
    startRange: 2,
    maxRange: 8,
    fuseSeconds: 3,
    flameSeconds: 0.55,
    bombCooldown: 0.18,
    disconnectSeconds: 10,
    shrinkAfterSeconds: 120,
    shrinkWarningSeconds: 5,
    shrinkIntervalSeconds: 0.45,
    shrinkWarningTiles: 8,
    finishDelaySeconds: 1.5,
  },

  PLAYER_COLORS: [
    { name: 'Rot', hex: '#e6392f', ink: '#ffffff' },
    { name: 'Blau', hex: '#2467e8', ink: '#ffffff' },
    { name: 'Gelb', hex: '#f7c600', ink: '#1d1b18' },
    { name: 'Grün', hex: '#149a45', ink: '#ffffff' },
    { name: 'Violett', hex: '#8a3fd4', ink: '#ffffff' },
    { name: 'Orange', hex: '#f5821f', ink: '#1d1b18' },
    { name: 'Türkis', hex: '#14c1bb', ink: '#1d1b18' },
    { name: 'Pink', hex: '#f25caf', ink: '#1d1b18' },
  ],
};
