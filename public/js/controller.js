'use strict';

const TOKEN_KEY = 'lunte.token';
const NAME_KEY = 'lunte.name';
const DPAD_DEADZONE = 0.16;
const DPAD_VECTORS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const SEND_INTERVAL_MS = 33;

const socket = io();
const $ = (id) => document.getElementById(id);
const screens = {
  connecting: $('connecting-screen'),
  join: $('join-screen'),
  wait: $('wait-screen'),
  pad: $('pad-screen'),
  replaced: $('replaced-screen'),
};

let currentPlayer = null;
let currentStatus = null;
let activeScreen = 'connecting';

// localStorage kann im privaten Modus fehlen; dann gibt es nur keinen Reconnect.
function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStored(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* ohne Speicher weiterspielen */ }
}

function showScreen(name) {
  if (activeScreen === 'pad' && name !== 'pad') releaseDpad();
  activeScreen = name;
  for (const [key, element] of Object.entries(screens)) element.hidden = key !== name;
  if (name === 'wait' && currentPlayer) renderFigureCanvas($('figure'), currentPlayer.color.hex);
}

function showJoin(error = '') {
  currentPlayer = null;
  currentStatus = null;
  document.body.classList.remove('joined');
  document.body.style.removeProperty('--player');
  document.body.style.removeProperty('--player-ink');
  $('join-error').textContent = error;
  $('join-button').disabled = false;
  if (!$('name').value) $('name').value = readStored(NAME_KEY) || '';
  showScreen('join');
}

function setPlayer(player) {
  currentPlayer = player;
  writeStored(TOKEN_KEY, player.token);
  document.body.classList.add('joined');
  document.body.style.setProperty('--player', player.color.hex);
  document.body.style.setProperty('--player-ink', player.color.ink);
  $('color-name').textContent = `Du bist ${player.color.name}`;
  $('player-name').textContent = player.name;
  $('pad-name').textContent = `${player.name} · ${player.color.name}`;
  renderStatus();
}

function waitMessage(status) {
  if (!status) return 'Warte auf den Start …';
  if (status.phase === 'scoreboard') {
    if (status.won) return 'Du hast gewonnen!';
    return status.draw ? 'Unentschieden. Gleich geht es weiter.' : 'Runde vorbei. Gleich geht es weiter.';
  }
  if (status.phase === 'lobby') return 'Warte auf den Start …';
  if (status.inRound) return 'Ausgeschieden. Schau am Beamer zu.';
  return 'Du spielst ab der nächsten Runde mit.';
}

function renderStatus() {
  if (!currentPlayer) return;
  const status = currentStatus;
  const onPad = status && status.inRound && status.alive
    && (status.phase === 'countdown' || status.phase === 'playing');

  if (onPad) {
    $('pad-lives').textContent = '♥'.repeat(status.lives);
    $('pad-lives').setAttribute('aria-label', `${status.lives} Leben`);
    $('pad-powers').textContent = `Bomben ${status.bombs} · Weite ${status.range} · Tempo ${status.speed}`;
    $('pad-count').hidden = !status.count;
    $('pad-count').textContent = status.count || '';
    showScreen('pad');
  } else {
    $('wait-message').textContent = socket.connected ? waitMessage(status) : 'Verbindung weg, verbinde neu …';
    $('leave-button').hidden = Boolean(status && status.phase !== 'lobby' && status.phase !== 'scoreboard');
    showScreen('wait');
  }
  $('pad-link').hidden = socket.connected;
}

function resume() {
  const token = readStored(TOKEN_KEY);
  if (!token) return showJoin();
  return socket.emit('player:resume', { token }, (result) => {
    if (result.ok) return setPlayer(result.player);
    writeStored(TOKEN_KEY, null);
    return showJoin();
  });
}

// Vollbild und wach bleibendes Display

let wakeLock = null;
let keepAwakeVideo = null;

function enterFullscreen() {
  const root = document.documentElement;
  if (!root.requestFullscreen || document.fullscreenElement) return;
  root.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation?.lock?.('landscape'))
    .catch(() => { /* nicht jedes Handy erlaubt das */ });
}

/** Die Wake-Lock-API gibt es nur über HTTPS, im LAN greift ein stummes Video als Ersatz. */
function startKeepAwakeVideo() {
  if (keepAwakeVideo) {
    keepAwakeVideo.play().catch(() => {});
    return;
  }
  const source = document.createElement('canvas');
  source.width = 2;
  source.height = 2;
  if (!source.captureStream) return;
  const paint = source.getContext('2d');
  let tick = 0;
  setInterval(() => {
    tick += 1;
    paint.fillStyle = tick % 2 ? '#000000' : '#010101';
    paint.fillRect(0, 0, 2, 2);
  }, 1000);
  keepAwakeVideo = document.createElement('video');
  keepAwakeVideo.muted = true;
  keepAwakeVideo.playsInline = true;
  keepAwakeVideo.setAttribute('playsinline', '');
  keepAwakeVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
  keepAwakeVideo.srcObject = source.captureStream(1);
  document.body.append(keepAwakeVideo);
  keepAwakeVideo.play().catch(() => {});
}

async function keepScreenAwake() {
  if (!('wakeLock' in navigator)) {
    startKeepAwakeVideo();
    return;
  }
  if (wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    startKeepAwakeVideo();
  }
}

function prepareDevice() {
  enterFullscreen();
  keepScreenAwake();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentPlayer) keepScreenAwake();
});

// Pfeiltasten: Der Daumen darf ohne Absetzen von einer Richtung zur nächsten gleiten.

const dpad = { pointerId: null, direction: null, x: 0, y: 0 };
let lastSent = { x: 0, y: 0 };

function directionAt(clientX, clientY) {
  const box = $('dpad').getBoundingClientRect();
  const dx = clientX - (box.left + box.width / 2);
  const dy = clientY - (box.top + box.height / 2);
  if (Math.hypot(dx, dy) < (box.width / 2) * DPAD_DEADZONE) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

function setDirection(direction) {
  if (direction === dpad.direction) return;
  dpad.direction = direction;
  [dpad.x, dpad.y] = direction ? DPAD_VECTORS[direction] : [0, 0];
  for (const arrow of $('dpad').children) {
    arrow.classList.toggle('active', arrow.dataset.direction === direction);
  }
  sendMove();
}

function sendMove() {
  if (!socket.connected || (dpad.x === lastSent.x && dpad.y === lastSent.y)) return;
  lastSent = { x: dpad.x, y: dpad.y };
  socket.emit('input:move', lastSent);
}

function releaseDpad() {
  dpad.pointerId = null;
  setDirection(null);
  sendMove();
}

$('stick-zone').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  prepareDevice();
  if (dpad.pointerId !== null) return;
  dpad.pointerId = event.pointerId;
  try {
    $('stick-zone').setPointerCapture(event.pointerId);
  } catch { /* die Pfeile funktionieren auch ohne Capture */ }
  setDirection(directionAt(event.clientX, event.clientY));
});

$('stick-zone').addEventListener('pointermove', (event) => {
  if (event.pointerId === dpad.pointerId) setDirection(directionAt(event.clientX, event.clientY));
});

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('stick-zone').addEventListener(type, (event) => {
    if (event.pointerId === dpad.pointerId) releaseDpad();
  });
}

// Wiederholt verlorene Änderungen, etwa direkt nach einem Reconnect.
setInterval(sendMove, SEND_INTERVAL_MS);

// Bomben-Knopf reagiert schon beim Berühren, nicht erst beim Loslassen.

$('bomb-button').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  prepareDevice();
  $('bomb-button').classList.add('pressed');
  socket.emit('input:bomb');
  navigator.vibrate?.(35);
});

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('bomb-button').addEventListener(type, () => $('bomb-button').classList.remove('pressed'));
}

// Beitreten und Verbindung

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('name').value;
  $('name').blur();
  $('join-button').disabled = true;
  prepareDevice();
  socket.timeout(5000).emit('player:join', { name }, (timeoutError, result) => {
    if (timeoutError) return showJoin('Keine Antwort vom Server. Bitte nochmal versuchen.');
    if (!result.ok) return showJoin(result.error);
    writeStored(NAME_KEY, result.player.name);
    return setPlayer(result.player);
  });
});

$('leave-button').addEventListener('click', () => {
  socket.emit('player:leave', {}, () => {
    writeStored(TOKEN_KEY, null);
    showJoin();
  });
});

$('take-over-button').addEventListener('click', resume);

socket.on('connect', () => {
  lastSent = { x: 0, y: 0 };
  resume();
});

socket.on('disconnect', () => {
  if (currentPlayer) renderStatus();
  else showScreen('connecting');
});

socket.on('player:status', (status) => {
  const justStarted = status.phase === 'countdown' && currentStatus?.phase !== 'countdown';
  currentStatus = status;
  if (justStarted) navigator.vibrate?.(60);
  renderStatus();
});

socket.on('player:replaced', () => {
  currentPlayer = null;
  showScreen('replaced');
});

window.addEventListener('resize', () => {
  if (currentPlayer && activeScreen === 'wait') renderFigureCanvas($('figure'), currentPlayer.color.hex);
});

// Zoom, Kontextmenü und Pull-to-Refresh auch dort abfangen, wo CSS nicht reicht.
for (const type of ['gesturestart', 'contextmenu', 'dblclick']) {
  document.addEventListener(type, (event) => event.preventDefault());
}
document.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
