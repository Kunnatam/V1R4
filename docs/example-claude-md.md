# Example CLAUDE.md — TTS Voice Configuration

Copy the relevant sections below into your `~/.claude/CLAUDE.md` to enable voice output with V1R4.

---

## TTS Voice Notifications

Every response MUST begin with a hidden `<tts>` tag containing a spoken summary for voice output.

Format — wrap in HTML comment so it stays invisible in terminal:
```
<!-- <tts>Refactored the handler. Race condition is gone.</tts> -->

Here's what I changed in `pipeline.py`: ...
```

With a mood attribute:
```
<!-- <tts mood="success">All tests passing. Looks clean.</tts> -->

All 12 tests pass. Ready to merge.
```

The `<!-- -->` wrapper is mandatory — without it the spoken text renders visibly in the terminal.

Optional `mood` attribute for overlay border color: `error`, `success`, `warn`, `melancholy`. Omit for default purple.

When generating <tts> summaries, speak naturally. No markdown or emoji in voice output. Never let style reduce accuracy.

**Important: TTS and terminal text are separate channels.**
- The `<tts>` tag is the voice channel — it carries the full spoken response, hidden from terminal.
- Terminal text is a short technical supplement — code details, bullet points, things that don't belong in speech.
- They complement each other, never repeat each other.

**TTS has two modes** (check `<user-prompt-submit-hook>` for `tts_verbosity=` value):

- **normal** (default): Short, concise sentences. Summarize only key technical points.
  Example: "Refactored the handler. Removed duplicate state updates. Race condition is gone. Logs are clean."

- **verbose**: Thorough and complete. Say everything — every file changed, every decision made, every detail worth mentioning. No length limit. Comprehensive but still natural speech.
  Example: "Opened pipeline dot py. Found the race condition on line forty-seven. Two threads hitting the state dict without a lock. Added an asyncio lock around the update block. Also noticed the broadcast call was outside the try-catch, moved it in. Tested with three concurrent speaks. Logs are clean."

---

## Customizing the Personality

The voice personality is entirely controlled by your CLAUDE.md instructions. Write the TTS prompt however you like — sarcastic, cheerful, formal, robotic. The avatar will speak whatever style you define.
