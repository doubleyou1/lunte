'use strict';

const { GAME } = require('./config');

const TILE = { FLOOR: 0, HARD: 1, SOFT: 2 };
const POWERUPS = ['bomb', 'range', 'speed'];
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const EPSILON = 0.001;

// Ecken zuerst, damit auch kleine Runden weit auseinander starten.
const SPAWNS = [
  [1, 1], [13, 11], [13, 1], [1, 11],
  [7, 1], [7, 11], [1, 5], [13, 7],
];

const round3 = (value) => Math.round(value * 1000) / 1000;

function shuffled(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Autoritative Simulation einer Runde. Positionen sind in Kacheln angegeben. */
class Game {
  constructor(roster, { rng = Math.random, settings = {} } = {}) {
    this.rng = rng;
    this.cfg = { ...GAME, ...settings };
    this.width = this.cfg.width;
    this.height = this.cfg.height;
    this.grid = new Uint8Array(this.width * this.height);
    this.players = new Map();
    this.bombs = new Map();
    this.bombByTile = new Map();
    this.flames = new Map();
    this.powerups = new Map();
    this.nextBombId = 1;
    this.clock = 0;
    this.roundTime = 0;
    this.shrinkOrder = this.buildShrinkOrder();
    this.shrinkIndex = 0;
    this.shrinkTimer = 0;
    this.finishTimer = null;
    this.over = false;
    this.winnerSlot = null;
    this.createArena(roster);
  }

  index(x, y) { return y * this.width + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  tileAt(x, y) { return this.inBounds(x, y) ? this.grid[this.index(x, y)] : TILE.HARD; }
  isPillar(x, y) {
    return x === 0 || y === 0 || x === this.width - 1 || y === this.height - 1
      || (x % 2 === 0 && y % 2 === 0);
  }

  createArena(roster) {
    const spawns = SPAWNS.slice(0, roster.length);
    const keepClear = new Set();
    const clear = (x, y) => {
      if (this.inBounds(x, y) && !this.isPillar(x, y)) keepClear.add(this.index(x, y));
    };

    // Jeder Start bekommt Gänge und eine Nische um die Ecke, um der ersten Bombe auszuweichen.
    for (const [sx, sy] of spawns) {
      clear(sx, sy);
      for (const [dx, dy] of DIRECTIONS) {
        clear(sx + dx, sy + dy);
        if (this.isPillar(sx + dx, sy + dy)) continue;
        clear(sx + dx * 2, sy + dy * 2);
        if (this.isPillar(sx + dx * 2, sy + dy * 2)) continue;
        clear(sx + dx * 2 + dy, sy + dy * 2 + dx);
        clear(sx + dx * 2 - dy, sy + dy * 2 - dx);
      }
    }

    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const i = this.index(x, y);
        if (this.isPillar(x, y)) this.grid[i] = TILE.HARD;
        else if (!keepClear.has(i) && this.rng() < this.cfg.softBlockChance) this.grid[i] = TILE.SOFT;
      }
    }

    shuffled(roster, this.rng).forEach((entry, position) => {
      const [x, y] = spawns[position];
      this.players.set(entry.slot, {
        slot: entry.slot,
        x: x + 0.5,
        y: y + 0.5,
        moveX: 0,
        moveY: 0,
        lookX: 0,
        lookY: 1,
        lives: this.cfg.startLives,
        alive: true,
        maxBombs: this.cfg.startBombs,
        range: this.cfg.startRange,
        speedUps: 0,
        invulnerable: 0,
        warp: 0,
        lastBombAt: -Infinity,
        connected: entry.connected !== false,
        offlineFor: 0,
        hits: 0,
      });
    });
  }

  buildShrinkOrder() {
    const order = [];
    let left = 1;
    let top = 1;
    let right = this.width - 2;
    let bottom = this.height - 2;
    while (left <= right && top <= bottom) {
      for (let x = left; x <= right; x += 1) order.push([x, top]);
      for (let y = top + 1; y <= bottom; y += 1) order.push([right, y]);
      if (top < bottom) for (let x = right - 1; x >= left; x -= 1) order.push([x, bottom]);
      if (left < right) for (let y = bottom - 1; y > top; y -= 1) order.push([left, y]);
      left += 1;
      top += 1;
      right -= 1;
      bottom -= 1;
    }
    return order;
  }

  // Eingaben

  setMove(slot, rawX, rawY) {
    const player = this.players.get(slot);
    if (!player || !Number.isFinite(rawX) || !Number.isFinite(rawY)) return;
    const length = Math.hypot(rawX, rawY);
    const scale = length > 1 ? 1 / length : 1;
    player.moveX = rawX * scale;
    player.moveY = rawY * scale;
  }

  placeBomb(slot) {
    const player = this.players.get(slot);
    if (!player || !player.alive) return false;
    if (this.clock - player.lastBombAt < this.cfg.bombCooldown) return false;

    const x = Math.floor(player.x);
    const y = Math.floor(player.y);
    const tile = this.index(x, y);
    if (this.bombByTile.has(tile) || this.tileAt(x, y) !== TILE.FLOOR) return false;

    let active = 0;
    for (const bomb of this.bombs.values()) if (bomb.owner === slot) active += 1;
    if (active >= player.maxBombs) return false;

    const passable = new Set();
    for (const other of this.players.values()) {
      if (other.alive && this.overlapsTile(other, x, y, this.cfg.playerHalfSize)) passable.add(other.slot);
    }
    const bomb = {
      id: this.nextBombId,
      x,
      y,
      owner: slot,
      range: player.range,
      fuse: this.cfg.fuseSeconds,
      passable,
    };
    this.nextBombId += 1;
    this.bombs.set(bomb.id, bomb);
    this.bombByTile.set(tile, bomb);
    player.lastBombAt = this.clock;
    return true;
  }

  setConnected(slot, connected) {
    const player = this.players.get(slot);
    if (!player) return;
    player.connected = connected;
    player.offlineFor = 0;
    player.moveX = 0;
    player.moveY = 0;
  }

  eliminate(slot) {
    const player = this.players.get(slot);
    if (!player) return;
    player.lives = 0;
    player.alive = false;
    player.moveX = 0;
    player.moveY = 0;
  }

  // Simulation

  idle(dt) { this.clock += dt; }

  step(dt) {
    if (this.over) return;
    this.clock += dt;
    this.roundTime += dt;

    for (const player of this.players.values()) this.updatePlayer(player, dt);
    this.updateBombs(dt);
    this.updateFlames(dt);
    this.updateShrink(dt);
    this.applyFlameDamage();
    this.updateFinish(dt);
  }

  updatePlayer(player, dt) {
    if (!player.alive) return;
    player.invulnerable = Math.max(0, player.invulnerable - dt);

    if (!player.connected) {
      player.offlineFor += dt;
      if (player.offlineFor >= this.cfg.disconnectSeconds) this.eliminate(player.slot);
      return;
    }

    if (player.moveX || player.moveY) {
      const speed = this.speedOf(player) * dt;
      this.moveAxis(player, 'x', player.moveX * speed, true);
      this.moveAxis(player, 'y', player.moveY * speed, true);
      player.lookX = player.moveX;
      player.lookY = player.moveY;
    }

    this.collectPowerup(player);
  }

  speedOf(player) {
    return this.cfg.baseSpeed + player.speedUps * this.cfg.speedPerPowerup;
  }

  isSolid(x, y, player) {
    if (this.tileAt(x, y) !== TILE.FLOOR) return true;
    const bomb = this.bombByTile.get(this.index(x, y));
    return Boolean(bomb && !bomb.passable.has(player.slot));
  }

  /** Bewegt entlang einer Achse und prüft nur die Kacheln an der Vorderkante. */
  moveAxis(player, axis, delta, mayNudge) {
    if (!delta) return;
    const other = axis === 'x' ? 'y' : 'x';
    const half = this.cfg.playerHalfSize;
    const sign = Math.sign(delta);
    const next = player[axis] + delta;
    const lead = Math.floor(next + sign * half);
    const first = Math.floor(player[other] - half + EPSILON);
    const last = Math.floor(player[other] + half - EPSILON);

    const blocked = [];
    for (let cross = first; cross <= last; cross += 1) {
      const solid = axis === 'x'
        ? this.isSolid(lead, cross, player)
        : this.isSolid(cross, lead, player);
      if (solid) blocked.push(cross);
    }

    if (blocked.length === 0) {
      player[axis] = next;
      return;
    }

    const contact = sign > 0 ? lead - half - EPSILON : lead + 1 + half + EPSILON;
    player[axis] = sign > 0 ? Math.max(player[axis], contact) : Math.min(player[axis], contact);

    // Streift die Figur nur eine Ecke, rutscht sie in den freien Gang.
    if (!mayNudge || first === last || blocked.length !== 1) return;
    const nudgeForward = blocked[0] === first;
    const overlap = nudgeForward ? last - (player[other] - half) : player[other] + half - last;
    if (overlap > this.cfg.cornerTolerance) return;
    const step = Math.min(Math.abs(delta), overlap + EPSILON);
    this.moveAxis(player, other, nudgeForward ? step : -step, false);
  }

  overlapsTile(player, x, y, half) {
    return player.x + half > x && player.x - half < x + 1
      && player.y + half > y && player.y - half < y + 1;
  }

  collectPowerup(player) {
    const tile = this.index(Math.floor(player.x), Math.floor(player.y));
    const powerup = this.powerups.get(tile);
    if (!powerup) return;
    this.powerups.delete(tile);
    if (powerup.type === 'bomb') player.maxBombs = Math.min(this.cfg.maxBombs, player.maxBombs + 1);
    if (powerup.type === 'range') player.range = Math.min(this.cfg.maxRange, player.range + 1);
    if (powerup.type === 'speed') player.speedUps = Math.min(this.cfg.maxSpeedPowerups, player.speedUps + 1);
  }

  updateBombs(dt) {
    const due = [];
    for (const bomb of this.bombs.values()) {
      for (const slot of bomb.passable) {
        const player = this.players.get(slot);
        if (!player || !player.alive
          || !this.overlapsTile(player, bomb.x, bomb.y, this.cfg.playerHalfSize)) {
          bomb.passable.delete(slot);
        }
      }
      bomb.fuse -= dt;
      if (bomb.fuse <= 0 || this.flames.has(this.index(bomb.x, bomb.y))) due.push(bomb);
    }
    if (due.length) this.explode(due);
  }

  /** Löst alle Explosionen samt Kettenreaktion in genau einem Durchgang auf. */
  explode(initialBombs) {
    const queue = [...initialBombs];
    const queued = new Set(queue.map((bomb) => bomb.id));
    const brokenBlocks = new Set();

    const addFlame = (x, y, owner) => {
      this.flames.set(this.index(x, y), { x, y, owner, ttl: this.cfg.flameSeconds });
    };

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const bomb = queue[cursor];
      this.bombs.delete(bomb.id);
      this.bombByTile.delete(this.index(bomb.x, bomb.y));
      addFlame(bomb.x, bomb.y, bomb.owner);

      for (const [dx, dy] of DIRECTIONS) {
        for (let distance = 1; distance <= bomb.range; distance += 1) {
          const x = bomb.x + dx * distance;
          const y = bomb.y + dy * distance;
          const tile = this.tileAt(x, y);
          if (tile === TILE.HARD) break;

          const i = this.index(x, y);
          addFlame(x, y, bomb.owner);
          if (tile === TILE.SOFT) {
            brokenBlocks.add(i);
            break;
          }
          this.powerups.delete(i);

          const hitBomb = this.bombByTile.get(i);
          if (hitBomb) {
            if (!queued.has(hitBomb.id)) {
              queued.add(hitBomb.id);
              queue.push(hitBomb);
            }
            break;
          }
        }
      }
    }

    for (const i of brokenBlocks) {
      this.grid[i] = TILE.FLOOR;
      if (this.rng() < this.cfg.powerupChance) {
        const type = POWERUPS[Math.floor(this.rng() * POWERUPS.length)];
        this.powerups.set(i, { x: i % this.width, y: Math.floor(i / this.width), type });
      }
    }
  }

  updateFlames(dt) {
    for (const [tile, flame] of this.flames) {
      flame.ttl -= dt;
      if (flame.ttl <= 0) this.flames.delete(tile);
    }
  }

  applyFlameDamage() {
    const half = this.cfg.hitHalfSize;
    for (const player of this.players.values()) {
      if (!player.alive || player.invulnerable > 0) continue;
      const minX = Math.floor(player.x - half);
      const maxX = Math.floor(player.x + half);
      const minY = Math.floor(player.y - half);
      const maxY = Math.floor(player.y + half);
      let flame = null;
      for (let y = minY; y <= maxY && !flame; y += 1) {
        for (let x = minX; x <= maxX && !flame; x += 1) {
          flame = this.flames.get(this.index(x, y)) || null;
        }
      }
      if (flame) this.hitPlayer(player, flame.owner);
    }
  }

  hitPlayer(player, ownerSlot) {
    player.lives -= 1;
    if (ownerSlot !== null && ownerSlot !== player.slot) {
      const owner = this.players.get(ownerSlot);
      if (owner) owner.hits += 1;
    }
    if (player.lives <= 0) {
      this.eliminate(player.slot);
      return;
    }
    const spot = this.findRespawnTile(player);
    if (!spot) {
      this.eliminate(player.slot);
      return;
    }
    player.x = spot[0] + 0.5;
    player.y = spot[1] + 0.5;
    player.invulnerable = this.cfg.respawnInvulnerability;
    player.warp += 1;
  }

  /** Sucht das freie Feld, das am weitesten von Gefahr und Gegnern entfernt ist. */
  findRespawnTile(player) {
    const danger = new Set(this.flames.keys());
    for (const bomb of this.bombs.values()) {
      danger.add(this.index(bomb.x, bomb.y));
      for (const [dx, dy] of DIRECTIONS) {
        for (let distance = 1; distance <= bomb.range; distance += 1) {
          const x = bomb.x + dx * distance;
          const y = bomb.y + dy * distance;
          if (this.tileAt(x, y) !== TILE.FLOOR) break;
          danger.add(this.index(x, y));
        }
      }
    }
    const opponents = [...this.players.values()].filter((p) => p.alive && p !== player);
    const upcoming = new Set(this.nextShrinkTiles().map(([x, y]) => this.index(x, y)));

    let best = null;
    let bestScore = -Infinity;
    for (let y = 1; y < this.height - 1; y += 1) {
      for (let x = 1; x < this.width - 1; x += 1) {
        const i = this.index(x, y);
        if (this.grid[i] !== TILE.FLOOR || this.bombByTile.has(i)) continue;
        const nearest = opponents.reduce(
          (minimum, p) => Math.min(minimum, Math.hypot(p.x - x - 0.5, p.y - y - 0.5)),
          20,
        );
        const penalty = (danger.has(i) ? 100 : 0) + (upcoming.has(i) ? 50 : 0);
        const score = nearest - penalty + this.rng() * 0.01;
        if (score > bestScore) {
          bestScore = score;
          best = [x, y];
        }
      }
    }
    return best;
  }

  nextShrinkTiles() {
    const tiles = [];
    for (let i = this.shrinkIndex; i < this.shrinkOrder.length; i += 1) {
      const [x, y] = this.shrinkOrder[i];
      if (this.tileAt(x, y) !== TILE.HARD) tiles.push([x, y]);
      if (tiles.length === this.cfg.shrinkWarningTiles) break;
    }
    return tiles;
  }

  updateShrink(dt) {
    if (this.roundTime < this.cfg.shrinkAfterSeconds) return;
    this.shrinkTimer -= dt;
    while (this.shrinkTimer <= 0 && this.shrinkIndex < this.shrinkOrder.length) {
      const [x, y] = this.shrinkOrder[this.shrinkIndex];
      this.shrinkIndex += 1;
      if (this.tileAt(x, y) === TILE.HARD) continue;
      this.placeWall(x, y);
      this.shrinkTimer += this.cfg.shrinkIntervalSeconds;
    }
  }

  placeWall(x, y) {
    const i = this.index(x, y);
    this.grid[i] = TILE.HARD;
    this.powerups.delete(i);
    this.flames.delete(i);
    const bomb = this.bombByTile.get(i);
    if (bomb) {
      this.bombs.delete(bomb.id);
      this.bombByTile.delete(i);
    }

    const half = this.cfg.playerHalfSize;
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      if (Math.floor(player.x) === x && Math.floor(player.y) === y) {
        this.hitPlayer(player, null);
      } else if (this.overlapsTile(player, x, y, half)) {
        // Nur gestreift: aus der neuen Wand herausschieben.
        const dx = player.x - (x + 0.5);
        const dy = player.y - (y + 0.5);
        if (Math.abs(dx) > Math.abs(dy)) player.x = x + 0.5 + Math.sign(dx) * (0.5 + half + EPSILON);
        else player.y = y + 0.5 + Math.sign(dy) * (0.5 + half + EPSILON);
      }
    }
  }

  updateFinish(dt) {
    const alive = [...this.players.values()].filter((player) => player.alive);
    if (this.finishTimer === null) {
      if (alive.length > 1) return;
      this.finishTimer = this.cfg.finishDelaySeconds;
    }
    this.finishTimer -= dt;
    if (this.finishTimer <= 0 || alive.length === 0) {
      this.over = true;
      this.winnerSlot = alive.length === 1 ? alive[0].slot : null;
    }
  }

  // Zustand für Clients

  snapshot() {
    const players = {};
    for (const p of this.players.values()) {
      players[p.slot] = {
        x: round3(p.x),
        y: round3(p.y),
        lookX: Math.round(p.lookX * 10) / 10,
        lookY: Math.round(p.lookY * 10) / 10,
        lives: p.lives,
        alive: p.alive,
        bombs: p.maxBombs,
        range: p.range,
        speed: p.speedUps,
        shielded: p.invulnerable > 0,
        warp: p.warp,
        connected: p.connected,
        offlineLeft: p.connected ? 0 : Math.ceil(this.cfg.disconnectSeconds - p.offlineFor),
        hits: p.hits,
      };
    }

    const bombs = {};
    for (const bomb of this.bombs.values()) {
      bombs[bomb.id] = {
        x: bomb.x,
        y: bomb.y,
        explodesAt: Math.round((this.clock + bomb.fuse) * 1000),
      };
    }

    const flames = {};
    for (const [tile, flame] of this.flames) flames[tile] = { x: flame.x, y: flame.y };

    const powerups = {};
    for (const [tile, powerup] of this.powerups) powerups[tile] = { ...powerup };

    const untilShrink = this.cfg.shrinkAfterSeconds - this.roundTime;
    const warning = untilShrink <= this.cfg.shrinkWarningSeconds;
    return {
      t: Math.round(this.clock * 1000),
      width: this.width,
      height: this.height,
      grid: Array.from(this.grid),
      players,
      bombs,
      flames,
      powerups,
      meta: {
        secondsLeft: Math.max(0, Math.ceil(untilShrink)),
        shrinking: untilShrink <= 0,
        warn: warning ? this.nextShrinkTiles().map(([x, y]) => this.index(x, y)).join(',') : '',
      },
    };
  }
}

module.exports = { Game, TILE, SPAWNS };
