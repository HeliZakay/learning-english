// Talk worker — the small server between the app and the AI services.
// Stage 2: hello-world /ping endpoint so the app can prove the pipe works.
// Stage 3 adds /chat (Claude), Stage 4 adds /speak (OpenAI TTS),
// Stage 5 adds origin checks, an app token, and daily rate limits.

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

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (url.pathname === "/ping") {
            return json({ ok: true, message: "Hello from the Talk worker!" });
        }

        return json({ ok: false, error: "Not found" }, 404);
    },
};
