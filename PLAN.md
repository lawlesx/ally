# Ally — plan

A real-time voice companion that feels like talking to a person: warm, playful, spontaneous. You speak, she speaks back, with no push-to-talk and no visible turns.

Status: plan only, nothing built yet. Items marked **(verify)** come from third-party write-ups and need checking against official docs before we rely on them.

## 1. What makes speech feel human (research → design rules)

| Finding | What Ally must do |
|---|---|
| Humans leave a gap of roughly 200 ms between turns, and plan their reply while still listening. | Start generating before the user finishes (speculative generation). Target under ~800 ms voice-to-voice; over ~1.2 s it feels like a machine. |
| A fixed silence timeout is a poor signal that someone is done. People pause mid-thought. | Use a semantic end-of-turn model, not just "500 ms of silence". Wait longer after "so, um…" than after a finished question. |
| 16–19% of conversational contributions are backchannels ("mm-hm", "yeah", "right"). | Ally's own "mm-hm" must not grab the floor, and the user's "yeah" while she talks must not cut her off. |
| Opening fillers ("oh!", "hmm,", "okay so") let a speaker take the turn fast and still sound natural. | Have Ally open with a short reaction. It also hides latency: the first audio is a 1–2 word chunk. |
| Real speech has disfluencies, self-repairs, uneven sentence length, laughter, breath. | Write the persona prompt for the ear: short clauses, contractions, occasional "I mean—", trailing off, laughter where something is actually funny. Never lists or markdown. |
| People interrupt, and the interrupted speaker stops within a few hundred ms and remembers what they got to say. | Barge-in: stop audio immediately, truncate the conversation history to what was actually spoken. |
| Sesame's "voice presence" is mostly prosody that fits the context: tone tracks the mood of the conversation. | Use an expressive TTS model that takes emotion cues, and let the LLM emit them (`[laughs]`, `[sighs]`, `[softly]`). |

The biggest lever is the writing, not the voice. A perfect voice reading assistant-style prose still sounds like a bot.

## 2. Architecture decision

Two real options:

**A. ElevenLabs Agents (managed)** — one platform does speech-to-text, turn-taking, barge-in, and TTS; Claude plugs in as the LLM. It ships v3 Conversational with an Expressive Mode and speculative turn-taking **(verify latency, cited ~280 ms)**. We write the persona, pick the voice, and build a thin client.

**B. Pipecat pipeline (self-assembled)** — Python orchestrator: Silero VAD + Smart Turn v3 → streaming STT → Claude (streaming) → ElevenLabs TTS over WebSocket. Full control of every timing decision and of backchannel behaviour, but more parts to tune and likely a third key for STT.

**Recommendation: start with A, keep B as the upgrade path.** A gets us to a working conversation in a day and puts the effort where it matters first (persona and voice). The persona prompt, voice ID, and client UI all carry over to B if we hit A's ceiling, which will most likely be backchannels and fine timing control.

## 3. Client: web app, not CLI

A CLI looks simpler but is the wrong prototype. Without echo cancellation Ally hears herself through the speakers and interrupts herself, so barge-in only works with headphones. The browser gives us echo cancellation, noise suppression, and WebRTC for free.

- One local page: a single orb that reacts to who is speaking, a start/stop button, nothing else.
- Works on the phone browser as-is; can be wrapped as a desktop or Android app later without rewriting.
- A tiny local server holds the API keys and hands the page a short-lived session token. Keys never reach the browser.

## 4. Persona

Ally is a character, not an assistant. The prompt defines:

- **Who she is**: tastes, things she loves and gets carried away about, opinions she will defend, a sense of humour. Specifics, not adjectives.
- **How she talks**: 1–3 short sentences most turns; reacts before she answers; asks back; teases; admits when she doesn't know; never says "How can I help?".
- **Spoken-output rules**: no markdown, no lists, numbers written as spoken, emotion tags used sparingly (laughing at everything is worse than never laughing).
- **Rhythm**: sometimes a one-word reply, sometimes a small ramble. Variation is the point.

Model: the fastest Claude offered in the platform for the conversation loop; move up a tier only if the personality feels thin. Latency matters more than depth here.

## 5. Voice

- Shortlist 3–4 ElevenLabs voices that are conversational rather than narrator-style (warm, slightly breathy, natural laugh).
- A/B them on the same 10 scripted lines covering excited, teasing, thoughtful, and gentle.
- Tune stability low enough for expressive range but not so low it gets erratic; lock the settings in config.

## 6. Phases

1. **Talking prototype** — agent configured with Claude + chosen voice + first persona draft; local web page; continuous conversation with barge-in working.
2. **Make her feel real** — iterate persona against recorded sessions; tune turn-taking eagerness; add opening fillers and emotion tags; measure voice-to-voice latency.
3. **Memory** — a short profile of the user and summaries of past conversations fed into each session, so she remembers.
4. **Decide on B** — only if phase 2 shows limits we can't tune around (backchannels, overlap handling). Port to Pipecat.
5. **Packaging** — installable desktop/phone app, wake-on-open.

## 7. What you need to provide

- Anthropic API key and ElevenLabs API key (as environment variables in a local `.env`, not pasted into chat).
- An ElevenLabs plan that includes Agents and the v3 Conversational model **(verify which tier)**.

## 8. Risks

- **Expressiveness vs. speed**: the most expressive voice model is slower than the Flash model (~75 ms inference). If v3 Conversational feels laggy we fall back to Flash and lean harder on the writing.
- **Backchannels** are the hardest part and may not be achievable on the managed platform. That is the main reason B exists.
- **Cost**: managed agents bill per minute; long daily conversations add up. Check pricing before phase 2.

## Sources

- [ElevenLabs: interaction models for natural human–AI communication](https://elevenlabs.io/blog/interaction-models-for-natural-human-ai-communication)
- [ElevenLabs Agents: conversation flow docs](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md)
- [ElevenLabs: latency concepts](https://elevenlabs.io/docs/eleven-api/concepts/latency)
- [ElevenLabs: Eleven v3](https://elevenlabs.io/blog/eleven-v3)
- [Eleven v3 API guide (third party, source of the ~280 ms figure)](https://aireiter.com/blog/elevenlabs-eleven-v3-api-guide)
- [Deepgram: backchannels vs interruptions in voice agents](https://deepgram.com/blog/backchannels-vs-interruptions-voice-agents)
- [Knudsen et al. 2020, turn-taking gaps and backchannels](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2020.593671/full)
- [Lala et al. 2019, fillers and turn-taking timing](https://www.isca-archive.org/interspeech_2019/lala19_interspeech.html)
- [Turn-taking as a latency budget](https://tianpan.co/blog/2026-04-27-voice-agent-turn-taking-latency-budget)
- [Sesame: crossing the uncanny valley of conversational voice (coverage)](https://ispr.info/?p=35688)
- [LiveKit vs Pipecat field guide](https://livekit.io/field-guides/guide/livekit-vs-pipecat)
- [Pipecat vs LiveKit Agents comparison](https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents)
