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
    started: false,    // chat screen entered this session
    voiceState: "idle", // idle | thinking | speaking | listening
    micDenied: false   // mic permission refused — stop auto-listening
};

// Pure-voice conversation ("like a phone call") is the default whenever the
// device can listen; muting the speaker falls back to the classic text chat.
function talkVoiceMode() {
    return talkMicSupported() && !talkMuted() && !talkState.micDenied;
}

// Single place that routes the whole UI by voice state and mode.
function talkSetVoiceState(next) {
    talkState.voiceState = next;
    var vm = talkVoiceMode();
    var pill = document.getElementById("talkVoiceStatus");
    var mic = document.getElementById("talkMicBtn");
    var name = talkState.character ? talkState.character.name : "She";
    var speakingView = document.getElementById("talkSpeakingView");
    var listenView = document.getElementById("talkListenView");
    var listenHint = document.getElementById("talkListenHint");

    document.getElementById("talkChat").classList.toggle("talk-voice-mode", vm);
    mic.disabled = (next === "thinking");
    mic.classList.toggle("talk-mic-speaking", next === "speaking");

    // Which big view fills the area: her portrait, the big mic, or the chat.
    var showPortrait = next === "speaking" || (vm && next === "thinking");
    var showBigMic = vm && (next === "listening" || next === "idle");
    speakingView.style.display = showPortrait ? "flex" : "none";
    speakingView.classList.toggle("thinking", next === "thinking");
    listenView.style.display = showBigMic ? "flex" : "none";
    listenView.classList.toggle("listening", next === "listening");
    document.getElementById("talkMessages").style.display =
        (showPortrait || showBigMic) ? "none" : "";
    if (!showPortrait && !showBigMic) talkScrollDown();
    if (showBigMic) {
        listenHint.textContent = next === "listening"
            ? "Speak freely — tap when you finish"
            : "Tap to talk";
    }

    if (next === "speaking") {
        pill.textContent = "🔊 " + name + " is speaking...";
        pill.className = "talk-voice-status";
        pill.style.display = "";
    } else if (next === "listening") {
        pill.textContent = "🎤 Speak freely — tap ✓ when you finish";
        pill.className = "talk-voice-status listening";
        pill.style.display = vm ? "none" : "";
    } else if (next === "thinking") {
        pill.textContent = "💭 Thinking...";
        pill.className = "talk-voice-status";
        pill.style.display = "";
    } else {
        pill.style.display = "none";
    }
}

// === Voice output (Samantha speaks) ===

// Samantha's TTS voice — "sage" (with the worker's bold-charm age
// instructions) chosen in the voice-tasting sessions (2026-07-14).
var TALK_DEFAULT_VOICE = "sage";

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
    if (muted) {
        talkSpeakStop();
        talkListenStop();
        if (talkState.voiceState !== "thinking") talkState.voiceState = "idle";
    }
    // Re-route the whole view: mute = classic text chat, unmute = voice call.
    talkSetVoiceState(talkState.voiceState);
}

// One reused Audio element for all clips: after it is primed by a user
// gesture, later .play() calls stay allowed. A fresh Audio per clip can hit
// NotAllowedError on Android.
var talkAudioEl = new Audio();

// 0.05s of silence, used only to prime talkAudioEl inside the Start click.
var TALK_SILENT_WAV = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

var talkAudioState = {
    unlocked: false,
    generation: 0,     // bumped by talkSpeakStop(); stale callbacks compare & bail
    queue: [],         // [{text, controller, promise (resolves to objectURL)}]
    index: 0,          // next queue slot to play
    fetched: 0,        // how many queue items have started fetching
    playedAny: false   // did any clip actually reach the speaker this reply?
};

// Split a reply into speakable sentences, merging fragments under 25 chars
// into a neighbor so "Oh!" doesn't become its own choppy clip.
function talkSplitSentences(text) {
    var raw = text.match(/[^.!?…]+[.!?…]+["'”’]?\s*|[^.!?…]+\s*$/g) || [text];
    var merged = [];
    for (var i = 0; i < raw.length; i++) {
        var seg = raw[i].trim();
        if (!seg) continue;
        if (merged.length > 0 && (seg.length < 25 || merged[merged.length - 1].length < 25)) {
            merged[merged.length - 1] += " " + seg;
        } else {
            merged.push(seg);
        }
    }
    return merged;
}

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
function talkFetchSpeech(text, controller) {
    return fetch(talkWorkerUrl().replace(/\/$/, "") + "/speak", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Talk-Token": TALK_APP_TOKEN
        },
        body: JSON.stringify({ text: text.slice(0, 1000), voice: talkVoice() }),
        signal: controller ? controller.signal : undefined
    }).then(function (res) {
        var type = res.headers.get("Content-Type") || "";
        if (!res.ok || type.indexOf("audio/") !== 0) throw new Error("speech unavailable");
        return res.blob();
    }).then(function (blob) {
        return URL.createObjectURL(blob);
    });
}

// Speak a character reply aloud, sentence by sentence: clip 2 downloads
// while clip 1 plays, so Samantha starts talking quickly. The text bubble is
// already on screen; any failure is silent. Calls
// talkOnCharacterDone(playedAny) when the last clip ends (or on failure).
function talkSpeak(reply) {
    talkSpeakStop();
    if (talkMuted() || !talkAudioState.unlocked) {
        talkOnCharacterDone(false);
        return;
    }
    var gen = talkAudioState.generation;
    document.getElementById("talkSpeakingText").textContent = reply;
    talkAudioState.queue = talkSplitSentences(reply).map(function (text) {
        return { text: text, controller: null, promise: null };
    });
    talkAudioState.index = 0;
    talkAudioState.fetched = 0;
    talkAudioState.playedAny = false;

    talkPrefetch(gen);
    talkPlayNext(gen);
}

// Keep at most 2 clip downloads in flight, always for the earliest
// not-yet-fetched sentences.
function talkPrefetch(gen) {
    var s = talkAudioState;
    if (gen !== s.generation) return;
    while (s.fetched < s.queue.length && s.fetched - s.index < 2) {
        (function (item) {
            item.controller = new AbortController();
            item.promise = talkFetchSpeech(item.text, item.controller);
            item.promise.then(function () { talkPrefetch(gen); }, function () {});
        })(s.queue[s.fetched]);
        s.fetched++;
    }
}

function talkPlayNext(gen) {
    var s = talkAudioState;
    if (gen !== s.generation) return;
    if (s.index >= s.queue.length) {
        talkOnCharacterDone(s.playedAny);
        return;
    }
    var item = s.queue[s.index];
    item.promise.then(function (url) {
        if (gen !== s.generation) {
            URL.revokeObjectURL(url);
            return;
        }
        talkAudioEl.onended = function () {
            talkAudioEl.onended = null;   // run once — guards double-ended quirks
            URL.revokeObjectURL(url);
            if (gen !== s.generation) return;
            s.index++;
            talkPrefetch(gen);
            talkPlayNext(gen);
        };
        talkAudioEl.src = url;
        s.playedAny = true;
        talkSetVoiceState("speaking");
        talkAudioEl.play().catch(function () {
            URL.revokeObjectURL(url);
            if (gen === s.generation) talkOnCharacterDone(s.playedAny);
        });
    }, function () {
        // One sentence failed: stop the voice attempt for this reply quietly.
        if (gen === s.generation) talkOnCharacterDone(s.playedAny);
    });
}

// Stop all voice output now. Synchronous; invalidates every pending callback
// and aborts in-flight clip downloads.
function talkSpeakStop() {
    talkAudioState.generation++;
    talkAudioState.queue.forEach(function (item) {
        if (item.controller) item.controller.abort();
        // Revoke clips that finished downloading but never played.
        if (item.promise) {
            item.promise.then(function (url) { URL.revokeObjectURL(url); }, function () {});
        }
    });
    talkAudioState.queue = [];
    talkAudioState.index = 0;
    talkAudioState.fetched = 0;
    talkAudioEl.onended = null;
    talkAudioEl.pause();
    talkAudioEl.removeAttribute("src");
}

// Called once when Samantha finishes (or fails) speaking a reply.
// playedAny = whether any audio actually reached the speaker. If she truly
// spoke, the mic opens automatically — that's the conversation loop. If the
// turn was silent (muted / TTS failed), auto-listening would feel random.
function talkOnCharacterDone(playedAny) {
    // Leave "speaking" first — talkListenStart refuses while speaking.
    talkSetVoiceState("idle");
    var chatVisible = document.getElementById("talkChat").style.display !== "none";
    if (playedAny && !talkMuted() && talkMicSupported() && !talkState.micDenied &&
        chatVisible && !document.hidden) {
        talkListenStart();
    }
}

// === Voice input (mom speaks) ===

function talkMicSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function talkCreateRecognition() {
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    return Ctor ? new Ctor() : null;
}

var talkRec = null;              // active recognition instance, null when idle

// One "turn" of listening spans several short recognition rounds: Android
// Chrome ends recognition at every silence no matter what, so when a round
// dies we quietly start another and keep collecting. Only the ✓ tap (done),
// a fatal error, or ~3 empty rounds of silence truly ends the turn.
var talkListenState = {
    collected: "",       // finalized text from completed rounds
    sessionFinal: "",    // finalized text within the current round
    sessionInterim: "",  // LAST interim of the current round (Android sends
                         // cumulative interims — concatenating them garbles)
    errorCode: null,
    done: false,         // she tapped ✓
    emptyRounds: 0
};

function talkListening() {
    return talkRec !== null;
}

function talkListenStart() {
    if (talkListening() || talkState.sending || talkState.micDenied) return;
    // Never open the mic while Samantha's audio plays — it would hear her.
    // The only legal path from speaking to listening is talkInterrupt().
    if (talkState.voiceState === "speaking") return;
    talkListenState = {
        collected: "", sessionFinal: "", sessionInterim: "",
        errorCode: null, done: false, emptyRounds: 0
    };
    talkListenRound();
}

// Start one recognition round (also used to seamlessly continue after
// Android's silence cut-offs).
function talkListenRound() {
    var rec = talkCreateRecognition();
    if (!rec) return;
    talkRec = rec;
    talkListenState.sessionFinal = "";
    talkListenState.sessionInterim = "";
    talkListenState.errorCode = null;

    rec.continuous = false;   // Android ends on silence anyway; we restart
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;

    rec.onstart = function () {
        if (talkRec !== rec) return;
        var mic = document.getElementById("talkMicBtn");
        mic.classList.add("talk-mic-listening");
        mic.textContent = "✓";   // while listening, the mic button means "I'm done"
        talkSetVoiceState("listening");
        if (!document.getElementById("talkPendingBubble")) talkShowPendingBubble();
    };
    rec.onresult = function (event) {
        if (talkRec !== rec) return;
        var finals = "", lastInterim = "";
        for (var i = 0; i < event.results.length; i++) {
            var t = event.results[i][0].transcript;
            if (event.results[i].isFinal) finals += " " + t;
            else lastInterim = t;   // keep only the last (cumulative on Android)
        }
        talkListenState.sessionFinal = finals;
        talkListenState.sessionInterim = lastInterim;
        talkUpdatePendingBubble(talkListenText() || "...");
    };
    rec.onerror = function (event) {
        if (talkRec !== rec) return;
        talkListenState.errorCode = event.error;
    };
    rec.onend = function () {
        if (talkRec !== rec) return;  // stale round or cancelled
        talkOnRecognitionEnd();
    };
    rec.start();
}

// Everything she has said this turn, cleaned up.
function talkListenText() {
    return (talkListenState.collected + " " + talkListenState.sessionFinal +
        " " + talkListenState.sessionInterim).replace(/\s+/g, " ").trim();
}

// Cancel listening without sending anything.
function talkListenStop() {
    if (!talkRec) return;
    var rec = talkRec;
    talkRec = null;               // onend sees a stale rec → pure cleanup
    rec.onend = null;
    rec.onresult = null;
    rec.onerror = null;
    try { rec.abort(); } catch (e) {}
    var mic = document.getElementById("talkMicBtn");
    mic.classList.remove("talk-mic-listening");
    mic.textContent = "🎤";
    talkRemovePendingBubble();
    talkSetVoiceState("idle");
}

// She tapped ✓: finalize whatever was said and let onend send it.
function talkListenDone() {
    if (!talkRec) return;
    talkListenState.done = true;
    try { talkRec.stop(); } catch (e) {}
}

// A round ended (silence, ✓ tap via stop(), or an error).
function talkOnRecognitionEnd() {
    var s = talkListenState;
    var sessionText = (s.sessionFinal + " " + s.sessionInterim).replace(/\s+/g, " ").trim();
    var fatal = s.errorCode === "not-allowed" || s.errorCode === "service-not-allowed" ||
        s.errorCode === "audio-capture" || s.errorCode === "network";

    // Keep listening: she hasn't tapped ✓ and nothing fatal happened.
    if (!s.done && !fatal) {
        if (sessionText) {
            s.collected = (s.collected + " " + sessionText).replace(/\s+/g, " ").trim();
            s.emptyRounds = 0;
        } else {
            s.emptyRounds++;
        }
        // She said something already, or is still within the silence grace
        // window — quietly start the next round.
        if (s.collected || s.emptyRounds < 3) {
            talkListenRound();
            return;
        }
        // ~3 silent rounds and not a word: she's probably not there.
    }

    // Finish the turn.
    talkRec = null;
    var mic = document.getElementById("talkMicBtn");
    mic.classList.remove("talk-mic-listening");
    mic.textContent = "🎤";
    talkRemovePendingBubble();

    var text = (s.collected + " " + sessionText).replace(/\s+/g, " ").trim();
    if (text) {
        talkSendText(text);
        return;
    }
    talkSetVoiceState("idle");
    talkOnListenFailed(s.errorCode);
}

// No usable speech — explain kindly and leave mom in control.
function talkOnListenFailed(errorCode) {
    if (errorCode === "aborted" || !errorCode) return;  // cancelled on purpose / clean silence
    if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
        talkState.micDenied = true;
        document.getElementById("talkMicBtn").classList.add("talk-mic-denied");
        talkSetVoiceState("idle");   // re-route: falls back to the text chat
        talkShowHint("Samantha can't hear you — the microphone is blocked. " +
            "Tap the 🔒 next to the address to allow it. You can always type instead!");
        return;
    }
    if (errorCode === "no-speech") {
        talkShowHint("I didn't hear you — tap the microphone 🎤 and try again.");
        return;
    }
    if (errorCode === "network") {
        talkShowHint("No connection for listening. Check the internet and try again.");
        return;
    }
    if (errorCode === "audio-capture") {
        talkShowHint("No microphone was found on this device. You can type instead!");
        return;
    }
    talkShowHint("Something went wrong with listening — tap the microphone 🎤 to try again.");
}

// A gentle hint. In voice mode it appears under the big mic; in text mode
// it's a soft in-chat bubble (only one at a time — a new one replaces it).
function talkShowHint(text) {
    if (talkVoiceMode()) {
        document.getElementById("talkListenHint").textContent = text;
        return;
    }
    var old = document.querySelector(".talk-bubble-hint");
    if (old) old.parentNode.removeChild(old);
    talkAppendBubble("hint", text);
}

// Live transcript shown as a pending user bubble (not the input — keeps the
// Android keyboard out of the voice flow).
function talkShowPendingBubble() {
    talkRemovePendingBubble();
    var el = document.createElement("div");
    el.className = "talk-bubble talk-bubble-user talk-bubble-interim";
    el.id = "talkPendingBubble";
    el.textContent = "...";
    document.getElementById("talkMessages").appendChild(el);
    talkScrollDown();
}

function talkUpdatePendingBubble(text) {
    var el = document.getElementById("talkPendingBubble");
    if (el) {
        el.textContent = text;
        talkScrollDown();
    }
}

function talkRemovePendingBubble() {
    var el = document.getElementById("talkPendingBubble");
    if (el) el.parentNode.removeChild(el);
}

// Mic tap: interrupt Samantha if she's talking, cancel if already
// listening, otherwise start listening.
function talkMicTap() {
    if (talkState.micDenied) {
        talkShowHint("The microphone is still blocked. Tap the 🔒 next to the " +
            "address, allow the microphone, and reload the page.");
        return;
    }
    if (talkState.voiceState === "speaking") {
        talkInterrupt();
        return;
    }
    if (talkListening()) {
        talkListenDone();   // ✓ tap: finish the turn and send what she said
        return;
    }
    talkListenStart();
}

// Politely cut Samantha off: stop her audio NOW, then open the mic. Both
// steps are synchronous up to rec.start(), so no stale clip can slip in.
function talkInterrupt() {
    talkSpeakStop();
    talkSetVoiceState("idle");
    talkListenStart();
}

// Stop ALL voice activity (audio out + mic). Called when leaving Talk mode
// (switchMode in index.html) and when the tab is hidden.
function talkVoiceStop() {
    talkSpeakStop();
    talkListenStop();
    talkSetVoiceState("idle");
}

document.addEventListener("visibilitychange", function () {
    if (document.hidden) talkVoiceStop();
});

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
        document.getElementById("talkSpeakingName").textContent = name;
        talkAppendBubble("character", greeting);
        talkRenderStarters();
        talkSetVoiceState("idle");
        // In voice mode she greets out loud, then the mic opens by itself.
        if (talkVoiceMode()) talkSpeak(greeting);
    } else {
        talkSetVoiceState(talkState.voiceState);
    }
    // Focusing the input pops the Android keyboard — skip it in voice mode.
    if (!talkVoiceMode()) {
        document.getElementById("talkInput").focus();
    }
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
    if (talkListening()) talkListenStop();  // typing wins over the mic
    input.value = "";
    talkSendText(text);
}

// Shared send tail for both the typed path and the voice transcript path.
function talkSendText(text) {
    if (talkState.sending) return;
    talkState.history.push({ role: "user", content: text });
    talkAppendBubble("user", text);
    talkHideStarters();
    talkSetVoiceState("thinking");
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
            talkSetVoiceState("idle");
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
document.getElementById("talkMicBtn").addEventListener("click", talkMicTap);
document.getElementById("talkSpeakingView").addEventListener("click", function () {
    if (talkState.voiceState === "speaking") talkInterrupt();
});
document.getElementById("talkListenView").addEventListener("click", talkMicTap);
if (!talkMicSupported()) {
    document.getElementById("talkMicBtn").style.display = "none";
}
document.getElementById("talkSendBtn").addEventListener("click", talkSend);
document.getElementById("talkInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") talkSend();
});
