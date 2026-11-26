'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { HOST, PORT, RATE_LIMITS, NETWORK_CHECK_MS } = require('./config');
const { Lobby } = require('./lobby');
const { Match } = require('./match');
const { findLanAddress } = require('./network');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 4096,
  // Großzügig, weil WLAN-Aussetzer von mehreren Sekunden vorkommen:
  // Ein Handy gilt erst nach rund 20 Sekunden Funkstille als getrennt.
  pingInterval: 5000,
  pingTimeout: 15000,
});

function currentJoinUrl() {
  const address = findLanAddress();
  return address ? `http://${address}:${PORT}/` : null;
}

let joinUrl = currentJoinUrl();

const lobby = new Lobby({ onChange: broadcastState });
const match = new Match({ io, lobby, onPhaseChange: broadcastState });

function stateForClients() {
  return { ...lobby.publicState(), ...match.publicState(), joinUrl };
}

function broadcastState() {
  io.emit('lobby:state', stateForClients());
}

// Ein WLAN-Wechsel oder ein später aktivierter Hotspot ändert die Adresse.
setInterval(() => {
  const nextUrl = currentJoinUrl();
  if (nextUrl !== joinUrl) {
    joinUrl = nextUrl;
    broadcastState();
  }
}, NETWORK_CHECK_MS).unref();

app.get('/healthz', (_req, res) => res.json({ game: 'lunte', ok: true }));

app.get('/qr.svg', async (_req, res) => {
  if (!joinUrl) return res.sendStatus(404);
  try {
    const svg = await QRCode.toString(joinUrl, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
    });
    return res.set('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  } catch (error) {
    console.error('QR-Code fehlgeschlagen:', error);
    return res.sendStatus(500);
  }
});

app.get('/beamer', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'beamer.html')));
app.use(express.static(PUBLIC_DIR));

function createRateLimiter(limit) {
  let windowStart = 0;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= limit;
  };
}

/** Fehlerhafte oder zu häufige Nachrichten dürfen den Server nie stören. */
function guardedHandler(socket, isAllowed, handler) {
  return (payload, maybeAck) => {
    const ack = typeof maybeAck === 'function' ? maybeAck : () => {};
    if (!isAllowed()) return ack({ ok: false, error: 'Zu viele Anfragen.' });
    try {
      return handler(payload && typeof payload === 'object' ? payload : {}, ack);
    } catch (error) {
      console.error(`Fehler bei Client ${socket.id}:`, error);
      return ack({ ok: false, error: 'Serverfehler.' });
    }
  };
}

function ownPlayerView(player) {
  return { token: player.token, ...lobby.publicPlayer(player) };
}

io.on('connection', (socket) => {
  const limiters = {
    control: createRateLimiter(RATE_LIMITS.control),
    move: createRateLimiter(RATE_LIMITS.move),
    bomb: createRateLimiter(RATE_LIMITS.bomb),
  };
  const on = (event, limiter, handler) => {
    socket.on(event, guardedHandler(socket, limiter, handler));
  };
  // Nur der Laptop selbst darf Runden starten, nicht ein Handy mit der Beamer-URL.
  const isHost = LOOPBACK_ADDRESSES.has(socket.handshake.address);
  const onHost = (event, action) => {
    on(event, limiters.control, (_payload, ack) => {
      ack(isHost ? action() : { ok: false, error: 'Nur am Laptop möglich.' });
    });
  };

  socket.emit('lobby:state', stateForClients());

  on('beamer:hello', limiters.control, (_payload, ack) => {
    match.addBeamer(socket);
    ack({ ok: true, isHost });
  });

  onHost('host:start', () => match.start());
  onHost('host:lobby', () => match.backToLobby());

  on('player:join', limiters.control, ({ name }, ack) => {
    const result = lobby.join(name, socket.id);
    if (!result.ok) return ack(result);
    match.syncStatuses();
    return ack({ ok: true, player: ownPlayerView(result.player) });
  });

  on('player:resume', limiters.control, ({ token }, ack) => {
    const result = lobby.resume(token, socket.id);
    if (!result.ok) return ack({ ok: false });
    if (result.replacedSocketId) io.to(result.replacedSocketId).emit('player:replaced');
    match.setConnected(result.player, true);
    return ack({ ok: true, player: ownPlayerView(result.player) });
  });

  on('player:leave', limiters.control, (_payload, ack) => {
    const player = lobby.leave(socket.id);
    if (player) match.playerLeft(player);
    ack({ ok: true });
  });

  on('input:move', limiters.move, ({ x, y }) => {
    const player = lobby.findBySocket(socket.id);
    if (player) match.move(player, x, y);
  });

  on('input:bomb', limiters.bomb, () => {
    const player = lobby.findBySocket(socket.id);
    if (player) match.bomb(player);
  });

  socket.on('disconnect', () => {
    const player = lobby.disconnect(socket.id);
    if (player) match.setConnected(player, false);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} ist belegt. Läuft der Server schon?`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log('\nLunte läuft.');
  console.log(`  Beamer:  http://localhost:${PORT}/beamer`);
  console.log(`  Handys:  ${joinUrl || 'kein Netzwerk gefunden, WLAN oder Hotspot verbinden'}\n`);
});
