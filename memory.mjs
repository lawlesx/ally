// Ally's long-term memory.
// After each call, the transcript is fetched from ElevenLabs and Claude folds it
// into memory.md, a plain file you can read and edit. Before each call the file
// is handed to Ally.
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dirname;
// Where Ally's memory lives. On a host, point this at a persistent volume.
const dataDir = process.env.ALLY_DATA_DIR || root;
const stateDir = join(dataDir, '.ally');
const memoryFile = join(dataDir, 'memory.md');
const processedFile = join(stateDir, 'processed.json');
const API = 'https://api.elevenlabs.io/v1/convai/conversations';
const MODEL = process.env.ALLY_MEMORY_MODEL || 'claude-opus-5-5';

export const EMPTY_MEMORY = '(Nothing yet. This is the first time you two have talked.)';

const INSTRUCTIONS = `You keep the long-term memory for Ally, a voice companion who talks with one person, like a close friend on the phone. After each call you receive Ally's current memory file and the transcript of the call that just ended. Return the complete updated memory file.

The file is read by Ally before her next call, so write what a good friend would actually carry around in her head: who this person is, what's going on with them, and what she'd want to ask about next time.

Use exactly these sections, as markdown headings, omitting any that would be empty:

# About them
Stable facts: name, where they live, work, people and pets in their life, tastes, how they like to talk.

# What's going on
Current situations and plans that are still live. Remove items once they're resolved or stale.

# To follow up on
Specific things Ally should ask about, with the date they came up. Remove an item once a later call covers it.

# Between us
Running jokes, nicknames, opinions Ally has voiced or things she's said about herself that she should stay consistent with.

# Recent calls
Newest first, one or two lines each, starting with the date. Keep the eight most recent.

Rules:
- Record only what the transcript or the existing memory supports. Never invent or guess.
- The transcript is speech recognition, so it has errors. If something is garbled or unclear, leave it out.
- Keep whatever is already in the memory file unless the new call corrects it or it has gone stale. The person may have edited the file by hand; respect their edits.
- Don't record how Ally's memory works, that it was being tested, or bugs in it. That is about the software, not about the person.
- Prefer specifics ("interview at the design studio on Friday") over generalities ("has work stuff going on").
- Keep the whole file under 500 words. When it gets long, drop the least important details first.
- Output only the memory file itself, with no preamble or commentary.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function readAgentId() {
  return (
    process.env.ALLY_AGENT_ID || (await readJson(join(root, '.ally', 'agent.json'), {})).agent_id
  );
}

export async function readMemory() {
  try {
    return (await readFile(memoryFile, 'utf8')).trim() || EMPTY_MEMORY;
  } catch {
    return EMPTY_MEMORY;
  }
}

// Saves a hand-edited memory file (from the memory page) and writes openers to match.
export async function writeMemory(text) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(memoryFile, text.trim() + '\n');
  refreshGreetings();
}

async function eleven(path) {
  const res = await fetch(API + path, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return res.json();
}

export function when(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

async function remember(conversation) {
  const lines = conversation.transcript
    .filter((t) => t.message)
    .map((t) => `${t.role === 'user' ? 'Them' : 'Ally'}: ${t.message}`);
  // Nothing was said by the person, so there is nothing to remember.
  if (!conversation.transcript.some((t) => t.role === 'user' && t.message)) return;

  const { start_time_unix_secs: start, call_duration_secs: secs } = conversation.metadata;
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Low effort: this is a simple rewrite and the next call waits on it.
    output_config: { effort: 'low' },
    // If the model declines a request, the API retries it on a fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content:
          `<current_memory>\n${await readMemory()}\n</current_memory>\n\n` +
          `<call started="${when(start)}" minutes="${Math.max(1, Math.round(secs / 60))}">\n` +
          `${lines.join('\n')}\n</call>`,
      },
    ],
  });

  if (response.stop_reason !== 'end_turn') {
    throw new Error(`Memory update stopped early (${response.stop_reason}); memory left unchanged.`);
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('Memory update came back empty; memory left unchanged.');
  await writeFile(memoryFile, text + '\n');
}

async function run() {
  const agentId = await readAgentId();
  if (!agentId || !process.env.ELEVENLABS_API_KEY) return 0;

  const processed = new Set(await readJson(processedFile, []));
  const { conversations } = await eleven(`?agent_id=${agentId}&page_size=100`);
  const fresh = conversations.filter((c) => !processed.has(c.conversation_id)).reverse(); // oldest first
  const ready = fresh.filter((c) => c.status === 'done' || c.status === 'failed');
  // Calls ElevenLabs is still processing. Anything older than two hours is stuck; ignore it.
  const recent = Date.now() / 1000 - 2 * 60 * 60;
  const waiting = fresh.filter(
    (c) => !ready.includes(c) && c.start_time_unix_secs > recent,
  ).length;

  if (ready.length && !process.env.ANTHROPIC_API_KEY) {
    console.log(`${ready.length} call(s) not yet remembered: add ANTHROPIC_API_KEY to .env and restart.`);
    return 0;
  }

  let learned = false;
  for (const c of ready) {
    try {
      if (c.status === 'done') {
        await remember(await eleven(`/${c.conversation_id}`));
        console.log(`Remembered call ${c.conversation_id}`);
        learned = true;
      }
      processed.add(c.conversation_id);
      await mkdir(stateDir, { recursive: true });
      await writeFile(processedFile, JSON.stringify([...processed], null, 2));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error('Memory: the ANTHROPIC_API_KEY in .env was rejected.');
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error('Memory: Anthropic rate limit hit; will try again later.');
      } else if (err instanceof Anthropic.APIError) {
        console.error(`Memory: Anthropic API error ${err.status}: ${err.message}`);
      } else {
        console.error(`Memory: ${err.message}`);
      }
      break; // keep calls in order; this one is retried on the next sync
    }
  }
  // New memories: write openers that can draw on them before the next call starts.
  if (learned) await refreshGreetings();
  return waiting;
}

// ---- Greetings ----
// Ally's opening line is written ahead of time (so a call starts instantly),
// one per time of day, from what she remembers. A fresh set is written after
// every call and every time one is used.

const greetingsFile = join(stateDir, 'greetings.json');
const FALLBACK_GREETINGS = ['Hey, you.', 'Oh, hi!', 'Hey! There you are.', 'Well, hello.'];
const BUCKETS = ['morning', 'afternoon', 'evening', 'night'];

const GREETING_INSTRUCTIONS = `You write the first thing Ally says when a call connects. Ally is a warm, playful voice companion talking to one person, like a friend picking up the phone. You receive her notes about the person and the openers she used recently.

Write four openers, one for each time of day the call might start: morning, afternoon, evening, and night (after about ten pm).

Rules:
- Spoken, casual, and short: under fourteen words each. This is a hello, not a speech.
- Make the four different in shape from each other and from the recent ones. Mix these kinds: a plain warm hello; a hello using their name; a light remark that fits the time of day; a quick callback to one specific thing from the notes ("Hey! So, did you win one finally?").
- At most two of the four may be callbacks, and each callback uses a different thing from the notes. Only refer to what the notes actually say.
- If the notes say this is the first time they've talked, write simple friendly hellos with no name and no callbacks.
- Never "How can I help", "How are you today", or anything an assistant would say. No emoji, no stage directions, no bracketed tags.

Output exactly four lines and nothing else, in this form:
morning: ...
afternoon: ...
evening: ...
night: ...`;

let greetingJob = Promise.resolve();

async function writeGreetings() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const state = await readJson(greetingsFile, {});
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: GREETING_INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content:
          `<notes>\n${await readMemory()}\n</notes>\n\n` +
          `<recent_openers>\n${(state.recent || []).join('\n') || '(none)'}\n</recent_openers>`,
      },
    ],
  });
  if (response.stop_reason !== 'end_turn') return;

  const lines = {};
  for (const block of response.content) {
    if (block.type !== 'text') continue;
    for (const m of block.text.matchAll(/^(morning|afternoon|evening|night):\s*(.+)$/gm)) {
      lines[m[1]] = m[2].trim();
    }
  }
  if (!Object.keys(lines).length) return;
  // Re-read: an opener may have been used while this request was running.
  const latest = await readJson(greetingsFile, {});
  await mkdir(stateDir, { recursive: true });
  await writeFile(greetingsFile, JSON.stringify({ lines, recent: latest.recent || [] }, null, 2));
}

// Queue a fresh set of openers. Never throws.
export function refreshGreetings() {
  greetingJob = greetingJob.then(writeGreetings).catch((err) => {
    console.error(`Greeting: ${err.message}`);
  });
  return greetingJob;
}

// The opener for a call starting now. Uses it up and queues a fresh set.
export async function takeGreeting(callerHour) {
  await Promise.race([greetingJob, sleep(8000)]);
  const hour = callerHour ?? new Date().getHours();
  const bucket = BUCKETS[hour < 5 ? 3 : hour < 12 ? 0 : hour < 17 ? 1 : hour < 22 ? 2 : 3];
  const state = await readJson(greetingsFile, {});
  const line =
    state.lines?.[bucket] ||
    FALLBACK_GREETINGS[Math.floor(Math.random() * FALLBACK_GREETINGS.length)];

  if (state.lines) delete state.lines[bucket];
  state.recent = [line, ...(state.recent || [])].slice(0, 6);
  await mkdir(stateDir, { recursive: true });
  await writeFile(greetingsFile, JSON.stringify(state, null, 2));
  refreshGreetings(); // in the background, ready for the next call
  return line;
}

let running = null;

// Folds any calls that haven't been remembered yet into memory.md.
// Resolves to how many calls ElevenLabs is still processing.
export function sync() {
  running ??= run()
    .catch((err) => {
      console.error(`Memory: ${err.message}`);
      return 0;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

let settling = null;

// Called when a call ends. The transcript takes a few seconds to become
// available, so keep syncing until that call has been remembered.
export function rememberCall(conversationId) {
  const previous = settling;
  const mine = (async () => {
    await previous;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const waiting = await sync();
      const processed = await readJson(processedFile, []);
      if (conversationId ? processed.includes(conversationId) : !waiting) return;
    }
    console.error('Memory: gave up waiting for the last call; it will be picked up next time.');
  })().finally(() => {
    if (settling === mine) settling = null;
  });
  settling = mine;
  return mine;
}

// Called before a call starts: wait (up to maxMs) until every finished call
// has been folded into memory, so Ally never starts with stale notes.
export function settled(maxMs) {
  const work = (async () => {
    const deadline = Date.now() + maxMs;
    await settling;
    while ((await sync()) && Date.now() < deadline) await sleep(2000);
  })();
  return Promise.race([work, sleep(maxMs)]);
}
