// Talk — conversation with a character. Entry point for the conversation
// feature (see talk-feature-plan.md). Loaded after the main inline script in
// index.html, so it can use the app's global functions and state. All
// identifiers are talk-prefixed to avoid colliding with the inline script's
// globals.

// The deployed Cloudflare Worker (worker/). For local testing against
// `wrangler dev`, override with:
//   localStorage.setItem("talk_worker_url", "http://localhost:8787")
var TALK_WORKER_URL = "https://talk-worker.helizakay1.workers.dev";

// Sent as the X-Talk-Token header on /chat and /speak. Must match
// TALK_APP_TOKEN in worker/wrangler.jsonc. Not a secret — it ships in this
// public file — just a tripwire against strangers using the worker.
var TALK_APP_TOKEN = "talk-GAcDReX5Mh5WXlfT";

// Tappable conversation openers, shown while the conversation is empty.
// Tapping one sends its message as a normal visible user message — which
// also models a correct English phrase.
var TALK_STARTERS = [
    { label: "👨‍👩‍👧 My family", message: "Let's talk about my family." },
    { label: "🍲 Food", message: "Let's talk about food!" },
    { label: "☀️ My day", message: "Let me tell you about my day." },
    { label: "🌤 The weather", message: "Let's talk about the weather." },
    { label: "📸 Old memories", message: "Let's talk about old memories." }
];

var talkState = {
    character: null,   // {name, greeting} from /ping
    history: [],       // [{role, content}] API-shaped turns; greeting NOT included
    sending: false,
    started: false     // chat screen entered this session
};

// === Voice output (Samantha speaks) ===

// Samantha's TTS voice; the default is set after the voice-tasting session.
var TALK_DEFAULT_VOICE = "nova";

function talkVoice() {
    return localStorage.getItem("talk_voice") || TALK_DEFAULT_VOICE;
}

function talkMuted() {
    return localStorage.getItem("talk_muted") === "1";
}

function talkToggleMute() {
    var muted = !talkMuted();
    localStorage.setItem("talk_muted", muted ? "1" : "0");
    document.getElementById("talkMuteBtn").textContent = muted ? "🔇" : "🔊";
    if (muted) talkSpeakStop();
}

// One reused Audio element for all clips: after it is primed by a user
// gesture, later .play() calls stay allowed. A fresh Audio per clip can hit
// NotAllowedError on Android.
var talkAudioEl = new Audio();

// 0.05s of silence, used only to prime talkAudioEl inside the Start click.
var TALK_SILENT_WAV = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

var talkAudioState = {
    unlocked: false,
    generation: 0      // bumped by talkSpeakStop(); stale callbacks compare & bail
};

function talkAudioUnlock() {
    if (talkAudioState.unlocked) return;
    talkAudioState.unlocked = true;
    talkAudioEl.src = TALK_SILENT_WAV;
    var p = talkAudioEl.play();
    if (p && p.then) {
        p.then(function () { talkAudioEl.pause(); }).catch(function () {});
    }
}

// POST /speak and resolve with an object URL for the MP3 (rejects on any
// failure — callers degrade to text-only, never an error bubble).
function talkFetchSpeech(text) {
    return fetch(talkWorkerUrl().replace(/\/$/, "") + "/speak", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Talk-Token": TALK_APP_TOKEN
        },
        body: JSON.stringify({ text: text.slice(0, 1000), voice: talkVoice() })
    }).then(function (res) {
        var type = res.headers.get("Content-Type") || "";
        if (!res.ok || type.indexOf("audio/") !== 0) throw new Error("speech unavailable");
        return res.blob();
    }).then(function (blob) {
        return URL.createObjectURL(blob);
    });
}

// Speak a character reply aloud. The text bubble is already on screen; any
// failure here is silent. Calls talkOnCharacterDone(playedAny) at the end.
function talkSpeak(reply) {
    talkSpeakStop();
    if (talkMuted() || !talkAudioState.unlocked) {
        talkOnCharacterDone(false);
        return;
    }
    var gen = talkAudioState.generation;

    talkFetchSpeech(reply)
        .then(function (url) {
            if (gen !== talkAudioState.generation) {
                URL.revokeObjectURL(url);
                return;
            }
            talkAudioEl.onended = function () {
                URL.revokeObjectURL(url);
                if (gen !== talkAudioState.generation) return;
                talkOnCharacterDone(true);
            };
            talkAudioEl.src = url;
            talkAudioEl.play().catch(function () {
                URL.revokeObjectURL(url);
                if (gen === talkAudioState.generation) talkOnCharacterDone(false);
            });
        })
        .catch(function () {
            if (gen === talkAudioState.generation) talkOnCharacterDone(false);
        });
}

// Stop all voice output now. Synchronous; invalidates every pending callback.
function talkSpeakStop() {
    talkAudioState.generation++;
    talkAudioEl.onended = null;
    talkAudioEl.pause();
    talkAudioEl.removeAttribute("src");
}

// Called once when Samantha finishes (or fails) speaking a reply.
// playedAny = whether any audio actually reached the speaker.
// Stage 16 hooks auto-listen here.
function talkOnCharacterDone(playedAny) {
}

function talkWorkerUrl() {
    return localStorage.getItem("talk_worker_url") || TALK_WORKER_URL;
}

function setTalkStatus(text, className) {
    var el = document.getElementById("talkStatus");
    el.textContent = text;
    el.className = "talk-status" + (className ? " " + className : "");
}

// === Mode entry ===

function startTalk() {
    if (talkState.started) {
        talkShowChat();
        return;
    }
    talkShowIntro();

    var base = talkWorkerUrl();
    var startBtn = document.getElementById("talkStartBtn");
    if (!base) {
        setTalkStatus("Server: not connected yet", "");
        startBtn.style.display = "none";
        return;
    }

    setTalkStatus("Checking connection...", "");
    startBtn.style.display = "none";
    fetch(base.replace(/\/$/, "") + "/ping")
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data && data.ok) {
                talkState.character = data.character || null;
                if (data.character) {
                    document.getElementById("talkIntroName").textContent = data.character.name;
                    document.getElementById("talkIntroSubtitle").textContent =
                        data.character.name + " is here and would love to talk with you!";
                }
                setTalkStatus("Server: connected ✓", "connected");
                startBtn.style.display = "";
            } else {
                setTalkStatus("Server: unexpected reply", "error");
            }
        })
        .catch(function () {
            setTalkStatus("Server: could not connect", "error");
        });
}

// Shared POST helper for worker endpoints. Resolves with the parsed body on
// success; rejects with {code} on any failure so callers can map messages.
function talkFetch(path, body) {
    return fetch(talkWorkerUrl().replace(/\/$/, "") + path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Talk-Token": TALK_APP_TOKEN
        },
        body: JSON.stringify(body)
    }).then(function (res) {
        return res.json().then(function (data) {
            if (data && data.ok) return data;
            throw { code: (data && data.error && data.error.code) || "upstream_error" };
        });
    }, function () {
        throw { code: "network" };
    });
}

// === Sub-view toggling (same pattern as story mode) ===

function talkShowIntro() {
    document.getElementById("talkIntro").style.display = "";
    document.getElementById("talkChat").style.display = "none";
}

function talkShowChat() {
    document.getElementById("talkIntro").style.display = "none";
    document.getElementById("talkChat").style.display = "flex";
    if (!talkState.started) {
        talkState.started = true;
        var name = talkState.character ? talkState.character.name : "Friend";
        var greeting = talkState.character ? talkState.character.greeting :
            "Hello! It's so nice to meet you! How are you today?";
        document.getElementById("talkCharName").textContent = name;
        talkAppendBubble("character", greeting);
        talkRenderStarters();
    }
    document.getElementById("talkInput").focus();
}

// === Topic starter chips ===

function talkRenderStarters() {
    var box = document.getElementById("talkStarters");
    box.innerHTML = "";
    TALK_STARTERS.forEach(function (starter) {
        var chip = document.createElement("button");
        chip.className = "talk-starter-chip";
        chip.textContent = starter.label;
        chip.addEventListener("click", function () {
            var input = document.getElementById("talkInput");
            input.value = starter.message;
            talkSend();
        });
        box.appendChild(chip);
    });
}

function talkHideStarters() {
    document.getElementById("talkStarters").innerHTML = "";
}

// === Messages ===

function talkAppendBubble(kind, text) {
    var el = document.createElement("div");
    el.className = "talk-bubble talk-bubble-" + kind;
    el.textContent = text;
    document.getElementById("talkMessages").appendChild(el);
    talkScrollDown();
    return el;
}

function talkScrollDown() {
    var box = document.getElementById("talkMessages");
    box.scrollTop = box.scrollHeight;
}

function talkShowTyping() {
    talkHideTyping();
    var el = document.createElement("div");
    el.className = "talk-bubble talk-bubble-character talk-typing";
    el.id = "talkTyping";
    el.innerHTML = '<span class="talk-typing-dot"></span><span class="talk-typing-dot"></span><span class="talk-typing-dot"></span>';
    document.getElementById("talkMessages").appendChild(el);
    talkScrollDown();
}

function talkHideTyping() {
    var el = document.getElementById("talkTyping");
    if (el) el.parentNode.removeChild(el);
}

// === Send flow ===

function talkSend() {
    var input = document.getElementById("talkInput");
    var text = input.value.trim();
    if (!text || talkState.sending) return;
    input.value = "";

    talkState.history.push({ role: "user", content: text });
    talkAppendBubble("user", text);
    talkHideStarters();
    talkRequestReply();
}

function talkRequestReply() {
    talkState.sending = true;
    document.getElementById("talkSendBtn").disabled = true;
    talkShowTyping();

    // Mirror of the worker's history cap, to keep payloads small.
    var history = talkState.history.slice(-30);

    talkFetch("/chat", { messages: history })
        .then(function (data) {
            talkState.history.push({ role: "assistant", content: data.reply });
            talkAppendBubble("character", data.reply);
            talkSpeak(data.reply);
        })
        .catch(function (err) {
            talkShowError(err && err.code);
        })
        .then(function () {
            talkHideTyping();
            talkState.sending = false;
            document.getElementById("talkSendBtn").disabled = false;
        });
}

// === Error handling ===

function talkErrorInfo(code) {
    if (code === "daily_limit") {
        return { text: "She's had a lot of conversations today and is resting. 🌙 Come back tomorrow!", retry: false };
    }
    if (code === "network") {
        return { text: "No connection. Check the internet and try again.", retry: true };
    }
    return { text: "She didn't catch that — something went wrong on her side.", retry: true };
}

function talkShowError(code) {
    var info = talkErrorInfo(code);
    var bubble = talkAppendBubble("error", info.text);
    if (info.retry) {
        var btn = document.createElement("button");
        btn.className = "talk-retry-btn";
        btn.textContent = "Try again";
        btn.addEventListener("click", function () {
            bubble.parentNode.removeChild(bubble);
            // History already holds the user's turn — no duplicate bubble.
            talkRequestReply();
        });
        bubble.appendChild(btn);
        talkScrollDown();
    }
}

// === Hebrew help ===

// "How do I say...?" — prefills the input with Hebrew so mom completes the
// phrase and sends normally; Samantha answers with the English and carries on.
function talkHelp() {
    var input = document.getElementById("talkInput");
    input.value = "איך אומרים ";
    input.focus();
    // Put the caret at the end so she can type right after the prefix.
    input.setSelectionRange(input.value.length, input.value.length);
}

// === Wiring ===

document.getElementById("talkHelpBtn").addEventListener("click", talkHelp);
document.getElementById("talkStartBtn").addEventListener("click", function () {
    talkAudioUnlock();  // user gesture — primes audio for later playback
    talkShowChat();
});
document.getElementById("talkMuteBtn").addEventListener("click", talkToggleMute);
document.getElementById("talkMuteBtn").textContent = talkMuted() ? "🔇" : "🔊";
document.getElementById("talkSendBtn").addEventListener("click", talkSend);
document.getElementById("talkInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") talkSend();
});
