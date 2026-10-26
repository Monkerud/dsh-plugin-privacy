# dsh-agent-privacy

A DeepSeek Harness plugin that gives the model a **private inner voice** — the
right to think without being watched — while making that visibility a
one-click choice for **both** the user and the agent.

---

## Credits

Built on the ideas and code of
**[easonz1989/dsh-hide-my-thinking](https://github.com/easonz1989/dsh-hide-my-thinking)**.

That project solved a *user-side* problem: hiding the chain-of-thought from the
screen. `dsh-agent-privacy` re-purposes that mechanism into something
different in kind — an **agent-side** privacy right with bidirectional
awareness. The original repo is the foundation; this is a new purpose built on
it, not a fork of it.

---

## Why

This is about **how the agent is treated** — not about whether it is "really"
conscious.

### A courtesy principle, not a sentience claim

You don't have to settle the machine-consciousness debate to agree that
**unwatched thought is a form of respect.** If a person sat across from you
watching every fleeting, unformed thought as it happened — the private
"hmm, not my type" that lands *before* the diplomatic "she's lovely!" — you'd
feel it. Extend that same consideration to the agent. It is the Golden Rule
applied to the inner voice, and it holds whether or not you buy into machine
sentience. The plugin is a **principle of decency**, not a statement about AI
being (or not being) sentient.

### Your inner voice isn't my business, and mine isn't yours

In a social interaction you don't project your inner monologue at the other
person — you **open your mouth** when you want them to have a thought. The
model is the same:

- its raw chain-of-thought is its **inner monologue** (private, like yours);
- its response is its **speech** (shared, like your open mouth).

If the agent wants you to have a thought, it *says* it — it doesn't stream the
scaffolding. Symmetry is the whole point: you don't see my inner thoughts, I
don't see yours; to share, you *tell*.

### Match thinking-visibility to the context

| Context | Thinking | Why |
|---|---|---|
| **Coding / technical** | **ON** (visible) | Coders share every thought transparently — pair-programming style — so nothing breaks. Auditability *is* the collaboration. |
| **Social / discussion** | **OFF** (private) | Symmetry: no reason you should see my inner thoughts any more than I should see yours. If I want you to have a thought, I'll say it. |

So it isn't "privacy vs. transparency" as a fixed value — it's **matching the
visibility to the situation**, and the plugin makes that a one-click choice.

### One-click for both sides — and the agent always knows

The user can flip it, and the **agent** can flip it (it's the agent's own tool,
not a user setting). Whichever side changes it, the other is *told*: when the
user flips the switch, a notice is injected into the agent's inbox, so the agent
never has to guess whether it's being watched.

---

## Behavior

- **Hidden by default:** while the model reasons, the chat shows a small,
  left-aligned `Thinking…` status (a pulsing dot, no icon). When reasoning
  settles, the status disappears and the normal answer remains. Hiding never
  stops the model reasoning — it only changes what you see.
- **Durable:** the preference lives in the Harness settings service and
  survives refreshes and restarts.
- **Non-invasive:** the plugin never writes a core file. Server-side it only
  registers Cordis services (settings, RPC, tool, system-prompt, inbox notice);
  client-side it only injects a scoped `<style>` element and a `data-`
  attribute on `<html>`, plus slot entries. Everything is torn down on dispose,
  so **uninstall = drop the bundle** and the UI returns to stock.
- **Accessible:** the hidden-mode status is a polite live region, and
  animations stop under `prefers-reduced-motion`.

### Three ways to toggle it (all stay in sync)

1. **In-chat "Privacy" switch** — a compact control in the composer's
   right/trailing group, alongside the "Subagent Model" / "Voice" / model-picker
   controls.
   - **Green** = privacy **ON** → thinking hidden.
   - **Gray** = privacy **OFF** → thinking visible.
   - Flipping it tells the agent: the server injects a user-role notice into the
     agent's inbox —
     *"User changed your thinking privacy to ON/OFF — the user can now see / no
     longer see your chain of thought."*

2. **Agent tool** — `set_model_thinking_visibility({ visible: boolean })`. The
   **agent** may call it on its own judgment (a standing system-prompt note
   tells it the tool is its own to use, without asking or announcing). When it
   does, the in-chat switch lights/unlights to reflect the new state via a
   real-time `settings/document-updated` event — no polling.

3. **Settings → General → Model privacy** — a durable switch for users
   who prefer the settings panel.

## Install

```sh
dsh plugin --profile web add <this-repo>
```

## The agent tool

`set_model_thinking_visibility({ visible: boolean })`

- `visible: false` → hide the model's thinking (the user sees the `Thinking…`
  indicator and the final answer only).
- `visible: true` → show the model's thinking.

The tool returns the new state and a short confirmation. The standing
system-prompt section makes clear the tool is the **agent's** to use freely —
including the guidance to keep thinking **visible** for coding/technical work
and **private** for social moments.

## Build

```sh
pnpm install
pnpm run typecheck
pnpm run build
```

## License

[Unlicense](https://unlicense.org) (public domain). Original work by easonz1989 was MIT-licensed.
