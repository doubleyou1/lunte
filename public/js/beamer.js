'use strict';

const INTERPOLATION_DELAY_MS = 100;
const TILE_HARD = 1;
const TILE_SOFT = 2;
const COLORS = {
  floorA: '#ece2cc',
  floorB: '#e4d9c0',
  hard: '#39404e',
  hardTop: '#515a6b',
  soft: '#c9794a',
  softLine: '#8f4f2b',
  softTop: '#dc9468',
  ink: '#1d1b18',
};
const POWERUP_COLORS = { bomb: '#2467e8', range: '#e4501b', speed: '#149a45' };

const socket = io();
const $ = (id) => document.getElementById(id);
const canvas = $('arena');
const ctx = canvas.getContext('2d');
const gridLayer = document.createElement('canvas');

let isHost = false;
let lobbyState = null;
let shownJoinUrl;
let world = null;
let gridDirty = true;
let clockOffset = null;
let tileSize = 40;
let lastCount = 0;
let effects = [];
const slotViews = [];
const hudCards = new Map();
const history = new Map();

// Lobby

function createSlotView() {
  const root = document.createElement('li');
  root.className = 'slot';
  const figure = document.createElement('canvas');
  const text = document.createElement('div');
  text.className = 'slot-text';
  const name = document.createElement('div');
  name.className = 'slot-name';
  const status = document.createElement('div');
  status.className = 'status';
  text.append(name, status);
  root.append(figure, text);
  $('slots').append(root);
  return { root, figure, name, status, color: null };
}

function renderSlot(view, player) {
  view.root.classList.toggle('taken', Boolean(player));
  view.root.classList.toggle('away', Boolean(player && !player.connected));
  view.name.textContent = player ? player.name : 'Frei';
  view.status.textContent = player && player.connected ? 'Verbunden' : 'Getrennt';

  const color = player ? player.color.hex : null;
  view.root.style.setProperty('--player', color);
  if (color !== view.color) {
    view.color = color;
    renderFigureCanvas(view.figure, color);
  }
}

function renderJoinInfo(joinUrl) {
  if (joinUrl === shownJoinUrl) return;
  shownJoinUrl = joinUrl;
  $('qr').hidden = !joinUrl;
  $('no-network').hidden = Boolean(joinUrl);
  $('join-url').textContent = joinUrl ? joinUrl.replace(/^http:\/\/|\/$/g, '') : '';
  if (joinUrl) $('qr').src = `/qr.svg?url=${encodeURIComponent(joinUrl)}`;
}

function renderLobby(state) {
  renderJoinInfo(state.joinUrl);
  $('player-count').textContent = `${state.players.length} von ${state.maxPlayers}`;
  while (slotViews.length < state.maxPlayers) slotViews.push(createSlotView());
  const bySlot = new Map(state.players.map((player) => [player.slot, player]));
  slotViews.forEach((view, slot) => renderSlot(view, bySlot.get(slot)));

  const ready = state.players.filter((player) => player.connected).length;
  const button = $('start-button');
  button.hidden = !isHost;
  button.disabled = ready < state.minPlayers;
  button.textContent = ready < state.minPlayers
    ? `Mindestens ${state.minPlayers} Spieler nötig`
    : 'Runde starten (Leertaste)';
}

function renderScoreboard(state) {
  const { result, players } = state;
  const winner = players.find((player) => player.slot === result?.winnerSlot);
  $('result-title').textContent = winner ? `${winner.name} gewinnt!` : 'Unentschieden!';

  const rows = [...players].sort((a, b) => b.wins - a.wins || b.hits - a.hits);
  $('score-rows').replaceChildren(...rows.map((player) => {
    const row = document.createElement('tr');
    row.classList.toggle('winner', player === winner);
    const nameCell = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = player.color.hex;
    nameCell.append(chip, player.name);
    const wins = document.createElement('td');
    wins.textContent = player.wins;
    const hits = document.createElement('td');
    hits.textContent = player.hits;
    row.append(nameCell, wins, hits);
    return row;
  }));
  $('next-button').hidden = !isHost;
  $('lobby-button').hidden = !isHost;
  $('next-button').disabled = players.filter((p) => p.connected).length < state.minPlayers;
}

function renderPhase() {
  const state = lobbyState;
  if (!state) return;
  const inLobby = state.phase === 'lobby';
  $('lobby-view').hidden = !inLobby;
  $('game-view').hidden = inLobby;
  $('scoreboard').hidden = state.phase !== 'scoreboard';
  if (inLobby) {
    world = null;
    renderLobby(state);
    return;
  }
  layoutArena();
  if (state.phase === 'scoreboard') renderScoreboard(state);
  renderHud();
}

// Host-Befehle

function hostCommand(event) {
  unlockAudio();
  socket.emit(event, {}, () => {});
}

$('start-button').addEventListener('click', () => hostCommand('host:start'));
$('next-button').addEventListener('click', () => hostCommand('host:start'));
$('lobby-button').addEventListener('click', () => hostCommand('host:lobby'));

document.addEventListener('keydown', (event) => {
  if (!isHost || event.repeat || !lobbyState) return;
  const canStart = lobbyState.phase === 'lobby' || lobbyState.phase === 'scoreboard';
  if (event.code === 'Space' && canStart) {
    event.preventDefault();
    hostCommand('host:start');
  } else if (event.code === 'Escape' && lobbyState.phase !== 'lobby') {
    hostCommand('host:lobby');
  }
});

// Zustand und Interpolation

function serverNow() {
  return performance.now() + (clockOffset ?? 0);
}

function syncClock(serverTime) {
  const sample = serverTime - performance.now();
  if (clockOffset === null || Math.abs(sample - clockOffset) > 500) clockOffset = sample;
  else clockOffset += (sample - clockOffset) * 0.1;
}

function recordPositions() {
  for (const [slot, player] of Object.entries(world.players)) {
    const samples = history.get(slot) || [];
    samples.push({ t: world.t, x: player.x, y: player.y });
    while (samples.length > 8) samples.shift();
    history.set(slot, samples);
  }
}

function interpolated(slot, player, renderTime) {
  const samples = history.get(slot);
  if (!samples || !samples.length) return player;
  let older = samples[0];
  if (renderTime <= older.t) return older;
  for (const newer of samples) {
    if (newer.t >= renderTime) {
      const span = newer.t - older.t || 1;
      const blend = (renderTime - older.t) / span;
      return { x: older.x + (newer.x - older.x) * blend, y: older.y + (newer.y - older.y) * blend };
    }
    older = newer;
  }
  return older;
}

function applyMap(target, changes, onRemove) {
  for (const [key, change] of Object.entries(changes || {})) {
    if (change === null) {
      if (onRemove) onRemove(target[key]);
      delete target[key];
    } else {
      target[key] = { ...target[key], ...change };
    }
  }
}

socket.on('game:full', (snapshot) => {
  world = snapshot;
  history.clear();
  effects = [];
  clockOffset = null;
  gridDirty = true;
  syncClock(world.t);
  recordPositions();
  layoutArena();
  renderHud();
  updateCountdown();
});

socket.on('game:delta', (delta) => {
  if (!world) return;
  world.t = delta.t;
  syncClock(delta.t);

  for (const [index, value] of delta.grid || []) world.grid[index] = value;
  if (delta.grid) gridDirty = true;

  for (const [slot, change] of Object.entries(delta.players || {})) {
    const player = world.players[slot];
    if (!player || !change) continue;
    if (change.lives !== undefined && change.lives < player.lives) {
      effects.push({ kind: 'hit', x: player.x, y: player.y, born: performance.now(), color: colorOf(slot) });
    }
    if (change.warp !== undefined) history.delete(slot);
    Object.assign(player, change);
  }

  let newFlames = 0;
  for (const [key, change] of Object.entries(delta.flames || {})) {
    if (change && !world.flames[key]) {
      change.born = performance.now();
      newFlames += 1;
    }
  }
  applyMap(world.flames, delta.flames);
  applyMap(world.bombs, delta.bombs);
  applyMap(world.powerups, delta.powerups);
  Object.assign(world.meta, delta.meta);

  if (newFlames) playBoom();
  recordPositions();
  if (delta.meta || delta.players) renderHud();
  updateCountdown();
});

function updateCountdown() {
  const count = world?.meta.count || 0;
  const element = $('countdown');
  element.hidden = !count;
  element.textContent = count || '';
  if (count && count !== lastCount) playBeep(520);
  if (!count && lastCount) playBeep(880);
  lastCount = count;
}

// Seitenleisten

function lobbyPlayer(slot) {
  return lobbyState?.players.find((player) => String(player.slot) === String(slot));
}

function colorOf(slot) {
  return lobbyPlayer(slot)?.color.hex || '#888888';
}

function createHudCard(slot) {
  const root = document.createElement('div');
  root.className = 'card';
  const name = document.createElement('div');
  name.className = 'card-name';
  const lives = document.createElement('div');
  lives.className = 'lives';
  const powers = document.createElement('div');
  powers.className = 'powers';
  const status = document.createElement('div');
  status.className = 'status';
  root.append(name, lives, powers, status);
  $(Number(slot) < 4 ? 'hud-left' : 'hud-right').append(root);
  return { root, name, lives, powers, status };
}

function renderHud() {
  if (!world) return;
  const seen = new Set();
  for (const [slot, player] of Object.entries(world.players)) {
    seen.add(slot);
    if (!hudCards.has(slot)) hudCards.set(slot, createHudCard(slot));
    const card = hudCards.get(slot);
    const info = lobbyPlayer(slot);
    card.root.style.setProperty('--player', colorOf(slot));
    card.root.classList.toggle('dead', !player.alive);
    card.name.textContent = info?.name || '–';

    const maxLives = Math.max(player.lives, 2);
    const hearts = '♥'.repeat(player.lives);
    const lost = '♥'.repeat(maxLives - player.lives);
    const lostElement = document.createElement('span');
    lostElement.className = 'lost';
    lostElement.textContent = lost;
    card.lives.replaceChildren(hearts, lostElement);
    card.lives.setAttribute('aria-label', `${player.lives} Leben`);

    card.powers.textContent = `Bomben ${player.bombs} · Weite ${player.range} · Tempo ${player.speed}`;

    let label = 'Verbunden';
    let tone = '';
    if (!player.alive) {
      label = 'Ausgeschieden';
      tone = 'out';
    } else if (!player.connected) {
      label = `Getrennt, noch ${player.offlineLeft} s`;
      tone = 'bad';
    }
    card.status.textContent = label;
    card.status.className = `status ${tone}`;
  }
  for (const [slot, card] of hudCards) {
    if (!seen.has(slot)) {
      card.root.remove();
      hudCards.delete(slot);
    }
  }

  const { secondsLeft, shrinking } = world.meta;
  $('clock-label').textContent = shrinking ? 'Achtung' : 'Bis die Arena schrumpft';
  $('clock-value').textContent = shrinking
    ? 'Schrumpft!'
    : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  $('clock-value').style.fontSize = shrinking ? '3.6vmin' : '';
  document.querySelector('.clock').classList.toggle('alarm', shrinking || secondsLeft <= 5);
}

// Arena zeichnen

function layoutArena() {
  if (!world) return;
  const wrap = canvas.parentElement.getBoundingClientRect();
  if (!wrap.width || !wrap.height) return;
  tileSize = Math.floor(Math.min(wrap.width / world.width, wrap.height / world.height));
  const scale = window.devicePixelRatio || 1;
  const width = tileSize * world.width;
  const height = tileSize * world.height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  gridLayer.width = canvas.width;
  gridLayer.height = canvas.height;
  gridDirty = true;
}

function drawGridLayer() {
  const scale = window.devicePixelRatio || 1;
  const g = gridLayer.getContext('2d');
  g.setTransform(scale * tileSize, 0, 0, scale * tileSize, 0, 0);
  for (let y = 0; y < world.height; y += 1) {
    for (let x = 0; x < world.width; x += 1) {
      const tile = world.grid[y * world.width + x];
      g.fillStyle = (x + y) % 2 ? COLORS.floorA : COLORS.floorB;
      g.fillRect(x, y, 1, 1);
      if (tile === TILE_HARD) {
        g.fillStyle = COLORS.hard;
        g.fillRect(x, y, 1, 1);
        g.fillStyle = COLORS.hardTop;
        g.fillRect(x + 0.08, y + 0.08, 0.84, 0.66);
      } else if (tile === TILE_SOFT) {
        g.fillStyle = COLORS.softLine;
        g.fillRect(x + 0.03, y + 0.03, 0.94, 0.94);
        g.fillStyle = COLORS.soft;
        g.fillRect(x + 0.08, y + 0.08, 0.84, 0.84);
        g.fillStyle = COLORS.softTop;
        g.fillRect(x + 0.08, y + 0.08, 0.84, 0.14);
        g.fillStyle = COLORS.softLine;
        g.fillRect(x + 0.08, y + 0.48, 0.84, 0.05);
        g.fillRect(x + 0.32, y + 0.22, 0.05, 0.26);
        g.fillRect(x + 0.64, y + 0.53, 0.05, 0.39);
      }
    }
  }
  gridDirty = false;
}

function drawPowerup({ x, y, type }, now) {
  const cx = x + 0.5;
  const cy = y + 0.5 + Math.sin(now / 250 + x) * 0.03;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.roundRect(cx - 0.34, cy - 0.34, 0.68, 0.68, 0.12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = POWERUP_COLORS[type];
  ctx.strokeStyle = POWERUP_COLORS[type];
  ctx.lineWidth = 0.09;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (type === 'bomb') {
    ctx.arc(cx - 0.02, cy + 0.05, 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 0.09, cy - 0.08);
    ctx.lineTo(cx + 0.18, cy - 0.2);
    ctx.stroke();
  } else if (type === 'range') {
    ctx.moveTo(cx - 0.21, cy);
    ctx.lineTo(cx + 0.21, cy);
    ctx.moveTo(cx, cy - 0.21);
    ctx.lineTo(cx, cy + 0.21);
    ctx.stroke();
  } else {
    for (const offset of [-0.13, 0.05]) {
      ctx.moveTo(cx + offset, cy - 0.16);
      ctx.lineTo(cx + offset + 0.12, cy);
      ctx.lineTo(cx + offset, cy + 0.16);
    }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawBomb(bomb, gameTime) {
  const left = Math.max(0, bomb.explodesAt - gameTime);
  const pulseRate = left < 1000 ? 60 : 130;
  const pulse = Math.sin(gameTime / pulseRate) * 0.025;
  const cx = bomb.x + 0.5;
  const cy = bomb.y + 0.54;
  const radius = 0.33 + pulse;

  ctx.strokeStyle = '#6d5a3c';
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  ctx.moveTo(cx + 0.14, cy - 0.28);
  ctx.quadraticCurveTo(cx + 0.2, cy - 0.44, cx + 0.32, cy - 0.4);
  ctx.stroke();

  ctx.fillStyle = left < 1000 && Math.floor(gameTime / 120) % 2 ? '#b3261e' : COLORS.ink;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.arc(cx - 0.11, cy - 0.11, 0.07, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = Math.floor(gameTime / 80) % 2 ? '#f7c600' : '#e4501b';
  ctx.beginPath();
  ctx.arc(cx + 0.32, cy - 0.4, 0.07, 0, Math.PI * 2);
  ctx.fill();
}

function drawFlames(now) {
  const flames = Object.values(world.flames);
  const layers = [['#e4501b', 0], ['#f79a1f', 0.12], ['#ffe27a', 0.26]];
  for (const [color, inset] of layers) {
    ctx.fillStyle = color;
    for (const flame of flames) {
      const age = flame.born ? (now - flame.born) / 550 : 0.5;
      const wobble = Math.sin(now / 40 + flame.x + flame.y) * 0.015;
      const shrink = inset + Math.max(0, age - 0.6) * 0.5 + wobble;
      ctx.fillRect(flame.x + shrink, flame.y + shrink, 1 - shrink * 2, 1 - shrink * 2);
    }
  }
}

function drawWarnings(now) {
  if (!world.meta.warn) return;
  const alpha = 0.3 + (Math.sin(now / 90) + 1) * 0.2;
  ctx.fillStyle = `rgba(179, 38, 30, ${alpha})`;
  for (const value of world.meta.warn.split(',')) {
    const index = Number(value);
    ctx.fillRect(index % world.width, Math.floor(index / world.width), 1, 1);
  }
}

function drawPlayers(now, renderTime) {
  const entries = Object.entries(world.players)
    .filter(([, player]) => player.alive)
    .map(([slot, player]) => ({ slot, player, ...interpolated(slot, player, renderTime) }))
    .sort((a, b) => a.y - b.y);

  for (const { slot, player, x, y } of entries) {
    if (player.shielded && Math.floor(now / 110) % 2) ctx.globalAlpha = 0.35;
    else if (!player.connected) ctx.globalAlpha = 0.5;

    ctx.fillStyle = 'rgba(29, 27, 24, 0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y + 0.36, 0.3, 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    drawFigure(ctx, x, y - 0.03, 0.42, colorOf(slot), player.lookX, player.lookY);
    ctx.globalAlpha = 1;

    const name = lobbyPlayer(slot)?.name || '';
    ctx.font = '800 0.3px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.09;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(name, x, y - 0.52);
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(name, x, y - 0.52);
  }
}

function drawEffects(now) {
  effects = effects.filter((effect) => now - effect.born < 500);
  for (const effect of effects) {
    const age = (now - effect.born) / 500;
    ctx.strokeStyle = effect.color;
    ctx.globalAlpha = 1 - age;
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, 0.3 + age * 1.1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function render(now) {
  requestAnimationFrame(render);
  if (!world || $('game-view').hidden) return;
  if (gridDirty) drawGridLayer();

  const scale = window.devicePixelRatio || 1;
  const gameTime = serverNow();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(gridLayer, 0, 0);
  ctx.setTransform(scale * tileSize, 0, 0, scale * tileSize, 0, 0);

  drawWarnings(now);
  Object.values(world.powerups).forEach((powerup) => drawPowerup(powerup, now));
  Object.values(world.bombs).forEach((bomb) => drawBomb(bomb, gameTime));
  drawFlames(now);
  drawPlayers(now, gameTime - INTERPOLATION_DELAY_MS);
  drawEffects(now);
}

// Sound, komplett synthetisiert

let audio = null;
let lastBoomAt = 0;

function unlockAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!audio && AudioContextClass) audio = new AudioContextClass();
  audio?.resume?.();
}

function playBeep(frequency) {
  if (!audio || audio.state !== 'running') return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.08, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.2);
}

function playBoom() {
  const nowMs = performance.now();
  if (!audio || audio.state !== 'running' || nowMs - lastBoomAt < 90) return;
  lastBoomAt = nowMs;
  const length = Math.floor(audio.sampleRate * 0.35);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) samples[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  const filter = audio.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500;
  const gain = audio.createGain();
  gain.gain.value = 0.35;
  source.connect(filter).connect(gain).connect(audio.destination);
  source.start();
}

// Verbindung

socket.on('lobby:state', (state) => {
  lobbyState = state;
  renderPhase();
});

socket.on('connect', () => {
  $('server-lost').hidden = true;
  socket.emit('beamer:hello', {}, (result) => {
    isHost = Boolean(result?.isHost);
    renderPhase();
  });
});
socket.on('disconnect', () => { $('server-lost').hidden = false; });

window.addEventListener('resize', () => {
  slotViews.forEach((view) => renderFigureCanvas(view.figure, view.color));
  layoutArena();
});

requestAnimationFrame(render);
