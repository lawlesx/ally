// Serves the page and hands the browser a short-lived conversation token.
// The API key stays here and never reaches the browser.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import {
  readAgentId,
  readMemory,
  refreshGreetings,
  EMPTY_MEMORY,
  rememberCall,
  settled,
  writeMemory,
  takeGreeting,
} from './memory.mjs';
import { lookUp } from './lookup.mjs';
import { archiveMissing, readArchive, recall } from './archive.mjs';

const root = join(import.meta.dirname, 'public');
const port = Number(process.env.PORT) || 5173;
// Local by default. On a host like Railway, listen on all interfaces.
const host = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
const passcode = process.env.ALLY_PASSCODE || '';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

if (host !== '127.0.0.1' && !passcode) {
  console.error('Refusing to start: set ALLY_PASSCODE before running Ally where others can reach her.');
  process.exit(1);
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---- Lock ----
// Every /api call must carry the passcode, so only you can start calls (which
// spend your ElevenLabs and Anthropic credit) or read Ally's memory.
const sha = (s) => createHash('sha256').update(s).digest();
const wrongGuesses = [];

function locked(req) {
  const viaProxy = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'];
  if (!passcode) {
    return viaProxy
      ? [403, 'Set ALLY_PASSCODE in .env before using Ally from another device.']
      : null;
  }
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  while (wrongGuesses.length && wrongGuesses[0] < tenMinutesAgo) wrongGuesses.shift();
  if (wrongGuesses.length >= 10) return [429, 'Too many wrong passcodes. Try again in ten minutes.'];

  let given = '';
  try {
    given = decodeURIComponent(String(req.headers['x-ally-passcode'] || ''));
  } catch {}
  if (timingSafeEqual(sha(given), sha(passcode))) return null;
  if (given) wrongGuesses.push(Date.now());
  return [401, 'locked'];
}

async function token(res, hour) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return json(res, 500, { error: 'No ELEVENLABS_API_KEY in .env yet.' });

  const agentId = await readAgentId();
  if (!agentId) {
    return json(res, 500, { error: 'Ally has not been created yet. Run: bun run setup' });
  }

  // Wait until the previous call has been folded into memory, so Ally doesn't
  // start with stale notes. Usually instant; up to 45s right after a call ends.
  await settled(45_000);

  const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/token');
  url.searchParams.set('agent_id', agentId);
  const r = await fetch(url, { headers: { 'xi-api-key': key } });
  if (!r.ok) {
    console.error(`Token request failed (${r.status}): ${await r.text()}`);
    return json(res, 502, { error: `ElevenLabs refused the session (${r.status}).` });
  }
  json(res, 200, {
    token: (await r.json()).token,
    memory: await readMemory(),
    greeting: await takeGreeting(hour),
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      const refused = locked(req);
      if (refused) return json(res, refused[0], { error: refused[1] });
    }
    if (path === '/api/token') {
      // The caller's local hour, so the greeting fits their time of day.
      const hour = Number(url.searchParams.get('hour'));
      return await token(res, Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null);
    }
    if (path === '/api/lookup' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2000) return json(res, 413, { error: 'Question too long.' });
      }
      const question = body.trim();
      if (!question) return json(res, 400, { error: 'No question.' });
      const started = Date.now();
      const answer = await lookUp(question);
      console.log(`Looked up "${question}" in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return json(res, 200, { answer });
    }
    // The memory page (public/memory.html): read her notes and diary, save edits.
    if (path === '/api/memory' && req.method === 'GET') {
      const memory = await readMemory();
      const diary = (await readArchive())
        .filter((e) => e.note)
        .reverse() // newest first
        .map(({ when, minutes, note }) => ({ when, minutes, note }));
      return json(res, 200, { memory: memory === EMPTY_MEMORY ? '' : memory, diary });
    }
    if (path === '/api/memory' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 20_000) return json(res, 413, { error: 'Too long to save.' });
      }
      await writeMemory(body);
      console.log('Memory edited by hand.');
      return json(res, 200, { saved: true });
    }
    if (path === '/api/recall' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2000) return json(res, 413, { error: 'Question too long.' });
      }
      const question = body.trim();
      if (!question) return json(res, 400, { error: 'No question.' });
      const started = Date.now();
      const answer = await recall(question);
      console.log(`Recalled "${question}" in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return json(res, 200, { answer });
    }
    if (path === '/api/remember' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 200) break;
      }
      const id = /^conv_[a-z0-9]+$/.test(body) ? body : null;
      // Runs in the background: short memory first (the next call waits on
      // it), then the diary entry for the archive.
      rememberCall(id).then(archiveMissing);
      res.writeHead(202);
      return res.end();
    }

    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404);
      return res.end('Not found');
    }
    console.error(err);
    json(res, 500, { error: 'Server error.' });
  }
}).listen(port, host, () => {
  console.log(`Ally is at http://localhost:${port}${passcode ? ' (passcode required)' : ''}`);
  refreshGreetings(); // have openers ready before the first call
  archiveMissing(); // diary entries for any calls that don't have one yet
});
