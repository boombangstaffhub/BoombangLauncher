// Ping to the real game server (ICMP, the same thing as `ping 144.217.195.55` in a console).
const { execFile } = require('child_process');

const DEFAULT_PING_HOST = '144.217.195.55';

// Understands Windows (EN/ES/DE/FR/PT) and Linux/macOS ping output.
function parsePingOutput(text) {
  const out = String(text || '');
  let m = out.match(/(?:time|tiempo|zeit|temps|tempo)\s*([=<])\s*(\d+(?:[.,]\d+)?)\s*ms?/i);
  if (!m) m = out.match(/([=<])\s*(\d+(?:[.,]\d+)?)\s*ms\b/i);
  if (!m) return null;
  const value = Number(String(m[2]).replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.round(value));
}

function validHost(host) {
  return typeof host === 'string' && /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host);
}

function pingHost(host = DEFAULT_PING_HOST, timeoutMs = 2000) {
  if (!validHost(host)) return Promise.resolve(null);
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(timeoutMs), host]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
  return new Promise(resolve => {
    try {
      execFile('ping', args, { timeout: timeoutMs + 1500, windowsHide: true }, (error, stdout) => {
        resolve(parsePingOutput(stdout));
      });
    } catch (_) { resolve(null); }
  });
}

// Median of the last N samples: a lost packet or a spike no longer makes the number jump.
class RttTracker {
  constructor(size = 5) { this.size = size; this.samples = []; }
  add(value) {
    if (!Number.isFinite(value)) return;
    this.samples.push(value);
    while (this.samples.length > this.size) this.samples.shift();
  }
  median() {
    if (!this.samples.length) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
}

module.exports = { pingHost, parsePingOutput, RttTracker, DEFAULT_PING_HOST };
