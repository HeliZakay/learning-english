// Talk — conversation with a character. Entry point for the conversation
// feature (see talk-feature-plan.md). Loaded after the main inline script in
// index.html, so it can use the app's global functions and state. All
// identifiers are talk-prefixed to avoid colliding with the inline script's
// globals.

// Filled in once the Cloudflare Worker is deployed (Stage 2). Until then the
// Talk screen shows "not connected". For local testing, override with:
//   localStorage.setItem("talk_worker_url", "http://localhost:8787")
var TALK_WORKER_URL = "";

// Sent as the X-Talk-Token header on /chat and /speak. Must match
// TALK_APP_TOKEN in worker/wrangler.jsonc. Not a secret — it ships in this
// public file — just a tripwire against strangers using the worker.
var TALK_APP_TOKEN = "talk-GAcDReX5Mh5WXlfT";

var talkState = {
    character: null,   // {name, greeting} from /ping
    history: [],       // [{role, content}] API-shaped turns; greeting NOT included
    sending: false,
    started: false     // chat screen entered this session
};

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
    }
    document.getElementById("talkInput").focus();
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
    talkRequestReply();
}

function talkRequestReply() {
    talkState.sending = true;
    document.getElementById("talkSendBtn").disabled = true;
    talkShowTyping();

    // Stage 6 placeholder: a local fake reply. Stage 7 replaces this with a
    // real /chat request.
    setTimeout(function () {
        var reply = "You said: \"" + talkState.history[talkState.history.length - 1].content + "\". (I will really talk soon!)";
        talkState.history.push({ role: "assistant", content: reply });
        talkHideTyping();
        talkAppendBubble("character", reply);
        talkState.sending = false;
        document.getElementById("talkSendBtn").disabled = false;
    }, 600);
}

// === Wiring ===

document.getElementById("talkStartBtn").addEventListener("click", talkShowChat);
document.getElementById("talkSendBtn").addEventListener("click", talkSend);
document.getElementById("talkInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") talkSend();
});
