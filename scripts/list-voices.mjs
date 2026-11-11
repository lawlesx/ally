// Lists the voices available on your ElevenLabs account, to pick ALLY_VOICE_ID.
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('ELEVENLABS_API_KEY is missing. Copy .env.example to .env and add it.');
  process.exit(1);
}

const res = await fetch('https://api.elevenlabs.io/v1/voices', {
  headers: { 'xi-api-key': key },
});
if (!res.ok) {
  console.error(`ElevenLabs rejected the request (${res.status}):\n${await res.text()}`);
  process.exit(1);
}

const { voices } = await res.json();
for (const v of voices) {
  const l = v.labels || {};
  const traits = [l.gender, l.age, l.accent, l.descriptive || l.description, l.use_case]
    .filter(Boolean)
    .join(', ');
  console.log(`${v.voice_id}  ${v.name.padEnd(28)} ${traits}`);
}
