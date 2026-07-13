// Talk — conversation with a character. Entry point for the conversation
// feature (see talk-feature-plan.md). Loaded after the main inline script in
// index.html, so it can use the app's global functions and state.

// Filled in once the Cloudflare Worker is deployed (Stage 2). Until then the
// Talk screen shows "not connected". For local testing, override with:
//   localStorage.setItem("talk_worker_url", "http://localhost:8787")
var TALK_WORKER_URL = "";

function talkWorkerUrl() {
    return localStorage.getItem("talk_worker_url") || TALK_WORKER_URL;
}

function setTalkStatus(text, className) {
    var el = document.getElementById("talkStatus");
    el.textContent = text;
    el.className = "talk-status" + (className ? " " + className : "");
}

function startTalk() {
    var base = talkWorkerUrl();
    if (!base) {
        setTalkStatus("Server: not connected yet", "");
        return;
    }

    setTalkStatus("Checking connection...", "");
    fetch(base.replace(/\/$/, "") + "/ping")
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data && data.ok) {
                setTalkStatus("Server: connected ✓", "connected");
            } else {
                setTalkStatus("Server: unexpected reply", "error");
            }
        })
        .catch(function () {
            setTalkStatus("Server: could not connect", "error");
        });
}
