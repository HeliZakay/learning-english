// Talk worker — the small server between the app and the AI services.
// Routes: /ping (health), /chat (Claude conversation), /speak (OpenAI TTS,
// stage 4). Stage 5 adds origin checks, an app token, and daily rate limits.
// Mock mode: with no API keys configured, /chat returns deterministic
// in-character replies so the app is fully testable locally.

import { buildSystemPrompt, mockReply } from "./persona.js";

const ANTHROPIC_MODEL = "claude-sonnet-5";
const MAX_HISTORY = 30;
const UPSTREAM_TIMEOUT_MS = 30000;

// Open CORS until Stage 5 hardening — the worker holds no secrets yet.
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

function fail(code, message, status) {
    return json({ ok: false, error: { code, message } }, status);
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
function upstreamFail(status) {
    if (status === 429) return fail("rate_limited", "The AI service is busy right now", 429);
    if (status === 529) return fail("overloaded", "The AI service is overloaded", 503);
    if (status === 401 || status === 403) return fail("not_configured", "API key is invalid", 500);
    return fail("upstream_error", "The AI service returned an error (" + status + ")", 502);
}

async function handleChat(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return fail("bad_request", "Body must be JSON", 400);
    }
    const problem = validateChatBody(body);
    if (problem) return fail("bad_request", problem, 400);

    const messages = body.messages.slice(-MAX_HISTORY);

    if (!env.ANTHROPIC_API_KEY) {
        return json({ ok: true, reply: mockReply(messages), mock: true });
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
            return fail("timeout", "The AI service took too long", 504);
        }
        return fail("upstream_error", "Could not reach the AI service", 502);
    }

    if (!res.ok) return upstreamFail(res.status);

    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock || !textBlock.text) {
        return fail("upstream_error", "The AI service returned an empty reply", 502);
    }
    return json({ ok: true, reply: textBlock.text, mock: false, usage: data.usage });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (url.pathname === "/ping") {
            return json({ ok: true, message: "Hello from the Talk worker!" });
        }

        if (url.pathname === "/chat" && request.method === "POST") {
            return handleChat(request, env);
        }

        return fail("not_found", "Not found", 404);
    },
};
