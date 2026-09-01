# Redline, for people working on it

This folder is for whoever changes this code next — a contributor, or a future session picking
it up cold. [The README](../README.md) is for people *using* Redline; nothing here repeats it.

Read in this order:

| | |
|---|---|
| **[architecture.md](architecture.md)** | What the parts are, what each one owns, and why the boundaries fall where they do. Start here. |
| **[data-model.md](data-model.md)** | A note, its life cycle, and the fields that decide what the UI shows. The single most useful page once you are changing behaviour. |
| **[the-panel.md](the-panel.md)** | The webview: how it is rendered, how it talks to the extension, and the rules it has to obey. |
| **[the-plugin.md](the-plugin.md)** | The Claude Code side: four hooks, what each writes, and how the extension reads it. |
| **[review-range.md](review-range.md)** | "What changed" — the hardest question in the product, and how it is answered. |
| **[testing.md](testing.md)** | Four suites, what each is for, and how to test the thing you are changing. |
| **[conventions.md](conventions.md)** | Where a new file goes, how to add a command, a setting, a note kind. Read before adding anything. |
| **[decisions.md](decisions.md)** | Choices that look wrong until you know why. Read before undoing one. |

## The shortest possible description

A person reviews an agent's work the way they would review a colleague's: they read a diff,
leave notes on the lines that are wrong, and hand the marked-up copy back. Redline is the
machinery for that loop — a VS Code extension that collects the notes and shows the
conversation, and a Claude Code plugin that makes the extension's questions answerable
precisely rather than by guesswork.

Two ideas explain almost every decision in the codebase:

1. **The notes are the product.** A note is a record of something a person asked for, at a
   moment, about a specific piece of code. Nothing may silently lose one, rewrite one, or
   claim something about one that is not true. Several of the sharpest bugs in this codebase
   were the UI saying something honest-sounding and false — "waiting for Claude" about a batch
   that never left the clipboard, an answer shown twice, a follow-up quietly overwritten.

2. **Everything works without the plugin, and better with it.** The plugin is how Redline
   knows exactly which files a run touched and what the tree looked like before it started.
   Without it there are timestamps and heuristics, which are worse but must never be broken.
   Every feature has to answer: what happens for someone who has not installed it?

## Where to start reading the code

`src/extension.ts` is the only file that knows about all the others. It builds every service,
wires the events between them, and registers the commands. If you want to know how anything
reaches anything else, that is the file — six hundred-odd lines, mostly wiring, heavily
commented.
