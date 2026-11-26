'use strict';

function diffFields(previous, next) {
  let changes = null;
  for (const key of Object.keys(next)) {
    if (previous[key] !== next[key]) {
      changes = changes || {};
      changes[key] = next[key];
    }
  }
  return changes;
}

/** Neue Einträge komplett, geänderte nur mit ihren Feldern, entfernte als null. */
function diffMap(previous, next) {
  let changes = null;
  for (const key of Object.keys(next)) {
    const entry = previous[key] ? diffFields(previous[key], next[key]) : next[key];
    if (entry) {
      changes = changes || {};
      changes[key] = entry;
    }
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) {
      changes = changes || {};
      changes[key] = null;
    }
  }
  return changes;
}

function diffSnapshot(previous, next) {
  const delta = { t: next.t };

  const grid = [];
  next.grid.forEach((value, index) => {
    if (previous.grid[index] !== value) grid.push([index, value]);
  });
  if (grid.length) delta.grid = grid;

  for (const key of ['players', 'bombs', 'flames', 'powerups']) {
    const changes = diffMap(previous[key], next[key]);
    if (changes) delta[key] = changes;
  }

  const meta = diffFields(previous.meta, next.meta);
  if (meta) delta.meta = meta;
  return delta;
}

module.exports = { diffSnapshot };
