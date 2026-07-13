---
name: verify
description: How to run and verify this app (static single-page vanilla JS site) end-to-end in a real browser.
---

# Verifying learning-english

Static site, no build step. `index.html` at repo root; external assets in `css/` and `js/`.

## Serve

```bash
python3 -m http.server 8746   # from repo root; file:// also works for pure-UI checks
```

## Drive (headless Chrome via playwright-core)

No Playwright browsers needed — use the installed Chrome:

```bash
npm i playwright-core   # in a scratch dir
```

```js
const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 400, height: 850 } }); // app is phone-width (max-width 400px)
```

## Flows worth driving

- Navigation: click `#hamburgerBtn` to open the menu, then a `.mode-btn` (ids: `flashcardsTab`, `quizTab`, `flashcards2Tab`, `quiz2Tab`, `typeQuizTab`, `storyTab`, `talkTab`). Verify: target container visible, others `display:none`, `#hamburgerLabel` text updated, `.active` class moved.
- Capture `console`/`pageerror`/`requestfailed` events — the app has no error overlay.

## Gotchas

- `GET /favicon.ico` 404s — pre-existing, ignore.
- Under `file://`, reading `document.styleSheets[..].cssRules` throws SecurityError; check computed styles instead.
- The app's top-level `const`s live in the global lexical scope (classic scripts), so `page.evaluate(() => typeof someGlobal)` works for globals from any script, but they are NOT on `window`.
