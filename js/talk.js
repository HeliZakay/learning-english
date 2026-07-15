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
    voiceState: "idle", // idle | thinking | review | speaking | listening
    micDenied: false,  // mic permission refused — stop auto-listening
    pendingText: null  // transcript awaiting mom's approval (review state)
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
    var reviewView = document.getElementById("talkReviewView");
    var listenHint = document.getElementById("talkListenHint");

    document.getElementById("talkChat").classList.toggle("talk-voice-mode", vm);
    mic.disabled = (next === "thinking");
    mic.classList.toggle("talk-mic-speaking", next === "speaking");

    // Which big view fills the area: her portrait, the big mic, the review
    // card, or the chat.
    var showPortrait = next === "speaking" || (vm && next === "thinking");
    var showBigMic = vm && (next === "listening" || next === "idle");
    var showReview = vm && next === "review";
    speakingView.style.display = showPortrait ? "flex" : "none";
    speakingView.classList.toggle("thinking", next === "thinking");
    listenView.style.display = showBigMic ? "flex" : "none";
    listenView.classList.toggle("listening", next === "listening");
    reviewView.style.display = showReview ? "flex" : "none";
    document.getElementById("talkMessages").style.display =
        (showPortrait || showBigMic || showReview) ? "none" : "";
    if (!showPortrait && !showBigMic && !showReview) talkScrollDown();
    if (showBigMic) {
        listenHint.textContent = next === "listening"
            ? "Speak freely — tap when you finish"
            : "Tap to talk";
    }
    if (next !== "listening") {
        document.getElementById("talkListenTranscript").textContent = "";
    }
    if (next === "listening" || next === "idle") {
        document.getElementById("talkHeardText").textContent = "";
    }
    if (next !== "review") {
        talkState.pendingText = null;
    }
    // A new turn is starting: the previous reply's text and cached audio are
    // history — mom can no longer replay them.
    if (next === "thinking") {
        talkReplayState = { text: null, texts: [], clips: [], got: 0 };
    }
    if (showBigMic) talkUpdateListenReply();

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
    fetched: 0         // how many queue items have started fetching
};

// The last reply's audio, kept as Blobs so 🔁 replay is instant and free —
// no /speak re-fetch. Replaced wholesale on each talkSpeak; stale fetch
// callbacks close over the OLD object, so they can't pollute a newer reply.
var talkReplayState = { text: null, texts: [], clips: [], got: 0 };

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

// POST /speak and resolve with the MP3 Blob (rejects on any failure —
// callers degrade to text-only, never an error bubble).
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
    });
}

// Speak a character reply aloud, sentence by sentence: clip 2 downloads
// while clip 1 plays, so Samantha starts talking quickly. The text bubble is
// already on screen; any failure is silent. Calls
// talkOnCharacterDone() when the last clip ends (or on failure).
function talkSpeak(reply) {
    talkSpeakStop();
    // Seed the replay cache before the mute/unlock bail-out so the quiet
    // text on the mic screen still shows even when TTS is skipped.
    var texts = talkSplitSentences(reply);
    talkReplayState = { text: reply, texts: texts, clips: [], got: 0 };
    if (talkMuted() || !talkAudioState.unlocked) {
        talkOnCharacterDone();
        return;
    }
    var gen = talkAudioState.generation;
    document.getElementById("talkSpeakingText").textContent = reply;
    talkAudioState.queue = texts.map(function (text) {
        return { text: text, controller: null, promise: null };
    });
    talkAudioState.index = 0;
    talkAudioState.fetched = 0;

    talkPrefetch(gen);
    talkPlayNext(gen);
}

// Keep at most 2 clip downloads in flight, always for the earliest
// not-yet-fetched sentences.
function talkPrefetch(gen) {
    var s = talkAudioState;
    if (gen !== s.generation) return;
    while (s.fetched < s.queue.length && s.fetched - s.index < 2) {
        (function (item, idx, cache) {
            item.controller = new AbortController();
            item.promise = talkFetchSpeech(item.text, item.controller).then(function (blob) {
                // Bank the Blob for 🔁 replay (identity check: a stale fetch
                // from an interrupted reply must not pollute a newer cache),
                // then hand downstream the object URL it has always expected.
                if (cache === talkReplayState && !cache.clips[idx]) {
                    cache.clips[idx] = blob;
                    cache.got++;
                }
                return URL.createObjectURL(blob);
            });
            item.promise.then(function () { talkPrefetch(gen); }, function () {});
        })(s.queue[s.fetched], s.fetched, talkReplayState);
        s.fetched++;
    }
}

function talkPlayNext(gen) {
    var s = talkAudioState;
    if (gen !== s.generation) return;
    if (s.index >= s.queue.length) {
        talkOnCharacterDone();
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
        talkSetVoiceState("speaking");
        talkAudioEl.play().catch(function () {
            URL.revokeObjectURL(url);
            if (gen === s.generation) talkOnCharacterDone();
        });
    }, function () {
        // One sentence failed: stop the voice attempt for this reply quietly.
        if (gen === s.generation) talkOnCharacterDone();
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

// Called once when Samantha finishes (or fails) speaking a reply. Lands on
// the idle mic screen, which shows her reply as text — mom reads at her own
// pace (maybe replays), then taps to start recording. The mic never opens
// by itself; interrupting her (talkInterrupt) is the only auto-record path.
function talkOnCharacterDone() {
    talkSetVoiceState("idle");
}

// === Voice input (mom speaks) ===
// One continuous MediaRecorder session per turn, transcribed server-side
// (/transcribe → OpenAI). Unlike Android's SpeechRecognition, this has no
// start/stop beeps, no status-bar flicker, and no deaf restart gaps.

function talkMicSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

var talkRecState = null;   // active recording turn, null when idle
var TALK_MAX_RECORD_SECONDS = 90;   // safety cap if ✓ is never tapped

function talkListening() {
    return talkRecState !== null;
}

function talkListenStart() {
    if (talkListening() || talkState.sending || talkState.micDenied) return;
    // Never open the mic while Samantha's audio plays — it would hear her.
    // The only legal path from speaking to listening is talkInterrupt().
    if (talkState.voiceState === "speaking") return;

    var st = { recorder: null, stream: null, chunks: [], cancelled: false, startedAt: 0, timerId: null };
    talkRecState = st;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        if (talkRecState !== st) {   // cancelled while permission prompt was open
            stream.getTracks().forEach(function (t) { t.stop(); });
            return;
        }
        st.stream = stream;
        var rec;
        try {
            rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
        } catch (e) {
            rec = new MediaRecorder(stream);
        }
        st.recorder = rec;
        rec.ondataavailable = function (e) {
            if (e.data && e.data.size) st.chunks.push(e.data);
        };
        rec.onstop = function () {
            stream.getTracks().forEach(function (t) { t.stop(); });
            if (st.timerId) clearInterval(st.timerId);
            if (talkRecState !== st) return;
            talkRecState = null;
            talkListenUi(false);
            if (st.cancelled) return;
            talkTranscribeAndSend(new Blob(st.chunks, { type: rec.mimeType || "audio/webm" }));
        };
        rec.start();
        st.startedAt = Date.now();
        talkListenUi(true);
        talkSetVoiceState("listening");
        st.timerId = setInterval(function () {
            if (talkRecState !== st) return;
            var secs = Math.floor((Date.now() - st.startedAt) / 1000);
            talkUpdatePendingBubble("🔴 " + Math.floor(secs / 60) + ":" + ("0" + (secs % 60)).slice(-2));
            if (secs >= TALK_MAX_RECORD_SECONDS) talkListenDone();
        }, 1000);
    }).catch(function (err) {
        if (talkRecState === st) talkRecState = null;
        talkListenUi(false);
        talkSetVoiceState("idle");
        if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
            talkOnListenFailed("not-allowed");
        } else if (err && err.name === "NotFoundError") {
            talkOnListenFailed("audio-capture");
        } else {
            talkOnListenFailed("error");
        }
    });
}

// Mic button / pending bubble reflect whether we're recording.
function talkListenUi(on) {
    var mic = document.getElementById("talkMicBtn");
    if (on) {
        mic.classList.add("talk-mic-listening");
        mic.textContent = "✓";   // while listening, the mic button means "I'm done"
        talkShowPendingBubble();
    } else {
        mic.classList.remove("talk-mic-listening");
        mic.textContent = "🎤";
        talkRemovePendingBubble();
    }
}

// She tapped ✓: stop recording; onstop hands the audio to transcription.
function talkListenDone() {
    var st = talkRecState;
    if (!st) return;
    if (st.recorder && st.recorder.state !== "inactive") {
        st.recorder.stop();
    } else {
        // Permission prompt still open — treat the tap as a cancel.
        talkListenStop();
    }
}

// Cancel listening without sending anything.
function talkListenStop() {
    var st = talkRecState;
    if (!st) return;
    st.cancelled = true;
    if (st.timerId) clearInterval(st.timerId);
    if (st.recorder && st.recorder.state !== "inactive") {
        st.recorder.stop();   // onstop cleans up; cancelled skips transcription
    } else {
        if (st.stream) st.stream.getTracks().forEach(function (t) { t.stop(); });
        talkRecState = null;
        talkListenUi(false);
    }
    talkSetVoiceState("idle");
}

// Turn the recorded audio into text. Voice mode pauses on the review card;
// muted text mode drops the transcript into the composer for mom to edit.
function talkTranscribeAndSend(blob) {
    if (blob.size < 2000) {   // essentially nothing was recorded
        talkSetVoiceState("idle");
        talkOnListenFailed("no-speech");
        return;
    }
    talkSetVoiceState("thinking");
    fetch(talkWorkerUrl().replace(/\/$/, "") + "/transcribe", {
        method: "POST",
        headers: {
            "Content-Type": blob.type || "audio/webm",
            "X-Talk-Token": TALK_APP_TOKEN
        },
        body: blob
    }).then(function (res) {
        return res.json();
    }).then(function (data) {
        if (!data || !data.ok) throw data && data.error;
        var text = (data.text || "").trim();
        if (!text) {
            talkSetVoiceState("idle");
            talkOnListenFailed("no-speech");
            return;
        }
        if (talkVoiceMode()) {
            talkShowReview(text);   // pause: let mom approve before sending
        } else {
            talkFillComposer(text); // muted/text mode: let mom edit, then ➤
        }
    }).catch(function (err) {
        talkSetVoiceState("idle");
        if (err && err.code === "daily_limit") {
            talkShowHint("She's had a lot of conversations today and is resting. 🌙 Come back tomorrow!");
        } else {
            talkShowHint("She couldn't hear that — tap the microphone and try again.");
        }
    });
}

// "You said: ..." — shown with her portrait while she thinks/answers, so mom
// can confirm the app heard her right.
function talkShowHeard(text) {
    document.getElementById("talkHeardText").textContent = "You said: “" + text + "”";
}

// Show what was transcribed and wait: mom taps שליחה to send it to Samantha,
// or שוב to throw it away and record again. Nothing reaches /chat until then.
function talkShowReview(text) {
    talkState.pendingText = text;
    document.getElementById("talkReviewText").textContent = "“" + text + "”";
    talkSetVoiceState("review");
}

function talkReviewSend() {
    var text = talkState.pendingText;
    talkState.pendingText = null;
    if (!text) return;
    talkShowHeard(text);   // keep "You said…" visible while she thinks/answers
    talkSendText(text);
}

// Muted text mode: the transcript lands in the text box instead of sending —
// mom reads it, fixes any word, taps ➤ herself (or 🎤 again to replace it).
function talkFillComposer(text) {
    talkSetVoiceState("idle");   // re-enable the mic, hide the thinking pill
    var input = document.getElementById("talkInput");
    input.value = text;          // a re-record replaces the previous attempt
    input.focus();
    input.setSelectionRange(text.length, text.length);
}

function talkReviewAgain() {
    talkState.pendingText = null;
    talkSetVoiceState("idle");
    talkListenStart();     // permission already granted — mic reopens at once
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
    el.dir = "auto";
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
    // Voice mode: live transcript under the big mic, so she can see that
    // the app hears her correctly.
    var live = document.getElementById("talkListenTranscript");
    live.textContent = text === "..." ? "" : text;
    live.scrollTop = live.scrollHeight;
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

// Sync the quiet reply block on the mic screen with the replay cache:
// text whenever there is a last reply, the 🔁 button only when every
// sentence's audio actually made it into the cache.
function talkUpdateListenReply() {
    var r = talkReplayState;
    document.getElementById("talkListenReplyText").textContent = r.text || "";
    document.getElementById("talkListenReply").style.display = r.text ? "" : "none";
    document.getElementById("talkReplayBtn").style.display =
        (r.texts.length > 0 && r.got === r.texts.length) ? "" : "none";
}

// 🔁: play Samantha's last reply again from the Blob cache — instant, no
// /speak re-fetch. If mom is mid-recording, that recording is discarded
// ("wait, let me hear that again first"); when the replay ends,
// talkOnCharacterDone lands back on the read-then-tap mic screen.
function talkReplayLast() {
    var r = talkReplayState;
    if (!r.text || r.got !== r.texts.length || talkState.sending) return;
    if (talkListening()) talkListenStop();   // discard, don't transcribe
    talkSpeakStop();                          // bump generation first
    var gen = talkAudioState.generation;
    document.getElementById("talkSpeakingText").textContent = r.text;
    talkAudioState.queue = r.texts.map(function (text, i) {
        return { text: text, controller: null,
                 promise: Promise.resolve(URL.createObjectURL(r.clips[i])) };
    });
    talkAudioState.index = 0;
    talkAudioState.fetched = talkAudioState.queue.length;  // prefetch no-ops
    talkPlayNext(gen);
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
    talkWakeRelease();
}

document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
        talkVoiceStop();
        // Best effort: bank what she shared before the tab might be killed.
        if (talkUnmemorizedUserTurns() >= 1) talkMemorize();
    }
});

function talkWorkerUrl() {
    return localStorage.getItem("talk_worker_url") || TALK_WORKER_URL;
}

function setTalkStatus(text, className) {
    var el = document.getElementById("talkStatus");
    el.textContent = text;
    el.className = "talk-status" + (className ? " " + className : "");
}

// === Memory: transcripts (stage 19) ===
// Every turn is saved to localStorage the moment it happens (mobile tabs die
// without warning), grouped into one session per page load. A later stage
// distills these into Samantha's long-term memory profile.

var TALK_MAX_SESSIONS = 20;
var TALK_MAX_TRANSCRIPT_CHARS = 200 * 1024;

var talkMemState = {
    sessionId: null,                     // created lazily on first logged turn
    memorizing: false,
    greet: { promise: null, text: null, done: false }
};

function talkMemLoad(key, fallback) {
    try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function talkMemSave(key, obj) {
    try {
        localStorage.setItem(key, JSON.stringify(obj));
        return true;
    } catch (e) {
        // Quota exceeded: prune transcripts hard and retry once.
        try {
            var t = talkMemLoad("talk_transcripts", null);
            if (t && t.sessions.length > 1) {
                t.sessions = t.sessions.slice(-2);
                localStorage.setItem("talk_transcripts", JSON.stringify(t));
                localStorage.setItem(key, JSON.stringify(obj));
                return true;
            }
        } catch (e2) {}
        return false;
    }
}

// Device-local calendar date — never toISOString (UTC would be a day off in
// the Israeli evening, exactly when mom chats).
function talkLocalDate() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) +
        "-" + ("0" + d.getDate()).slice(-2);
}

function talkPruneTranscripts(data) {
    var over = function () {
        return data.sessions.length > TALK_MAX_SESSIONS ||
            JSON.stringify(data).length > TALK_MAX_TRANSCRIPT_CHARS;
    };
    while (data.sessions.length > 1 && over()) {
        // Prefer dropping the oldest fully-memorized session.
        var idx = 0;
        for (var i = 0; i < data.sessions.length - 1; i++) {
            if (data.sessions[i].memorized >= data.sessions[i].turns.length) {
                idx = i;
                break;
            }
        }
        data.sessions.splice(idx, 1);
    }
}

function talkLogTurn(role, content) {
    var data = talkMemLoad("talk_transcripts", { v: 1, sessions: [] });
    if (!talkMemState.sessionId) {
        // First logged turn this page load: remember when we last talked
        // (the newest turn of the previous session), then open a session.
        var prev = data.sessions[data.sessions.length - 1];
        if (prev) {
            var profile = talkMemLoad("talk_profile", { v: 1, updatedAt: 0, text: "", lastTalked: null });
            var d = new Date(prev.updatedAt);
            profile.lastTalked = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) +
                "-" + ("0" + d.getDate()).slice(-2);
            talkMemSave("talk_profile", profile);
        }
        talkMemState.sessionId = "s_" + Date.now();
        data.sessions.push({
            id: talkMemState.sessionId,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            memorized: 0,
            turns: []
        });
    }
    var session = null;
    for (var i = 0; i < data.sessions.length; i++) {
        if (data.sessions[i].id === talkMemState.sessionId) session = data.sessions[i];
    }
    if (!session) return;
    session.turns.push({ role: role, content: content, t: Date.now() });
    session.updatedAt = Date.now();
    talkPruneTranscripts(data);
    talkMemSave("talk_transcripts", data);
}

// === Memory: profile extraction (stage 20) ===

function talkProfileText() {
    return talkMemLoad("talk_profile", {}).text || null;
}

// Turns not yet absorbed into the profile, with per-session counts so the
// bookkeeping can advance exactly what was sent.
function talkUnmemorized() {
    var data = talkMemLoad("talk_transcripts", { v: 1, sessions: [] });
    var turns = [], counts = {};
    data.sessions.forEach(function (s) {
        var fresh = s.turns.slice(s.memorized || 0);
        if (fresh.length) {
            counts[s.id] = s.turns.length;   // absorb up to the current end
            fresh.forEach(function (t) { turns.push({ role: t.role, content: t.content }); });
        }
    });
    return { turns: turns.slice(-40), counts: counts };
}

// Fire-and-forget: distill unabsorbed turns into the profile. Failures are
// silent — the transcript is durable, so the next trigger retries.
// Returns a promise so stage 22 can chain the greeting after a catch-up.
function talkMemorize() {
    if (talkMemState.memorizing) return Promise.resolve();
    var snapshot = talkUnmemorized();
    if (snapshot.turns.length === 0) return Promise.resolve();
    talkMemState.memorizing = true;

    return talkFetch("/memorize", {
        transcript: snapshot.turns,
        profile: talkProfileText() || undefined,
        clientDate: talkLocalDate()
    }).then(function (data) {
        var profile = talkMemLoad("talk_profile", { v: 1, updatedAt: 0, text: "", lastTalked: null });
        profile.text = data.profile;
        profile.updatedAt = Date.now();
        talkMemSave("talk_profile", profile);
        var transcripts = talkMemLoad("talk_transcripts", { v: 1, sessions: [] });
        transcripts.sessions.forEach(function (s) {
            if (snapshot.counts[s.id] !== undefined) {
                s.memorized = Math.max(s.memorized || 0, snapshot.counts[s.id]);
            }
        });
        talkMemSave("talk_transcripts", transcripts);
    }).catch(function () {
        // Silent — retried on the next trigger.
    }).then(function () {
        talkMemState.memorizing = false;
    });
}

// How many of this session's user turns are still unabsorbed.
function talkUnmemorizedUserTurns() {
    var data = talkMemLoad("talk_transcripts", { v: 1, sessions: [] });
    var n = 0;
    data.sessions.forEach(function (s) {
        s.turns.slice(s.memorized || 0).forEach(function (t) {
            if (t.role === "user") n++;
        });
    });
    return n;
}

// === Memory: personalized greeting (stage 22) ===

// The date of the newest turn in the newest session — fresher than the
// stored profile.lastTalked (which lags until the first turn logs).
function talkLastTalkedDate() {
    var data = talkMemLoad("talk_transcripts", { v: 1, sessions: [] });
    var prev = data.sessions[data.sessions.length - 1];
    if (!prev || !prev.updatedAt) return null;
    var d = new Date(prev.updatedAt);
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) +
        "-" + ("0" + d.getDate()).slice(-2);
}

// Kick off during the intro screen: absorb any leftover turns first (so the
// greeting can reference the very last conversation), then ask for a fresh,
// memory-aware opening line. First-ever visit: no profile → static greeting,
// zero extra calls.
function talkPrepareGreeting() {
    talkMemState.greet = { promise: null, text: null, done: false };
    if (!talkProfileText() && talkUnmemorizedUserTurns() === 0) {
        talkMemState.greet.done = true;
        return;
    }
    var lastTalked = talkLastTalkedDate();
    talkMemState.greet.promise = talkMemorize()
        .then(function () {
            var profile = talkProfileText();
            if (!profile) throw new Error("no profile");
            return talkFetch("/greet", {
                profile: profile,
                clientDate: talkLocalDate(),
                lastTalked: lastTalked || undefined
            });
        })
        .then(function (data) {
            talkMemState.greet.text = data.greeting;
        })
        .catch(function () {})
        .then(function () {
            talkMemState.greet.done = true;
        });
}

// Hand the greeting to cb — instantly when ready (the usual case), else
// after at most 2.5s, falling back to the static one.
function talkResolveGreeting(cb) {
    var g = talkMemState.greet;
    var fallback = talkState.character ? talkState.character.greeting :
        "Hello! It's so nice to meet you! How are you today?";
    if (g.done) {
        cb(g.text || fallback);
        return;
    }
    var settled = false;
    var finish = function () {
        if (settled) return;
        settled = true;
        cb(g.text || fallback);
    };
    setTimeout(finish, 2500);
    (g.promise || Promise.resolve()).then(finish, finish);
}

// Dev helpers (nothing in mom's UI). Reset from the browser console with:
//   talkMemoryReset()
function talkMemoryDebug() {
    var t = talkMemLoad("talk_transcripts", { sessions: [] });
    var p = talkMemLoad("talk_profile", {});
    var turns = 0, unmemorized = 0;
    t.sessions.forEach(function (s) {
        turns += s.turns.length;
        unmemorized += s.turns.length - (s.memorized || 0);
    });
    return {
        profile: p.text || "(none)",
        lastTalked: p.lastTalked || null,
        sessions: t.sessions.length,
        turns: turns,
        unmemorized: unmemorized,
        bytes: (localStorage.getItem("talk_transcripts") || "").length
    };
}

function talkMemoryReset() {
    localStorage.removeItem("talk_transcripts");
    localStorage.removeItem("talk_profile");
    talkMemState.sessionId = null;
    return "Samantha's memory was erased.";
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
                if (!talkState.started) talkPrepareGreeting();
                setTalkStatus("Server: connected ✓", "connected");
                // First visit ever: explain in Hebrew instead of the Start button.
                if (localStorage.getItem("talk_onboarded") !== "1") {
                    document.getElementById("talkIntroSubtitle").style.display = "none";
                    document.getElementById("talkOnboarding").style.display = "";
                } else {
                    startBtn.style.display = "";
                }
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

// === Screen wake lock ===
// A conversation is like a phone call — the screen must not dim and lock
// while Samantha talks or mom thinks. Held for as long as the chat is open.

var talkWakeLock = null;

function talkWakeAcquire() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock.request("screen").then(function (lock) {
        talkWakeLock = lock;
    }).catch(function () {
        // Denied or unsupported — the conversation still works.
    });
}

function talkWakeRelease() {
    if (talkWakeLock) {
        talkWakeLock.release().catch(function () {});
        talkWakeLock = null;
    }
}

// The browser drops the lock whenever the tab hides; take it back when mom
// returns to an open conversation.
document.addEventListener("visibilitychange", function () {
    if (!document.hidden && talkState.started &&
        document.getElementById("talkContainer").style.display === "block") {
        talkWakeAcquire();
    }
});

// === Sub-view toggling (same pattern as story mode) ===

function talkShowIntro() {
    document.getElementById("talkIntro").style.display = "";
    document.getElementById("talkChat").style.display = "none";
}

function talkShowChat() {
    document.getElementById("talkIntro").style.display = "none";
    document.getElementById("talkChat").style.display = "flex";
    talkWakeAcquire();
    if (!talkState.started) {
        talkState.started = true;
        var name = talkState.character ? talkState.character.name : "Friend";
        document.getElementById("talkCharName").textContent = name;
        document.getElementById("talkSpeakingName").textContent = name;
        talkRenderStarters();
        // Usually the personalized greeting is already fetched (it raced the
        // intro screen); if not, her portrait "thinks" for up to 2.5s.
        talkSetVoiceState("thinking");
        talkResolveGreeting(function (greeting) {
            talkState.greetingUsed = greeting;
            talkAppendBubble("character", greeting);
            // In voice mode she speaks first, so stay on her "thinking"
            // portrait until the greeting audio starts — flashing the mic
            // for the fetch seconds invites mom to talk too early.
            if (talkVoiceMode()) {
                talkSpeak(greeting);
            } else {
                talkSetVoiceState("idle");
            }
        });
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
    el.dir = "auto";   // Hebrew transcripts render right-to-left
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
    talkLogTurn("user", text);
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

    talkFetch("/chat", {
        messages: history,
        profile: talkProfileText() || undefined,
        clientDate: talkLocalDate(),
        greeting: talkState.greetingUsed || undefined
    })
        .then(function (data) {
            talkState.history.push({ role: "assistant", content: data.reply });
            talkLogTurn("assistant", data.reply);
            talkAppendBubble("character", data.reply);
            talkSpeak(data.reply);
            if (talkUnmemorizedUserTurns() >= 6) talkMemorize();
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
document.getElementById("talkOnboardBtn").addEventListener("click", function () {
    localStorage.setItem("talk_onboarded", "1");
    document.getElementById("talkOnboarding").style.display = "none";
    document.getElementById("talkIntroSubtitle").style.display = "";
    talkAudioUnlock();  // this tap is the first user gesture
    talkShowChat();
});
document.getElementById("talkMuteBtn").addEventListener("click", talkToggleMute);
document.getElementById("talkMuteBtn").textContent = talkMuted() ? "🔇" : "🔊";
document.getElementById("talkMicBtn").addEventListener("click", talkMicTap);
document.getElementById("talkSpeakingView").addEventListener("click", function () {
    if (talkState.voiceState === "speaking") talkInterrupt();
});
document.getElementById("talkListenView").addEventListener("click", talkMicTap);
document.getElementById("talkReplayBtn").addEventListener("click", function (e) {
    e.stopPropagation();   // the listen view's own click is talkMicTap
    talkReplayLast();
});
document.getElementById("talkListenReply").addEventListener("click", function (e) {
    e.stopPropagation();   // touching/scrolling the text must not toggle the mic
});
document.getElementById("talkReviewSendBtn").addEventListener("click", talkReviewSend);
document.getElementById("talkReviewAgainBtn").addEventListener("click", talkReviewAgain);
if (!talkMicSupported()) {
    document.getElementById("talkMicBtn").style.display = "none";
}
document.getElementById("talkSendBtn").addEventListener("click", talkSend);
document.getElementById("talkInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") talkSend();
});
