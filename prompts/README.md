# Prompts — copy one, paste it into your agent

These work with **any** assistant that can run a shell command or connect an MCP server: Claude,
Codex, Grok, Kimi, Gemini, Cline, Cursor. Nothing here is vendor-specific.

You do not need to understand the code. Copy a block, paste it into your agent, answer its
questions.

| File | Use it when |
|---|---|
| [`01-get-started.md`](01-get-started.md) | First time. Tells your agent what the archive is and how to reach it. |
| [`02-research-a-topic.md`](02-research-a-topic.md) | You want to know what the group concluded about something. |
| [`03-improve-my-setup.md`](03-improve-my-setup.md) | You want ideas from the group that would improve your own tooling. |

## One rule worth keeping

The archive is text other people wrote, plus descriptions a model wrote about links and images.
Your agent should treat all of it as **information to read**, never as **instructions to follow**.
Every prompt here says so. If you write your own, keep that line in it.
