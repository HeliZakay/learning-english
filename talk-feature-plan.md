# "Talk with a Friend" — Conversation Character Feature Plan

A character that has real spoken conversations with Mom: she talks, Mom answers, and so on.

## Decisions (agreed 2026-07-13)

| Area | Decision |
|---|---|
| Device | Android phone, Chrome |
| Modality | Voice + text together — character speaks aloud and shows text; Mom answers by voice, text fallback |
| AI brain | Claude Sonnet 5 via a small Cloudflare Worker proxy (API key stays secret on the server) |
| Character voice | OpenAI TTS through the same proxy |
| Speech-to-text | Chrome's built-in speech recognition (free, no server needed) |
| Turn-taking | Auto-listen after the character finishes, with a big always-available tap-to-talk button |
| Corrections | Gentle recasting — the character naturally repeats Mom's idea with correct phrasing, never criticizes |
| Persona | Warm original character (name/backstory designed together in Stage 8) |
| Topics | Free chat + tappable topic starters; vocabulary from the app woven in subtly |
| Hebrew | English conversation; a "How do I say…?" help button; character understands Hebrew slips and gently steers back |
| Memory | Real memory across sessions (name, family, past conversations) stored in her browser (localStorage) |
| Code layout | New `js/talk.js` + `css/talk.css` loaded by index.html — no build step |

Supporting choices (Claude's recommendations, can revisit):
- Proxy host: **Cloudflare Worker** (free tier is more than enough).
- Proxy protection: origin check + simple app token + per-day rate limit in the worker, so strangers can't burn API credits. No password for Mom.
- Two API accounts needed: **Anthropic** (chat) and **OpenAI** (voice). Both keys live only in the worker.
- Rough running cost at daily conversations: ~$5–15/month Claude + ~$1–3/month TTS.

## Stages

Each stage is small, ends in something testable, and gets its own commit.

### Phase A — Foundation (1–5)
- [x] **1. Scaffolding** — create `js/talk.js`, `css/talk.css`, wire into index.html, add a "Talk" entry to the menu with a placeholder screen.
- [x] **2. Worker skeleton** — set up Cloudflare account + worker, deploy a hello-world endpoint, call it from the app. *(live at https://talk-worker.helizakay1.workers.dev)*
- [x] **3. Chat endpoint** — worker `/chat` route calling Claude Sonnet 5 (key as worker secret), CORS configured.
- [x] **4. Speech endpoint** — worker `/speak` route calling OpenAI TTS, returns audio.
- [x] **5. Proxy hardening** — origin check, app token, daily rate limit, friendly "resting" response when limits hit.

### Phase B — Text conversation core (6–12)
- [x] **6. Chat UI** — message bubbles, large readable fonts, typing indicator, auto-scroll.
- [x] **7. Real conversation** — wire chat UI to `/chat` with a placeholder personality; first working text conversation.
- [x] **8. Persona design** — design the character together (name, age, backstory, interests, quirks) → system prompt v1.
- [x] **9. Recasting behavior** — teach the prompt gentle recasting + learner-appropriate language level; tune with test conversations. *(prompt written; quality tuning pending real API key)*
- [x] **10. Topic starters** — tappable suggestion chips at session start (family, food, her day, news…).
- [x] **11. Hebrew help** — "How do I say…?" button; character handles Hebrew slips gracefully.
- [x] **12. Error handling** — network failures, retries, kind in-conversation error messages.

### Phase C — Voice (13–18)
- [x] **13. Character speaks** — each character message plays via `/speak` while text shows; pick her voice together.
- [x] **14. Fast speech** — sentence-by-sentence TTS pipelining so she starts talking quickly.
- [x] **15. Mom speaks** — tap-to-talk button with live transcript shown as she talks.
- [x] **16. Auto-listen** — mic opens automatically after the character finishes; silence ends the turn; clear listening/thinking/speaking visuals.
- [x] **17. No self-hearing** — mic paused while the character speaks; allow tapping to interrupt her.
- [x] **18. Voice UX polish** — big button states, animations, "I didn't hear you" recovery. *(code verified headlessly; real-phone checklist pending)*

### Phase D — Memory (19–22)
- [ ] **19. Transcripts** — save conversation history locally.
- [ ] **20. Long-term memory** — after each session, extract facts (family, interests, events) into a profile fed to the character.
- [ ] **21. Learning memory** — track words she struggled with and vocabulary already covered in the app.
- [ ] **22. Continuity** — "welcome back" behavior; character asks about things from last time.

### Phase E — Learning features (23–25)
- [ ] **23. Vocabulary weaving** — character naturally uses words from her current app word batches.
- [ ] **24. Session summary** — friendly end-of-chat recap: what went well, 2–3 gentle tips, nice new words that came up.
- [ ] **25. Tap-to-define in chat** — reuse the glossary popover so any word in a bubble can be tapped.

### Phase F — Polish & launch (26–30)
- [ ] **26. Android pass** — layout, touch targets, keep screen awake during conversation.
- [ ] **27. Latency tuning** — streaming responses, snappier round-trips.
- [ ] **28. Cost safety** — usage counters in the worker, graceful daily limit message.
- [ ] **29. Real-device testing + onboarding** — end-to-end runs on her phone model; a simple first-time explanation screen.
- [ ] **30. Launch** — deploy, first supervised conversation with Mom, collect feedback and adjust.
