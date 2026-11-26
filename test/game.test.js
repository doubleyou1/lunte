'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Game, TILE, SPAWNS } = require('../server/game');
const { diffSnapshot } = require('../server/delta');
const { cleanName, Lobby } = require('../server/lobby');

const DT = 1 / 30;
const roster = (count) => Array.from({ length: count }, (_, slot) => ({ slot }));

function emptyGame(count = 2, settings = {}) {
  const game = new Game(roster(count), { rng: () => 0.99, settings: { softBlockChance: 0, powerupChance: 0, ...settings } });
  return game;
}

function place(game, slot, x, y) {
  const player = game.players.get(slot);
  player.x = x;
  player.y = y;
  return player;
}

function run(game, seconds) {
  for (let i = 0; i < Math.round(seconds * 30); i += 1) game.step(DT);
}

test('Arena: Säulenmuster, 15×13, und freie Startfelder für 8 Spieler', () => {
  for (let run = 0; run < 50; run += 1) {
    const game = new Game(roster(8), { settings: { softBlockChance: 1 } });
    assert.strictEqual(game.grid.length, 15 * 13);
    assert.strictEqual(game.tileAt(2, 2), TILE.HARD);
    assert.strictEqual(game.tileAt(0, 5), TILE.HARD);
    for (const [x, y] of SPAWNS) {
      assert.strictEqual(game.tileAt(x, y), TILE.FLOOR);
      const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => game.tileAt(x + dx, y + dy) === TILE.FLOOR);
      assert.ok(exits.length >= 2, `Start ${x},${y} braucht Ausgänge`);
    }
  }
});

test('Jeder Start erlaubt, der eigenen ersten Bombe zu entkommen', () => {
  const game = new Game(roster(8), { rng: () => 0.5, settings: { softBlockChance: 1 } });
  for (const [sx, sy] of SPAWNS) {
    const blast = new Set([`${sx},${sy}`]);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let d = 1; d <= game.cfg.startRange; d += 1) {
        if (game.tileAt(sx + dx * d, sy + dy * d) !== TILE.FLOOR) break;
        blast.add(`${sx + dx * d},${sy + dy * d}`);
      }
    }
    const seen = new Set([`${sx},${sy}`]);
    const queue = [[sx, sy]];
    let safe = false;
    while (queue.length && !safe) {
      const [x, y] = queue.shift();
      if (!blast.has(`${x},${y}`)) safe = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${x + dx},${y + dy}`;
        if (!seen.has(key) && game.tileAt(x + dx, y + dy) === TILE.FLOOR) {
          seen.add(key);
          queue.push([x + dx, y + dy]);
        }
      }
    }
    assert.ok(safe, `kein sicheres Feld von ${sx},${sy}`);
  }
});

test('Bewegung stoppt an Wänden und ist unabhängig von der Eingabelänge begrenzt', () => {
  const game = emptyGame();
  const player = place(game, 0, 1.5, 1.5);
  game.setMove(0, -100, 0);
  run(game, 1);
  assert.ok(player.x >= 1 + game.cfg.playerHalfSize - 0.01);
  assert.ok(player.x < 1.5);

  place(game, 0, 1.5, 1.5);
  game.setMove(0, 100, 0);
  run(game, 0.5);
  assert.ok(Math.abs(player.x - (1.5 + game.cfg.baseSpeed * 0.5)) < 0.2, `x=${player.x}`);
});

test('Eckentoleranz: leicht versetzte Figur rutscht in den Gang', () => {
  const game = emptyGame();
  // Gang nach unten bei x=3, Säulen bei x=2 und x=4 in Reihe 2.
  const player = place(game, 0, 3.72, 1.5);
  game.setMove(0, 0, 1);
  run(game, 0.6);
  assert.ok(player.y > 2.5, `y=${player.y}`);
  assert.ok(player.x < 3.63, `x=${player.x}`);
});

test('Ungültige Eingaben ändern nichts', () => {
  const game = emptyGame();
  const player = game.players.get(0);
  game.setMove(0, NaN, 1);
  game.setMove(0, '1', 1);
  game.setMove(99, 1, 1);
  assert.strictEqual(player.moveX, 0);
  assert.strictEqual(player.moveY, 0);
});

test('Bombe: Limit, Zündzeit, Kreuzform, und Figur kann vom eigenen Feld herunter', () => {
  const game = emptyGame();
  const player = place(game, 0, 5.5, 1.5);
  place(game, 1, 13.5, 11.5);
  assert.ok(game.placeBomb(0));
  run(game, 0.3);
  assert.strictEqual(game.placeBomb(0), false, 'nur eine Bombe erlaubt');
  game.setMove(0, 1, 0);
  run(game, 0.3);
  assert.ok(player.x > 6, 'läuft vom Bombenfeld');
  game.setMove(0, -1, 0);
  run(game, 0.5);
  assert.ok(player.x >= 6 + game.cfg.playerHalfSize - 0.01, 'Bombe blockiert danach');
  game.setMove(0, 0, 0);
  place(game, 0, 9.5, 3.5);
  run(game, 3 - 1.1 + 0.1);
  assert.strictEqual(game.bombs.size, 0);
  assert.ok(game.flames.has(game.index(5, 1)));
  assert.ok(game.flames.has(game.index(7, 1)));
  assert.ok(!game.flames.has(game.index(8, 1)));
  assert.ok(game.flames.has(game.index(5, 3)));
  assert.ok(!game.flames.has(game.index(6, 2)), 'nicht diagonal');
});

test('Kettenreaktion löst alle Bomben im selben Tick und terminiert auch im Kreis', () => {
  const game = emptyGame(3);
  place(game, 2, 13.5, 11.5);
  const spots = [[3, 3], [5, 3], [5, 5], [3, 5]];
  spots.forEach(([x, y], owner) => {
    const bomb = { id: 100 + owner, x, y, owner: 0, range: 2, fuse: owner === 0 ? 0.01 : 99, passable: new Set() };
    game.bombs.set(bomb.id, bomb);
    game.bombByTile.set(game.index(x, y), bomb);
  });
  place(game, 0, 11.5, 11.5);
  place(game, 1, 11.5, 9.5);
  game.step(DT);
  assert.strictEqual(game.bombs.size, 0);
});

test('Zerstörbare Blöcke verschwinden und stoppen die Explosion', () => {
  const game = emptyGame();
  place(game, 0, 11.5, 11.5);
  place(game, 1, 13.5, 11.5);
  game.grid[game.index(6, 1)] = TILE.SOFT;
  game.explode([{ id: 1, x: 5, y: 1, owner: 0, range: 4, fuse: 0, passable: new Set() }]);
  assert.strictEqual(game.tileAt(6, 1), TILE.FLOOR);
  assert.ok(game.flames.has(game.index(6, 1)));
  assert.ok(!game.flames.has(game.index(7, 1)));
});

test('Power-ups wirken und ein Treffer kostet ein Leben, zwei beenden die Runde', () => {
  const game = emptyGame(2);
  const a = place(game, 0, 5.5, 1.5);
  const b = place(game, 1, 13.5, 11.5);
  game.powerups.set(game.index(5, 1), { x: 5, y: 1, type: 'range' });
  game.step(DT);
  assert.strictEqual(a.range, game.cfg.startRange + 1);
  for (const type of ['bomb', 'speed']) {
    game.powerups.set(game.index(5, 1), { x: 5, y: 1, type });
    game.step(DT);
  }
  assert.strictEqual(a.maxBombs, 2);
  assert.strictEqual(a.speedUps, 1);

  const burn = () => game.flames.set(game.index(Math.floor(b.x), Math.floor(b.y)), {
    x: Math.floor(b.x), y: Math.floor(b.y), owner: 0, ttl: 0.5,
  });
  burn();
  game.step(DT);
  assert.strictEqual(b.lives, 1);
  assert.ok(b.invulnerable > 0);
  burn();
  game.step(DT);
  assert.strictEqual(b.lives, 1, 'Schutz nach Wiedereinstieg');
  b.invulnerable = 0;
  burn();
  game.step(DT);
  assert.strictEqual(b.alive, false);
  assert.strictEqual(a.hits, 2);
  run(game, 2);
  assert.ok(game.over);
  assert.strictEqual(game.winnerSlot, 0);
});

test('Getrennte Figur bleibt stehen und scheidet nach 10 Sekunden aus', () => {
  const game = emptyGame(3);
  const player = place(game, 1, 5.5, 1.5);
  game.setMove(1, 1, 0);
  game.setConnected(1, false);
  game.setMove(1, 1, 0);
  run(game, 9.5);
  assert.strictEqual(player.x, 5.5);
  assert.ok(player.alive);
  game.setConnected(1, true);
  game.setConnected(1, false);
  run(game, 9.5);
  assert.ok(player.alive, 'Reconnect setzt die Frist zurück');
  run(game, 1);
  assert.strictEqual(player.alive, false);
});

test('Arena schrumpft nach 2 Minuten und beendet jede Runde', () => {
  const game = emptyGame(2);
  place(game, 0, 7.5, 5.5);
  place(game, 1, 7.5, 7.5);
  run(game, 119);
  assert.strictEqual(game.tileAt(1, 1), TILE.FLOOR);
  run(game, 1.1);
  assert.strictEqual(game.tileAt(1, 1), TILE.HARD);
  run(game, 90);
  assert.ok(game.over);
  for (const player of game.players.values()) {
    if (player.alive) assert.fail('nach komplettem Schrumpfen überlebt niemand');
  }
});

test('Zufällige Eingaben: 8 Spieler bleiben immer außerhalb fester Blöcke', () => {
  for (let seed = 0; seed < 6; seed += 1) {
    const game = new Game(roster(8));
    for (let tick = 0; tick < 30 * 90 && !game.over; tick += 1) {
      for (const player of game.players.values()) {
        if (tick % 10 === player.slot) {
          game.setMove(player.slot, Math.random() * 2 - 1, Math.random() * 2 - 1);
          if (Math.random() < 0.3) game.placeBomb(player.slot);
        }
      }
      game.step(DT);
      for (const player of game.players.values()) {
        if (!player.alive) continue;
        const tile = game.tileAt(Math.floor(player.x), Math.floor(player.y));
        assert.strictEqual(tile, TILE.FLOOR, `Spieler ${player.slot} in Block bei ${player.x},${player.y}`);
      }
    }
  }
});

test('Delta enthält nur Änderungen und ergibt angewendet den neuen Zustand', () => {
  const game = emptyGame();
  const before = game.snapshot();
  assert.deepStrictEqual(Object.keys(diffSnapshot(before, game.snapshot())), ['t']);
  game.setMove(0, 1, 0);
  game.step(DT);
  game.placeBomb(1);
  const after = game.snapshot();
  const delta = diffSnapshot(before, after);
  assert.ok(delta.players[0].x !== undefined);
  assert.strictEqual(delta.players[0].lives, undefined);
  assert.ok(Object.keys(delta.bombs).length === 1);
});

test('Namen werden bereinigt, Lobby begrenzt und behält Plätze während der Runde', () => {
  assert.strictEqual(cleanName('  A\u0000nna   Maria  Langername '), 'Anna Maria L');
  assert.strictEqual(cleanName(42), '');

  const lobby = new Lobby({ graceMs: 100000 });
  for (let i = 0; i < 8; i += 1) assert.ok(lobby.join(`P${i}`, `s${i}`).ok);
  assert.strictEqual(lobby.join('Zu viel', 'x').ok, false);

  lobby.setLocked(true);
  const left = lobby.leave('s3');
  assert.strictEqual(left.slot, 3);
  assert.strictEqual(lobby.freeSlot(), -1);
  lobby.setLocked(false);
  assert.strictEqual(lobby.freeSlot(), 3);
  for (const player of lobby.players.values()) clearTimeout(player.removalTimer);
});
