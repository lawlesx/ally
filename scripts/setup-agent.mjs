// Creates Ally's agent on ElevenLabs, or updates it if one already exists.
// Run again after editing persona.md or the settings below: bun run setup
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const stateFile = join(root, '.ally', 'agent.json');
const API = 'https://api.elevenlabs.io/v1/convai/agents';

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('ELEVENLABS_API_KEY is missing. Copy .env.example to .env and add it.');
  process.exit(1);
}

const persona = await readFile(join(root, 'persona.md'), 'utf8');

let state = {};
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
} catch {}

// Ally's tools run in the page (src/main.js), which asks the server to do the work.
// Creates the tool, or updates it if .ally/agent.json already has its id.
async function upsertTool(stateKey, tool_config) {
  const id = state[stateKey];
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/tools${id ? `/${id}` : ''}`, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ tool_config }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`ElevenLabs rejected the ${tool_config.name} tool (${res.status}):\n${text}`);
    process.exit(1);
  }
  state[stateKey] ??= JSON.parse(text).id;
  await mkdir(join(root, '.ally'), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

// look_up: searches the web (lookup.mjs).
await upsertTool('tool_id', {
  type: 'client',
  name: 'look_up',
  description:
    'Look something up on the web. Use it for anything recent or factual you are not sure of: ' +
    'a film or game release, a new season or update, a score, the news, who made or starred in something. ' +
    'Returns a few sentences of facts for you to retell in your own words.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'The full question to search for, with names and context spelled out, e.g. ' +
          '"What is new in the current season of Battlefield 6 RedSec?"',
      },
    },
    required: ['question'],
  },
  expects_response: true,
  response_timeout_secs: 30,
  // Always say something first ("hang on, let me check") so there is no dead air.
  pre_tool_speech: 'force',
  // A soft typing sound for the whole wait, after she's said she's checking.
  tool_call_sound: 'typing',
  tool_call_sound_behavior: 'always',
});

// recall: searches her notes on every earlier call (archive.mjs).
await upsertTool('recall_tool_id', {
  type: 'client',
  name: 'recall',
  description:
    'Think back over every earlier call with this person. Use it when they bring up something from before ' +
    'that is not in your notes, or ask whether you remember something. ' +
    'Returns what was said about it and when, or that nothing was found.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'What you are trying to remember, spelled out, e.g. ' +
          '"What did they say about their trip to Goa?"',
      },
    },
    required: ['question'],
  },
  expects_response: true,
  response_timeout_secs: 20,
  pre_tool_speech: 'force',
});

// Words the speech recognition should expect, so names aren't garbled.
// Add your own (names, places, shows), one per line, in keywords.txt.
const KEYWORDS = ['Ally', 'Wong Kar-wai', 'Tumbbad', 'Masaan', 'Wasseypur', 'Outer Wilds'];
try {
  for (const line of (await readFile(join(root, 'keywords.txt'), 'utf8')).split('\n')) {
    const word = line.trim();
    if (word && !word.startsWith('#')) KEYWORDS.push(word);
  }
} catch {}
// The recogniser takes at most 50 terms of 20 characters each.
const keywords = [...new Set(KEYWORDS)].filter((w) => w.length <= 20).slice(0, 50);

const body = {
  name: 'Ally',
  conversation_config: {
    agent: {
      // Written fresh for each call by the server (see memory.mjs).
      first_message: '{{greeting}}',
      language: 'en',
      // In Hindi she mixes in English, the way people actually talk.
      hinglish_mode: true,
      // persona.md uses {{memory}} and {{now}}; the page supplies the real values per call.
      dynamic_variables: {
        dynamic_variable_placeholders: {
          greeting: 'Hey, you.',
          memory: '(Nothing yet. This is the first time you two have talked.)',
          now: 'an ordinary evening',
        },
      },
      prompt: {
        prompt: persona,
        tool_ids: [state.tool_id, state.recall_tool_id],
        built_in_tools: {
          // Switches hearing and speech between English and Hindi as the person does.
          language_detection: {
            type: 'system',
            name: 'language_detection',
            description: '',
            params: { system_tool_type: 'language_detection' },
          },
          // Lets her hang up after a goodbye.
          end_call: {
            type: 'system',
            name: 'end_call',
            description: '',
            params: { system_tool_type: 'end_call' },
          },
          // Lets her stay quiet and wait instead of filling every silence.
          skip_turn: {
            type: 'system',
            name: 'skip_turn',
            description: '',
            params: { system_tool_type: 'skip_turn' },
          },
        },
        // Fast model: latency matters more than depth in a spoken loop.
        llm: process.env.ALLY_LLM || 'claude-haiku-5-5',
      },
    },
    // The languages she can switch to (English is the default above).
    language_presets: { hi: { overrides: {} } },
    asr: { keywords },
    tts: {
      // Expressive mode (emotion tags) is on automatically with this model.
      model_id: process.env.ALLY_TTS_MODEL || 'eleven_v4_turbo',
      // Default: "Jessica", a warm, playful conversational voice. See: bun run voices
      voice_id: process.env.ALLY_VOICE_ID || 'cgSgspJ2msm6clMCkdW9',
      expressive_mode: true,
      // Lower = wider emotional range but more random mood swings; higher = steadier.
      stability: 0.6,
      similarity_boost: 0.8,
      speed: 1.0,
    },
    turn: {
      turn_model: 'turn_v3',
      turn_eagerness: 'normal',
      // Start drafting the reply while the user is still finishing.
      speculative_turn: true,
      // Seconds of silence before Ally speaks up on her own (see "When they go
      // quiet" in persona.md for what she does then).
      turn_timeout: 12,
      // If the reply is slow, fill the gap instead of going silent.
      soft_timeout_config: {
        timeout_seconds: 2.0,
        message: 'Hmm...',
        use_llm_generated_message: false,
      },
    },
    conversation: {
      max_duration_seconds: 3600,
      client_events: [
        'audio',
        'interruption',
        'user_transcript',
        'agent_response',
        'agent_response_correction',
      ],
    },
  },
};

let agentId = state.agent_id;

const res = await fetch(agentId ? `${API}/${agentId}` : `${API}/create`, {
  method: agentId ? 'PATCH' : 'POST',
  headers: { 'xi-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
if (!res.ok) {
  console.error(`ElevenLabs rejected the request (${res.status}):\n${text}`);
  process.exit(1);
}

if (!agentId) {
  agentId = JSON.parse(text).agent_id;
  await writeFile(stateFile, JSON.stringify({ ...state, agent_id: agentId }, null, 2));
  console.log(`Created Ally: ${agentId}`);
} else {
  console.log(`Updated Ally: ${agentId}`);
}
