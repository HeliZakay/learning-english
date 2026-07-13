// Talk worker — the small server between the app and the AI services.
// Routes: /ping (health, open), /chat (Claude conversation), /speak (OpenAI
// TTS). /chat and /speak require the X-Talk-Token header and count against a
// daily cap. Mock mode: with no API keys configured, /chat returns
// deterministic in-character replies so the app is fully testable locally.

import { CHARACTER, buildSystemPrompt, mockReply } from "./persona.js";

const ANTHROPIC_MODEL = "claude-sonnet-5";
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "nova";
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
    return null;
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
                system: buildSystemPrompt(),
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

        if ((url.pathname === "/chat" || url.pathname === "/speak") && request.method === "POST") {
            if (request.headers.get("X-Talk-Token") !== env.TALK_APP_TOKEN) {
                return fail("forbidden", "Missing or invalid app token", 403, cors);
            }
            if (overDailyLimit(env)) {
                return fail("daily_limit", "Daily conversation limit reached", 429, cors);
            }
            return url.pathname === "/chat"
                ? handleChat(request, env, cors)
                : handleSpeak(request, env, cors);
        }

        return fail("not_found", "Not found", 404, cors);
    },
};
