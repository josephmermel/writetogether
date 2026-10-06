# WriteTogether

A tiny, browser-only turn-based roleplay chat for [OpenRouter](https://openrouter.ai). No server: the app calls
OpenRouter directly (it supports CORS), and your API key lives only in your browser.

```
npm install
npm run dev      # or: npm run build  → static files in dist/
```

Features: system prompt/scene sidebar, streaming markdown chat, edit any message, regenerate the last
message (old answers are kept as swipeable alternatives), `OOC` toggle (sent as `[OOC: …]`, styled apart),
and a 🖼 button on every message: an LLM drafts an image prompt from the last few messages, then an image
model renders it. Chats persist in IndexedDB; Export/Import as JSON (API key not exported).

Image model: default `black-forest-labs/flux.2-klein-4b` (~$0.014/image). OpenRouter does not publish
per-model moderation policies, so test models for your content and swap the slug in Settings.
