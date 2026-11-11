# Ally

A real-time voice companion that feels like talking to a person. Tap the orb, speak, and Ally speaks back: no push-to-talk, no turns. She has her own tastes, remembers you between calls, greets you differently each time, and can look things up while you talk.

## How it works

```
 browser page  ──(audio, WebRTC)──▶  ElevenLabs Agents  ──▶  Claude (the conversation)
      │                                 hearing, turn-taking,
      │                                 interruptions, voice
      ▼
 local server (Bun)
   ├─ hands the page a short-lived session token (API keys never reach the browser)
   ├─ memory:    after each call, Claude folds the transcript into memory.md
   ├─ greetings: Claude writes her next opening lines from that memory
   └─ look-ups:  Claude searches the web when Ally uses her look_up tool
```

- **Voice loop:** [ElevenLabs Agents](https://elevenlabs.io/docs/eleven-agents) does speech recognition, end-of-turn detection, barge-in and expressive speech (Eleven v4 Turbo). The conversation model is Claude Haiku, chosen for speed.
- **Personality:** everything about who Ally is lives in [persona.md](persona.md).
- **Memory:** a plain markdown file, `memory.md`, that you can read and edit. It is handed to Ally at the start of every call.

## Setup

You need [Bun](https://bun.sh), an [ElevenLabs](https://elevenlabs.io) API key and an [Anthropic](https://console.anthropic.com) API key.

```bash
bun install
```

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Needed | What it is for |
|---|---|---|
| `ELEVENLABS_API_KEY` | yes | The voice agent and call transcripts |
| `ANTHROPIC_API_KEY` | for memory, greetings, look-ups | Without it Ally still talks, but remembers nothing and can't search |
| `ALLY_PASSCODE` | to use her off this computer | The page asks for it once per device |

Create Ally on your ElevenLabs account (run this again after any change to `persona.md` or `scripts/setup-agent.mjs`):

```bash
bun run setup
```

Start her:

```bash
bun run start
```

Open http://localhost:5173, tap the orb, allow the microphone, and talk. Tap again to hang up.

## Commands

| Command | What it does |
|---|---|
| `bun run start` | Builds the page and starts the server |
| `bun run setup` | Creates or updates the agent and her look-up tool on ElevenLabs |
| `bun run voices` | Lists the voices on your ElevenLabs account |

## Changing Ally

| To change | Edit | Then |
|---|---|---|
| Who she is, how she talks, her tastes | [persona.md](persona.md) | `bun run setup` |
| Voice, voice stability, turn-taking, which Claude model she talks with | [scripts/setup-agent.mjs](scripts/setup-agent.mjs), or `ALLY_VOICE_ID` / `ALLY_LLM` / `ALLY_TTS_MODEL` in `.env` | `bun run setup` |
| What she remembers | `memory.md` (just edit it) | nothing |
| How memories and greetings are written | the instructions at the top of [memory.mjs](memory.mjs) | restart |
| How look-ups are answered | [lookup.mjs](lookup.mjs) | restart |
| The page | [public/index.html](public/index.html), [src/main.js](src/main.js) | restart |

## Files

| Path | Purpose |
|---|---|
| `server.mjs` | Serves the page; session tokens, the passcode lock, and the memory and look-up endpoints |
| `memory.mjs` | Long-term memory and greetings |
| `lookup.mjs` | Web look-ups |
| `scripts/setup-agent.mjs` | Ally's configuration on ElevenLabs |
| `persona.md` | Her system prompt |
| `src/main.js`, `public/` | The page: the orb, the call, phone install files |
| `memory.md` | What she remembers about you (not in git) |
| `.ally/` | Local state: agent and tool IDs, which calls are remembered, queued greetings (not in git) |
| `PLAN.md` | The original design notes and research |

## Memory

- When a call ends, the page tells the server. The server waits for ElevenLabs to finish the transcript, then Claude rewrites `memory.md`.
- A new call waits (up to 45 seconds) until the previous call has been remembered, so she never starts with stale notes. Normally this is instant.
- If you close the tab mid-call, the call is picked up the next time you start one.
- The file is capped at roughly 500 words. Edit or delete anything in it; she is told to respect your edits.

## Using her from your phone

The page installs to a phone's home screen and keeps the screen awake during a call, but a phone can only reach it over HTTPS, so the server has to be hosted or tunnelled.

When hosted (for example on Railway), set these in the host's settings instead of `.env`:

| Variable | Value |
|---|---|
| `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, `ALLY_PASSCODE` | as above |
| `ALLY_AGENT_ID` | the `agent_id` from `.ally/agent.json` |
| `ALLY_DATA_DIR` | the mount path of a persistent volume, e.g. `/data` |
| `TZ` | your time zone, e.g. `Asia/Kolkata` |

The server refuses to start on a public host without `ALLY_PASSCODE`. To unlock a new device in one step, open the address with the passcode after a `#`: `https://your-address/#your-passcode`.

A hosted copy keeps its own `memory.md`. On first start it rebuilds her memory from your past call transcripts.

## Privacy and cost

- `.env`, `memory.md` and `.ally/` are ignored by git. Call audio and transcripts are stored by ElevenLabs.
- ElevenLabs bills per minute of conversation. Anthropic is billed for one request per call (memory), one per greeting set, and one per look-up.
