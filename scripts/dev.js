'use strict';

// Aufruf: npm run dev -- 8           verbindet 8 Bots, gestartet wird am Beamer
//         npm run dev -- 8 --start   startet Runden zusätzlich automatisch
// Läuft noch kein Server, wird er mitgestartet.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { io } = require('socket.io-client');
const { PORT, MAX_PLAYERS } = require('../server/config');

const BASE_URL = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const autoStart = args.includes('--start');
const botCount = Number(args.find((arg) => !arg.startsWith('--')) ?? MAX_PLAYERS);

if (!Number.isInteger(botCount) || botCount < 1 || botCount > MAX_PLAYERS) {
  console.error(`Anzahl Bots muss zwischen 1 und ${MAX_PLAYERS} liegen.`);
  process.exit(1);
}

function isServerRunning() {
  return new Promise((resolve) => {
    const request = http.get(`${BASE_URL}/healthz`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(500, () => request.destroy());
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isServerRunning()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server ist nicht gestartet.');
}

function connectBot(number) {
  const socket = io(BASE_URL);
  let moveTimer = null;

  const act = () => {
    const angle = Math.random() * Math.PI * 2;
    socket.emit('input:move', { x: Math.cos(angle), y: Math.sin(angle) });
    if (Math.random() < 0.35) socket.emit('input:bomb');
    moveTimer = setTimeout(act, 250 + Math.random() * 800);
  };

  socket.on('connect', () => {
    socket.emit('player:join', { name: `Bot ${number}` }, (result) => {
      if (!result.ok) {
        console.log(`Bot ${number}: ${result.error}`);
        return;
      }
      console.log(`Bot ${number}: ${result.player.color.name}`);
      clearTimeout(moveTimer);
      act();
    });
  });
  socket.on('disconnect', () => clearTimeout(moveTimer));
  return socket;
}

function connectAutoHost() {
  const socket = io(BASE_URL);
  let pending = null;
  socket.on('lobby:state', (state) => {
    const waiting = state.phase === 'lobby' || state.phase === 'scoreboard';
    const enoughPlayers = state.players.filter((p) => p.connected).length >= Math.min(botCount, 2);
    if (waiting && enoughPlayers && !pending) {
      pending = setTimeout(() => {
        pending = null;
        socket.emit('host:start', {}, () => {});
      }, 3000);
    }
  });
  return socket;
}

async function main() {
  let serverProcess = null;
  if (!(await isServerRunning())) {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      stdio: 'inherit',
    });
    await waitForServer();
  }

  const sockets = Array.from({ length: botCount }, (_, index) => connectBot(index + 1));
  if (autoStart) sockets.push(connectAutoHost());

  process.on('SIGINT', () => {
    sockets.forEach((socket) => socket.close());
    if (serverProcess) serverProcess.kill();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
