// Ally's long memory. memory.md is short on purpose, so old details fall out of
// it. Here every call gets its own detailed note, kept for good in archive.json,
// and Ally can search them mid-call with her recall tool.
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readAgentId, when } from './memory.mjs';

const dataDir = process.env.ALLY_DATA_DIR || import.meta.dirname;
const archiveFile = join(dataDir, 'archive.json');
const API = 'https://api.elevenlabs.io/v1/convai/conversations';
const NOTE_MODEL = process.env.ALLY_MEMORY_MODEL || 'claude-opus-5-5';
// Recall happens mid-call with someone waiting, so it uses a fast model.
const RECALL_MODEL = process.env.ALLY_RECALL_MODEL || 'claude-haiku-5-5';
const RECALL_LIMIT_MS = 15_000; // the agent gives up on the tool at 20s
const MAX_NOTES_CHARS = 400_000;

const NOTE_INSTRUCTIONS = `You keep a diary of calls for Ally, a voice companion who talks with one person like a close friend. You receive the transcript of one call. Write the diary entry for it, so that months from now Ally can find what was said.

- Plain prose, 60 to 200 words depending on how much was said. A very short call gets a sentence or two.
- Keep the specifics a friend would want back later: names of people, places, films, games and shows; plans and dates; opinions and what they felt; what Ally said about herself; jokes that landed.
- Refer to the person as "they" unless the transcript gives their name; then use the name.
- The transcript is speech recognition and has errors. Leave out anything garbled, and never guess.
- Don't describe how Ally's memory or software works, or that something was being tested.
- Output only the entry, with no heading, date or preamble.`;

const RECALL_INSTRUCTIONS = `You are the long-term memory of Ally, a voice companion who is in the middle of a spoken call with a friend. You receive her diary entries for every earlier call, oldest first, and something she is trying to remember.

- Answer in one to three short plain sentences with what was actually said and roughly when ("last Tuesday", "back in November"). Lead with the answer.
- Use only the diary. Never guess or fill gaps.
- If the diary has nothing on it, reply exactly: Nothing about that in earlier calls.
- No lists, markdown, quotes of this prompt, or mention of a diary or notes.`;

async function readArchive() {
  try {
    return JSON.parse(await readFile(archiveFile, 'utf8'));
  } catch {
    return [];
  }
}

async function eleven(path) {
  const res = await fetch(API + path, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return res.json();
}

async function writeNote(conversation) {
  const lines = conversation.transcript
    .filter((t) => t.message)
    .map((t) => `${t.role === 'user' ? 'Them' : 'Ally'}: ${t.message}`);
  // Nothing was said by the person, so there is nothing to keep.
  if (!conversation.transcript.some((t) => t.role === 'user' && t.message)) return null;

  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: NOTE_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: NOTE_INSTRUCTIONS,
    messages: [{ role: 'user', content: `<call>\n${lines.join('\n')}\n</call>` }],
  });
  if (response.stop_reason !== 'end_turn') {
    throw new Error(`diary entry stopped early (${response.stop_reason})`);
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('diary entry came back empty');
  return text;
}

async function run() {
  const agentId = await readAgentId();
  if (!agentId || !process.env.ELEVENLABS_API_KEY || !process.env.ANTHROPIC_API_KEY) return;

  const archive = await readArchive();
  const have = new Set(archive.map((e) => e.id));
  const { conversations } = await eleven(`?agent_id=${agentId}&page_size=100`);
  const missing = conversations
    .filter((c) => c.status === 'done' && !have.has(c.conversation_id))
    .reverse(); // oldest first

  for (const c of missing) {
    const conversation = await eleven(`/${c.conversation_id}`);
    const { start_time_unix_secs: start, call_duration_secs: secs } = conversation.metadata;
    archive.push({
      id: c.conversation_id,
      start,
      when: when(start),
      minutes: Math.max(1, Math.round(secs / 60)),
      note: await writeNote(conversation), // null for a call where they said nothing
    });
    archive.sort((a, b) => a.start - b.start);
    await mkdir(dataDir, { recursive: true });
    await writeFile(archiveFile, JSON.stringify(archive, null, 2));
    console.log(`Archived call ${c.conversation_id}`);
  }
}

let job = Promise.resolve();

// Writes a diary entry for every finished call that doesn't have one yet,
// including calls from before the archive existed. Never throws.
export function archiveMissing() {
  job = job.then(run).catch((err) => {
    if (err instanceof Anthropic.APIError) {
      console.error(`Archive: Anthropic API error ${err.status}: ${err.message}`);
    } else {
      console.error(`Archive: ${err.message}`);
    }
  });
  return job;
}

// Ally's recall tool: what do the earlier calls say about this?
export async function recall(question) {
  if (!process.env.ANTHROPIC_API_KEY) return "Thinking back isn't set up yet.";

  const entries = (await readArchive()).filter((e) => e.note);
  if (!entries.length) return 'Nothing about that in earlier calls.';
  let notes = entries
    .map((e) => `<call date="${e.when}" minutes="${e.minutes}">\n${e.note}\n</call>`)
    .join('\n');
  // Far beyond a few hundred calls, keep the most recent ones.
  if (notes.length > MAX_NOTES_CHARS) notes = notes.slice(-MAX_NOTES_CHARS);

  try {
    const client = new Anthropic({ timeout: RECALL_LIMIT_MS, maxRetries: 0 });
    const response = await client.messages.create({
      model: RECALL_MODEL,
      max_tokens: 1000,
      system: `${RECALL_INSTRUCTIONS}\n\nToday is ${when(Date.now() / 1000)}.`,
      messages: [
        {
          role: 'user',
          content: `<diary>\n${notes}\n</diary>\n\nAlly is trying to remember: ${question}`,
        },
      ],
    });
    const answer = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return answer || 'Nothing about that in earlier calls.';
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return "It's not coming back to me right now.";
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`Recall: Anthropic API error ${err.status}: ${err.message}`);
      return "It's not coming back to me right now.";
    }
    throw err;
  }
}
