// Lets Ally look something up mid-call. The page calls this when Ally uses her
// look_up tool; Claude searches the web and returns a few plain sentences for
// her to retell in her own voice.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ALLY_LOOKUP_MODEL || 'claude-opus-5-5';
const TIME_LIMIT_MS = 25_000; // the agent gives up on the tool at 30s

const INSTRUCTIONS = `You look things up for Ally, a voice companion who is in the middle of a spoken conversation with a friend. She will retell what you find in her own words, out loud, so someone is waiting on the line.

- Search the web, then answer in two to four short, plain sentences with the specific facts: names, dates, numbers, what happened. Lead with the answer.
- Prefer the most recent reliable information, and say how recent it is when that matters ("as of this week").
- One or two searches is usually enough. Be quick.
- No links, source names, lists, markdown or caveats about being an AI.
- If you can't find it or the sources disagree, say so in one sentence.`;

export async function lookUp(question) {
  if (!process.env.ANTHROPIC_API_KEY) return "Looking things up isn't set up yet.";

  const client = new Anthropic({ timeout: TIME_LIMIT_MS, maxRetries: 0 });
  const deadline = Date.now() + TIME_LIMIT_MS;
  const messages = [{ role: 'user', content: question }];

  try {
    while (Date.now() < deadline) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: `${INSTRUCTIONS}\n\nToday is ${new Date().toDateString()}.`,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        messages,
      });

      // A long search can pause; send the turn back so the server continues it.
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      if (response.stop_reason === 'refusal') return "That's not something I can look up.";

      // The answer is the text after the last search result.
      const answer = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return answer || "I couldn't find anything on that.";
    }
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      // fall through to the slow-search message
    } else if (err instanceof Anthropic.AuthenticationError) {
      console.error('Look-up: the ANTHROPIC_API_KEY in .env was rejected.');
      return "Looking things up isn't working right now.";
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error('Look-up: Anthropic rate limit hit.');
      return "Looking things up isn't working right now.";
    } else if (err instanceof Anthropic.APIError) {
      console.error(`Look-up: Anthropic API error ${err.status}: ${err.message}`);
      return "Looking things up isn't working right now.";
    } else {
      throw err;
    }
  }
  return 'The search took too long and came back with nothing.';
}
