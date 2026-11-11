import { Conversation } from '@elevenlabs/client';

const orb = document.getElementById('orb');
const label = document.getElementById('label');
const lock = document.getElementById('lock');
const lockInput = document.getElementById('passcode');
const muteButton = document.getElementById('mute');

let muted = false;
let conversation = null;
let state = 'idle'; // idle | connecting | listening | speaking
let level = 0;

// ---- Passcode ----
// Kept in this browser only. A link ending in #<passcode> unlocks a new device
// in one step; the part after # is never sent to the server by the browser.
const store = {
  get: () => {
    try {
      return localStorage.getItem('ally-passcode') || '';
    } catch {
      return '';
    }
  },
  set: (v) => {
    try {
      localStorage.setItem('ally-passcode', v);
    } catch {}
  },
};
let passcode = store.get();
if (location.hash.length > 1) {
  passcode = decodeURIComponent(location.hash.slice(1));
  store.set(passcode);
  history.replaceState(null, '', location.pathname);
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { ...options.headers, 'x-ally-passcode': encodeURIComponent(passcode) },
  });
}

function askForPasscode(message) {
  setState('idle', message);
  lock.hidden = false;
  lockInput.value = '';
  lockInput.focus();
}

lock.addEventListener('submit', (e) => {
  e.preventDefault();
  passcode = lockInput.value.trim();
  if (!passcode) return;
  store.set(passcode);
  lock.hidden = true;
  start();
});

// ---- Call ----
function setState(next, text) {
  state = next;
  document.body.dataset.state = next;
  const inCall = next === 'listening' || next === 'speaking';
  if (!inCall) setMuted(false);
  muteButton.hidden = !inCall;
  label.textContent =
    text ??
    (inCall && muted
      ? 'Mic paused. Ally can’t hear you.'
      : { idle: 'Tap to talk to Ally', connecting: 'Connecting…', listening: '', speaking: '' }[next]);
  orb.setAttribute('aria-label', next === 'idle' ? 'Start talking to Ally' : 'End the conversation');
}

// Pausing the mic only stops sending your voice; the call and Ally carry on.
function setMuted(on) {
  muted = on;
  try {
    conversation?.setMicMuted(on);
  } catch (err) {
    console.error(err);
  }
  muteButton.setAttribute('aria-pressed', String(on));
  muteButton.textContent = on ? 'Resume mic' : 'Pause mic';
  document.body.toggleAttribute('data-muted', on);
}
muteButton.addEventListener('click', () => {
  if (!conversation) return;
  setMuted(!muted);
  setState(state);
});

// Keep the phone screen on during a call; a locked screen cuts the microphone.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on) wakeLock = await navigator.wakeLock?.request('screen');
    else await wakeLock?.release();
  } catch {}
  if (!on) wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && conversation) keepAwake(true);
});

async function start() {
  setState('connecting');
  try {
    // Right after a call, the server waits until that call is in Ally's memory.
    const slow = setTimeout(() => {
      if (state === 'connecting') label.textContent = 'Ally is thinking back over last time…';
    }, 1500);
    const res = await api(`/api/token?hour=${new Date().getHours()}`).finally(() =>
      clearTimeout(slow),
    );
    const data = await res.json();
    if (res.status === 401) {
      return askForPasscode(passcode ? "That passcode didn't work." : 'Enter your passcode.');
    }
    if (!res.ok) throw new Error(data.error || 'Could not start a session.');

    // Ask for the mic before connecting, so the permission prompt comes first.
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.getTracks().forEach((t) => t.stop());

    conversation = await Conversation.startSession({
      conversationToken: data.token,
      connectionType: 'webrtc',
      // Ally's look_up tool: the server searches the web and returns a short answer.
      clientTools: {
        look_up: async ({ question }) => {
          try {
            const r = await api('/api/lookup', { method: 'POST', body: String(question ?? '') });
            const d = await r.json();
            return d.answer || d.error || "I couldn't find anything on that.";
          } catch {
            return "Looking things up isn't working right now.";
          }
        },
        // Ally's recall tool: the server searches her notes on every earlier call.
        recall: async ({ question }) => {
          try {
            const r = await api('/api/recall', { method: 'POST', body: String(question ?? '') });
            const d = await r.json();
            return d.answer || d.error || 'Nothing about that in earlier calls.';
          } catch {
            return "It's not coming back to me right now.";
          }
        },
      },
      dynamicVariables: {
        memory: data.memory,
        greeting: data.greeting,
        now: new Date().toLocaleString('en-GB', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }),
      },
      onConnect: ({ conversationId: id } = {}) => {
        conversationId = id ?? conversationId;
        setState('listening');
      },
      onDisconnect: () => {
        conversation = null;
        if (state !== 'idle') setState('idle');
        keepAwake(false);
        remember();
      },
      onModeChange: ({ mode }) => {
        if (conversation) setState(mode === 'speaking' ? 'speaking' : 'listening');
      },
      onMessage: (m) => console.log(`${m.source ?? m.role ?? '?'}: ${m.message ?? ''}`),
      onError: (message) => {
        console.error(message);
        setState('idle', String(message));
      },
    });
    conversationId = conversation.getId() || conversationId;
    keepAwake(true);
  } catch (err) {
    console.error(err);
    conversation = null;
    const denied = err?.name === 'NotAllowedError';
    setState('idle', denied ? 'Ally needs microphone access.' : err.message);
  }
}

// Tell the server a call just ended so it can fold it into Ally's memory.
let conversationId = null;
function remember() {
  if (!conversationId) return;
  // keepalive lets the request finish even if the page is closing.
  api('/api/remember', { method: 'POST', body: conversationId, keepalive: true }).catch(() => {});
  conversationId = null;
}
window.addEventListener('pagehide', () => {
  if (conversation) remember();
});

async function stop() {
  const c = conversation;
  conversation = null;
  setState('idle');
  keepAwake(false);
  try {
    await c?.endSession();
  } catch (err) {
    console.error(err);
  }
}

orb.addEventListener('click', () => {
  if (state === 'idle') {
    lock.hidden = true;
    start();
  } else if (state !== 'connecting') stop();
});

// The orb breathes with whoever is speaking.
async function frame() {
  let target = 0;
  if (conversation) {
    try {
      target = await (state === 'speaking'
        ? conversation.getOutputVolume()
        : conversation.getInputVolume());
    } catch {}
  }
  level += ((target || 0) - level) * 0.25;
  orb.style.setProperty('--level', level.toFixed(3));
  requestAnimationFrame(frame);
}

setState('idle');
frame();
