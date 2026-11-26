'use strict';

const os = require('os');

const VIRTUAL_INTERFACE =
  /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|tailscale|zt|utun|llw|awdl)|virtualbox|vmware|loopback|hyper-v/i;
const WIRELESS_INTERFACE = /^(wl|wi-?fi|wlan)/i;

function isPrivateIPv4(address) {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/** Wählt die Adresse, unter der Handys den Laptop am wahrscheinlichsten erreichen. */
function findLanAddress(interfaces = os.networkInterfaces()) {
  if (process.env.LAN_IP) return process.env.LAN_IP;

  let best = null;
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of addresses || []) {
      const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIPv4 || entry.internal || entry.address.startsWith('169.254.')) continue;
      const score =
        (isPrivateIPv4(entry.address) ? 2 : 0) + (WIRELESS_INTERFACE.test(name) ? 1 : 0);
      if (!best || score > best.score) best = { address: entry.address, score };
    }
  }
  return best ? best.address : null;
}

module.exports = { findLanAddress };
