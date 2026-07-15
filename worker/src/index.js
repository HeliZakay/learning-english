// Talk worker — the small server between the app and the AI services.
// Routes: /ping (health, open), /chat (Claude conversation), /speak (OpenAI
// TTS). /chat and /speak require the X-Talk-Token header and count against a
// daily cap. Mock mode: with no API keys configured, /chat returns
// deterministic in-character replies so the app is fully testable locally.

import { CHARACTER, buildSystemPrompt, buildMemorizePrompt, buildGreetPrompt, MOCK_GREETING, mockProfile, mockReply } from "./persona.js";

const ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_MEMORY_MODEL = "claude-haiku-4-5";  // cheap background distillation
const MAX_PROFILE_CHARS = 4000;
const PROFILE_TRUNCATE_CHARS = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEFAULT_VOICE = "sage";
// Voice direction chosen in the tasting sessions (2026-07-14): mature age
// anchor + "bold charm" character.
const DEFAULT_SPEAK_INSTRUCTIONS =
    "A woman in her late sixties with natural vocal maturity and gentle age " +
    "texture — clearly not young. Bold and confident with theatrical charm: " +
    "self-assured, charismatic and fun, a knowing chuckle just under the " +
    "surface, spirited pace with playful emphasis — an elegant woman who " +
    "lights up a room.";
const MAX_HISTORY = 30;
const MAX_SPEAK_CHARS = 1000;
const UPSTREAM_TIMEOUT_MS = 30000;

// Origins allowed to call this worker: the GitHub Pages site and local dev.
const ALLOWED_ORIGIN = "https://helizakay.github.io";
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeadersFor(request) {
    const origin = request.headers.get("Origin");
    const headers = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Talk-Token",
        "Access-Control-Max-Age": "86400",
    };
    if (origin === ALLOWED_ORIGIN || LOCAL_ORIGIN_RE.test(origin || "")) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin";
    }
    return headers;
}

function json(data, status, cors) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...cors },
    });
}

function fail(code, message, status, cors) {
    return json({ ok: false, error: { code, message } }, status, cors);
}

// Daily request cap. In-memory per-isolate: resets when the isolate recycles
// and is not shared across isolates, so it is a tripwire against runaway use
// behind the token/CORS gates — not exact accounting (that's stage 28).
let usage = { day: "", count: 0 };

function overDailyLimit(env) {
    const today = new Date().toISOString().slice(0, 10);
    if (usage.day !== today) usage = { day: today, count: 0 };
    usage.count += 1;
    return usage.count > Number(env.TALK_DAILY_LIMIT || 300);
}

function validateChatBody(body) {
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        return "messages must be a non-empty array";
    }
    if (body.messages.length > 40) return "too many messages";
    for (const m of body.messages) {
        if (!m || (m.role !== "user" && m.role !== "assistant")) {
            return "each message needs role user|assistant";
        }
        if (typeof m.content !== "string" || m.content.length === 0 || m.content.length > 2000) {
            return "each message needs string content of 1-2000 chars";
        }
    }
    if (body.messages[0].role !== "user") return "first message must be from the user";
    if (body.profile !== undefined && (typeof body.profile !== "string" || body.profile.length > MAX_PROFILE_CHARS)) {
        return "profile must be a string of up to " + MAX_PROFILE_CHARS + " chars";
    }
    if (body.clientDate !== undefined && (typeof body.clientDate !== "string" || !DATE_RE.test(body.clientDate))) {
        return "clientDate must be YYYY-MM-DD";
    }
    if (body.greeting !== undefined && (typeof body.greeting !== "string" || body.greeting.length > 300)) {
        return "greeting must be a string of up to 300 chars";
    }
    return null;
}

// The prompt-tail options shared by /chat: profile, date, and the greeting
// actually spoken this session.
function promptOpts(body) {
    return {
        profile: body.profile || null,
        dateStr: (body.clientDate && DATE_RE.test(body.clientDate))
            ? body.clientDate
            : new Date().toISOString().slice(0, 10),
        greeting: body.greeting || null,
    };
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Map an upstream AI-provider response to our client-facing error envelope.
function upstreamFail(status, cors) {
    if (status === 429) return fail("rate_limited", "The AI service is busy right now", 429, cors);
    if (status === 529) return fail("overloaded", "The AI service is overloaded", 503, cors);
    if (status === 401 || status === 403) return fail("not_configured", "API key is invalid", 500, cors);
    return fail("upstream_error", "The AI service returned an error (" + status + ")", 502, cors);
}

async function handleChat(request, env, cors) {
    let body;
    try {
        body = await request.json();
    } catch {
        return fail("bad_request", "Body must be JSON", 400, cors);
    }
    const problem = validateChatBody(body);
    if (problem) return fail("bad_request", problem, 400, cors);

    const messages = body.messages.slice(-MAX_HISTORY);

    if (!env.ANTHROPIC_API_KEY) {
        return json({ ok: true, reply: mockReply(messages), mock: true }, 200, cors);
    }

    let res;
    try {
        res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: 300,
                thinking: { type: "disabled" },
                system: buildSystemPrompt(promptOpts(body)),
                messages,
            }),
        });
    } catch (err) {
        if (err && err.name === "AbortError") {
            return fail("timeout", "The AI service took too long", 504, cors);
        }
        return fail("upstream_error", "Could not reach the AI service", 502, cors);
    }

    if (!res.ok) return upstreamFail(res.status, cors);

    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock || !textBlock.text) {
        return fail("upstream_error", "The AI service returned an empty reply", 502, cors);
    }
    return json({ ok: true, reply: textBlock.text, mock: false, usage: data.usage }, 200, cors);
}

async function handleSpeak(request, env, cors) {
    let body;
    try {
        body = await request.json();
    } catch {
        return fail("bad_request", "Body must be JSON", 400, cors);
    }
    if (typeof body.text !== "string" || body.text.length === 0 || body.text.length > MAX_SPEAK_CHARS) {
        return fail("bad_request", "text must be a string of 1-" + MAX_SPEAK_CHARS + " chars", 400, cors);
    }

    if (!env.OPENAI_API_KEY) {
        return fail("tts_not_configured", "OPENAI_API_KEY is not set", 503, cors);
    }

    let res;
    try {
        res = await fetchWithTimeout("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + env.OPENAI_API_KEY,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: OPENAI_TTS_MODEL,
                voice: typeof body.voice === "string" && body.voice ? body.voice : DEFAULT_VOICE,
                input: body.text,
                response_format: "mp3",
                instructions: typeof body.instructions === "string" && body.instructions.length <= 500
                    ? body.instructions
                    : DEFAULT_SPEAK_INSTRUCTIONS,
            }),
        });
    } catch (err) {
        if (err && err.name === "AbortError") {
            return fail("timeout", "The speech service took too long", 504, cors);
        }
        return fail("upstream_error", "Could not reach the speech service", 502, cors);
    }

    if (!res.ok) return upstreamFail(res.status, cors);

    return new Response(res.body, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg", ...cors },
    });
}

// Distill recent conversation turns into an updated memory profile. The
// assistant turn is prefilled with "ABOUT HER:" so the whole completion IS
// the profile — no JSON parsing to go wrong.
async function handleMemorize(request, env, cors) {
    let body;
    try {
        body = await request.json();
    } catch {
        return fail("bad_request", "Body must be JSON", 400, cors);
    }
    if (!Array.isArray(body.transcript) || body.transcript.length === 0 || body.transcript.length > 60) {
        return fail("bad_request", "transcript must be an array of 1-60 turns", 400, cors);
    }
    for (const t of body.transcript) {
        if (!t || (t.role !== "user" && t.role !== "assistant") ||
            typeof t.content !== "string" || t.content.length === 0 || t.content.length > 2000) {
            return fail("bad_request", "each turn needs role user|assistant and content of 1-2000 chars", 400, cors);
        }
    }
    if (body.profile !== undefined && body.profile !== null &&
        (typeof body.profile !== "string" || body.profile.length > MAX_PROFILE_CHARS)) {
        return fail("bad_request", "profile must be a string of up to " + MAX_PROFILE_CHARS + " chars", 400, cors);
    }

    if (!env.ANTHROPIC_API_KEY) {
        return json({ ok: true, profile: mockProfile(body.transcript), mock: true }, 200, cors);
    }

    const conversation = body.transcript
        .map((t) => (t.role === "user" ? "Her: " : "Samantha: ") + t.content)
        .join("\n");
    const userMsg = "CURRENT PROFILE:\n" + (body.profile || "(empty — first conversation)") +
        "\n\nNEW CONVERSATION:\n" + conversation;

    let res;
    try {
        res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: ANTHROPIC_MEMORY_MODEL,
                max_tokens: 700,
                thinking: { type: "disabled" },
                system: buildMemorizePrompt(body.clientDate),
                messages: [
                    { role: "user", content: userMsg },
                    { role: "assistant", content: "ABOUT HER:" },
                ],
            }),
        });
    } catch (err) {
        if (err && err.name === "AbortError") {
            return fail("timeout", "The memory service took too long", 504, cors);
        }
        return fail("upstream_error", "Could not reach the memory service", 502, cors);
    }

    if (!res.ok) return upstreamFail(res.status, cors);

    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock || !textBlock.text) {
        return fail("upstream_error", "The memory service returned an empty profile", 502, cors);
    }
    const profile = ("ABOUT HER:" + textBlock.text).slice(0, PROFILE_TRUNCATE_CHARS);
    return json({ ok: true, profile, mock: false }, 200, cors);
}

// A fresh, memory-aware opening line for a new conversation.
async function handleGreet(request, env, cors) {
    let body;
    try {
        body = await request.json();
    } catch {
        return fail("bad_request", "Body must be JSON", 400, cors);
    }
    if (typeof body.profile !== "string" || body.profile.length === 0 || body.profile.length > MAX_PROFILE_CHARS) {
        return fail("bad_request", "profile must be a non-empty string of up to " + MAX_PROFILE_CHARS + " chars", 400, cors);
    }
    if (body.clientDate !== undefined && (typeof body.clientDate !== "string" || !DATE_RE.test(body.clientDate))) {
        return fail("bad_request", "clientDate must be YYYY-MM-DD", 400, cors);
    }
    if (body.lastTalked !== undefined && (typeof body.lastTalked !== "string" || !DATE_RE.test(body.lastTalked))) {
        return fail("bad_request", "lastTalked must be YYYY-MM-DD", 400, cors);
    }

    if (!env.ANTHROPIC_API_KEY) {
        return json({ ok: true, greeting: MOCK_GREETING, mock: true }, 200, cors);
    }

    let res;
    try {
        res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: 100,
                thinking: { type: "disabled" },
                system: buildGreetPrompt(body.profile, body.clientDate, body.lastTalked),
                messages: [{ role: "user", content: "She just opened the app. Greet her." }],
            }),
        });
    } catch (err) {
        if (err && err.name === "AbortError") {
            return fail("timeout", "The greeting took too long", 504, cors);
        }
        return fail("upstream_error", "Could not create the greeting", 502, cors);
    }

    if (!res.ok) return upstreamFail(res.status, cors);

    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock || !textBlock.text) {
        return fail("upstream_error", "Empty greeting", 502, cors);
    }
    return json({ ok: true, greeting: textBlock.text.trim(), mock: false }, 200, cors);
}

// Speech-to-text: the app records mom's turn as one audio blob (no Android
// recognizer beeps/gaps) and sends it here for transcription.

// She only ever speaks Hebrew or English. Telling the model that up front
// stops most of the Hebrew-heard-as-Arabic / English-heard-as-CJK misfires.
const STT_PROMPT = "The speaker is an Israeli woman who speaks only English or Hebrew, never any other language. She may switch between English and Hebrew mid-sentence.";
const ARABIC_SCRIPT_RE = /[؀-ۿݐ-ݿ]/;
const CJK_SCRIPT_RE = /[぀-ヿ一-鿿가-힯]/;

async function openaiTranscribe(env, audio, ext, language) {
    const form = new FormData();
    form.append("file", audio, "speech." + ext);
    form.append("model", OPENAI_STT_MODEL);
    form.append("prompt", STT_PROMPT);
    if (language) form.append("language", language);
    const res = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY },
        body: form,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, text: typeof data.text === "string" ? data.text : "" };
}

async function handleTranscribe(request, env, cors) {
    const audio = await request.blob();
    if (!audio || audio.size === 0) return fail("bad_request", "No audio received", 400, cors);
    if (audio.size > MAX_AUDIO_BYTES) return fail("bad_request", "Audio too large", 400, cors);

    if (!env.OPENAI_API_KEY) {
        return fail("stt_not_configured", "OPENAI_API_KEY is not set", 503, cors);
    }

    const type = (request.headers.get("Content-Type") || "audio/webm").split(";")[0];
    const ext = { "audio/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav" }[type] || "webm";

    let result;
    try {
        result = await openaiTranscribe(env, audio, ext);
    } catch (err) {
        if (err && err.name === "AbortError") {
            return fail("timeout", "The transcription service took too long", 504, cors);
        }
        return fail("upstream_error", "Could not reach the transcription service", 502, cors);
    }

    if (!result.ok) return upstreamFail(result.status, cors);

    // Wrong-script guard: Arabic letters mean she spoke Hebrew, CJK letters
    // mean she spoke English. One forced-language retry; if it fails for any
    // reason, keep the first result rather than surfacing a new error to her.
    const retryLang = ARABIC_SCRIPT_RE.test(result.text) ? "he"
        : CJK_SCRIPT_RE.test(result.text) ? "en"
        : null;
    if (retryLang) {
        console.log("transcribe: wrong script detected, retrying with language=" + retryLang);
        try {
            const retry = await openaiTranscribe(env, audio, ext, retryLang);
            if (retry.ok) result = retry;
        } catch (err) { /* keep the first result */ }
    }

    return json({ ok: true, text: result.text }, 200, cors);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const cors = corsHeadersFor(request);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: cors });
        }

        if (url.pathname === "/ping") {
            return json({
                ok: true,
                mock: !env.ANTHROPIC_API_KEY,
                character: { name: CHARACTER.name, greeting: CHARACTER.greeting },
            }, 200, cors);
        }

        const guarded = {
            "/chat": handleChat,
            "/speak": handleSpeak,
            "/transcribe": handleTranscribe,
            "/memorize": handleMemorize,
            "/greet": handleGreet,
        };
        if (guarded[url.pathname] && request.method === "POST") {
            if (request.headers.get("X-Talk-Token") !== env.TALK_APP_TOKEN) {
                return fail("forbidden", "Missing or invalid app token", 403, cors);
            }
            if (overDailyLimit(env)) {
                return fail("daily_limit", "Daily conversation limit reached", 429, cors);
            }
            return guarded[url.pathname](request, env, cors);
        }

        return fail("not_found", "Not found", 404, cors);
    },
};
