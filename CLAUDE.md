# learning-english

English-learning app Heli builds for her mom (Hebrew speaker, intermediate English, uses ONE Android phone with Chrome). Static site, no build step, deployed on GitHub Pages: https://helizakay.github.io/learning-english/ (rebuilds ~90s after push).

## The Talk feature (the main ongoing project)

A voice-call conversation with **Samantha** — a warm 67-year-old American retired florist in London who lived 15 years in Haifa (husband Amnon, alive and retired; no grandchildren yet, hopes for some), understands Hebrew, gently recasts mom's English mistakes without ever flagging them, and remembers her between conversations.

**Roadmap: `talk-feature-plan.md` is the source of truth** — 30 stages, decisions table, checkboxes. **All planned work is shipped** (stages 1–22, 26, 29, 30). Stages 23–25 (vocab weaving, recap, tap-to-define) and 27–28 (streaming, persistent cost counters) are deliberately deferred until mom feedback. What remains: mom's supervised first conversation (launch checklist given to Heli), then feedback-driven fixes/iteration.

### Architecture

- **Client**: `js/talk.js` + `css/talk.css` + markup in `index.html` (#talkContainer). Classic scripts — top-level consts share the global lexical scope with index.html's inline script (NOT on window). All Talk identifiers are `talk`-prefixed.
- **Worker**: `worker/` — Cloudflare Worker at `https://talk-worker.helizakay1.workers.dev`. Routes: `/ping` (open; returns character name+greeting), and token-guarded `/chat` (Claude claude-sonnet-5), `/speak` (OpenAI gpt-4o-mini-tts, voice "sage" + age/character instructions), `/transcribe` (gpt-4o-mini-transcribe), `/memorize` (claude-haiku-4-5 distills transcripts→profile), `/greet` (Sonnet personalized opener). Persona + all prompts live in `worker/src/persona.js`.
- **Secrets**: ANTHROPIC_API_KEY + OPENAI_API_KEY set via `wrangler secret put` (never in code/chat). `TALK_APP_TOKEN` is a public tripwire (ships in talk.js; GitGuardian alert about it was intentionally ignored). Daily cap TALK_DAILY_LIMIT=600 (in-memory per-isolate; real accounting is stage 28).
- **Deploy**: worker `cd worker && npx wrangler deploy` (Heli's Cloudflare account, already logged in). Site: `git push` → GitHub Pages.
- **Memory (phase D)**: transcripts + profile in the phone's localStorage (`talk_transcripts`, `talk_profile`; also `talk_muted`, `talk_voice`, `talk_onboarded`, dev override `talk_worker_url`). Console helpers `talkMemoryDebug()` / `talkMemoryReset()`.
- **Final phase (26/29/30)**: screen wake lock held while chat is open; one-time Hebrew RTL onboarding (`#talkOnboarding`, its button doubles as the audio-unlock gesture); installable PWA — `manifest.json` (short_name "Samantha", standalone, start_url/scope `/learning-english/`), icons `images/icon-512/192.png` + `favicon-32.png` from Samantha's portrait.

### UX model (pure voice call — mom's explicit preference: "no text at all")

Samantha's big glowing portrait while she speaks (tap = interrupt) ↔ big red mic while mom talks (recording timer; tap = finish turn; MediaRecorder, NOT SpeechRecognition) ↔ thinking portrait. Personalized greeting fetched during the intro screen. Header 🔊 mute toggle = fallback to classic text-chat with full history bubbles. `#talkStartBtn` click is the audio-unlock gesture (Chrome autoplay) — never remove it.

### Hard-won gotchas (do not re-learn these)

- **Android SpeechRecognition is banned**: it beeps on every start/stop, flickers the status-bar mic, is deaf during restarts (lost words), sends cumulative interims, and ignores continuous mode. That's why voice input = MediaRecorder → /transcribe.
- Sonnet 5 API: no temperature/top_p/top_k (400 error); always send `thinking: {type:"disabled"}` or it eats max_tokens.
- Anthropic requires messages[0].role === "user" — the greeting NEVER enters history.
- One reused Audio element (fresh `new Audio()` per clip → NotAllowedError on Android); generation-counter invalidates stale audio callbacks.
- Dates: device-local YYYY-MM-DD (never toISOString — Israel evening off-by-one).
- wrangler.jsonc compatibility_date pinned to 2026-05-03 (local runtime rejects newer).
- Vocab arrays `words1`/`words2` (index.html inline script) are reachable from talk.js via shared global scope — relevant for stage 23.

### Working conventions with Heli

- Each phase: enter plan mode first ("plan first"), AskUserQuestion rounds for product decisions (she answers decisively), then build ALL of Claude's part autonomously, one commit per stage, verify each stage headlessly before committing (rig in `.claude/skills/verify/SKILL.md` — playwright-core + system Chrome; fake mic via --use-fake-device/ui-for-media-stream; ALWAYS cd to repo root before starting http.server).
- Anything requiring Heli's accounts/phone: hand her ONE baby step per message, wait for "done". She sends screenshots as bug reports (excellent ones) and real-phone feedback that has repeatedly reshaped the design — take it seriously and fix root causes, not symptoms.
- Voice/persona choices are made by "tasting": generate variants, play via afplay through her Mac speakers, AskUserQuestion to pick.
- Commit messages: story-style, Co-Authored-By Claude line. Push only after phases are verified; the untracked podcast-*.md files stay untracked.
