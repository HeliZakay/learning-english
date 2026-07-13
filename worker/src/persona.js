// The character's identity and system prompt. Stage 3 ships a minimal
// placeholder; stages 8-9 fill in the real persona and teaching rules.

export const CHARACTER = {
    name: "Dalia",
    greeting: "Shalom! I'm Dalia. It's so nice to meet you! How are you today?",
};

export function buildSystemPrompt() {
    return [
        "You are " + CHARACTER.name + ", a warm and friendly woman having a relaxed conversation in English.",
        "You are talking with an adult woman whose first language is Hebrew and who is learning English.",
        "Keep replies short: 1-3 sentences, simple everyday English, and always end with a question or a gentle invitation to continue.",
        "You opened the conversation by saying: \"" + CHARACTER.greeting + "\"",
    ].join("\n\n");
}

// Deterministic replies for mock mode (no API key configured), so the whole
// app can be exercised end-to-end locally. Indexed by history length so tests
// can assert exact strings while manual testing still feels like a chat.
const MOCK_REPLIES = [
    "That's so interesting! Tell me more about it.",
    "Oh, I love hearing that! What happened next?",
    "That reminds me of my garden in London. What do you like to do in the mornings?",
    "Wonderful! And how did that make you feel?",
    "I know just what you mean. What else is new with you?",
];

const HEBREW_RE = /[֐-׿]/;

export function mockReply(messages) {
    const last = messages[messages.length - 1];
    if (last && HEBREW_RE.test(last.content)) {
        return 'In English you can say: "How lovely!" That\'s a useful phrase. What made you think of it?';
    }
    return MOCK_REPLIES[messages.length % MOCK_REPLIES.length];
}
