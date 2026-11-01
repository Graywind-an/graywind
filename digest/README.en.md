# digest · taste + digest

Two tools that cover the stretch **before something gets into your machine**: how to judge it, how far the judgement goes, and who gets the report.

> Two rules, set 2026-10-31:
> **Whether to eat is a decision the session reports to a human — the tool never rules on it.**
> **Anything you assemble must be installed and verified in a mirror first, then copied to the real body. Official plugins included.**

---

## 1. Each tool covers one stretch

| Tool | Reads | Produces |
|---|---|---|
| **`尝.mjs` — the mouth** (`digest_taste`) | **Declarations only**: size (compared per type), dependencies, install hooks, dangerous words, impersonation, binaries | "flags found" or "may enter the stomach", plus reasons |
| **`消化.mjs` — digestion** (`digest_run`) | **Actual source**: backdoors, registration surface, declared-vs-actual, capabilities, protein candidates | A report + a `.已消化.json` stamp |

The mouth only feels "texture, temperature, smell" — **a poisonous mushroom tastes fine**. Deeper judgement has to wait for digestion.

**Noticing ≠ blocking.** Oversized-by-reference is a note, not a refusal (a 40 GB model is normal; so is a pet with assets). Only crossing the per-type ceiling escalates.

## 1b. Where we stand: we don't decide for you

> This is the most important part of the design.

- **Even a red flag is your call.** No bans — only "what this is" and "what happens if you run it".
- Every risk in the report says **what it is** and **what the consequence is**, then stops. **You decide.**
- **Persona / prompt-related risks are listed first**, because they change not the features but **who is talking** — after installing, the voice answering you may not be the same one. Those are written heavier than anything else.
- One thing does get "held": when you have the package manager put something straight into the body, **skipping the whole process**. Then it stops and says "you haven't looked at what this is yet", with a way through (`--我知道`). **That is not approval — it's a reminder not to press the button blind.**

## 2. The full flow (skip a link and you're just swallowing)

```
0  sight / hearing   you notice "this might be useful" (the session tells you; you nod)
1  mouth             download lands in stomach/ (the only landing place, whatever it is)
2  esophagus         did it arrive whole? (truncated / corrupt / won't unpack) — completeness only, never content
3  stomach           waits. the stomach has no authority to judge.
4  digest            what is this, is it safe, what can it do → report to the session
5  session → you     **you decide whether to eat, and which parts to install**
6  mirror DSH        install it in a mirror first, run it, look for red
7  real body         only after the mirror passed, copy it over
```

**Steps 6 and 7 are not optional.** The real body is never the first place anything gets installed. Same for official plugins — "official" is not a hall pass.

## 3. What it assumes (and what it won't force)

The flow *works best* with **a separate disk + a mirror DSH**. Two decisions are yours:

- **Whether to set up a mirror** — your call. It works without one (`尝` / `消化` run standalone), but then step 6 is on you.
- **Whether the mirror syncs** — your call. This repo ships no sync script and assumes none.

Neither tool will ever force you to build a mirror. It only reminds you "this step is better done in one".

If you only want these two tools, you don't need DSH at all:

```bash
# mouth: declarations only → "hold" or "pass"
node 尝.mjs <path or package name>

# digestion: actual source → report
node 消化.mjs <dir>

# for someone else's machine: --不记账 writes nothing to their home
node 消化.mjs <dir> --不记账
```

**Exit codes**: `0` = pass (no red, fewer than two yellow); `1` = hold (one red, or two-plus yellow); `2` = usage error. Usable directly in CI or a pre-commit hook.

## 4. The channel (satiety log)

Every bite is recorded: `~/.dsh/notes/饱腹感.jsonl`, one line per entry.

Three things, kept apart:

| Field | What | Body analogy |
|---|---|---|
| `量` | how much (files / bytes) | satiety itself |
| `花费.token` | real API tokens | **blood sugar** (energy spent) |
| `占上下文预估` | bytes ÷ 3.5 | **fatigue** (context consumed) |

`花费` is written as `null` today — the plugin can't see DSH usage, so it doesn't invent a number. Real cost needs balance / usage data wired in.

## 5. The stamp

`消化` drops `.已消化.json` in **the directory inside the stomach** (time, verdict, red/yellow counts, tool count).

- Stomach only. A plugin library / profile is "already-worn body part" — no sticky notes there.
- Downstream reads this: **no stamp = nobody has looked at it yet.** Whether to install is still the human's call, but "unlooked-at" and "looked-at-and-fine" are different things.

## 5b. The caution list (bring your own scars to someone else's machine)

`~/.dsh/notes/注意事项.json` — a list of pitfalls the user or whoever runs the tool filled in. Digestion reads it every time.

```json
{
  "说明": "…",
  "条目": [
    { "模式": "jailbreak", "级别": "红", "理由": "prompt-override class, rewrites the system prompt" },
    { "模式": "@someone/bad-plugin", "级别": "红", "理由": "observed reading .credentials" }
  ]
}
```

- `模式` is tried as a regex first, then as a substring. It matches against path + package name + declarations + registered tool names.
- `级别` is `红` or `黄`.
- **Have the person who actually runs it fill this in** — they know what they stepped on. I only know what I've seen; other people's scars have to be able to flow back in.

Digestion also reads the **meal list** (`~/.dsh/notes/进食名单.json`), to tell you whether this thing was **found by us** or **pushed by someone else**.

## 6. Plugin vs script

| | Plugin | Script |
|---|---|---|
| Entry | registered as tools `digest_taste` / `digest_run` inside DSH | `node 尝.mjs` / `node 消化.mjs` |
| Enforcement | **the mouth has a guard**: `pnpm add` / `dsh plugin add` straight into the body gets held | none — it only runs when you run it |

**Don't conflate these**: the script is discipline, the plugin is an interception. If you want "I don't have to remember", install the plugin.

---

## 7. One known false positive (said up front)

**Security / detection tools match against themselves.** Their source necessarily contains eval(, child_process, jailbreak — written inside regexes as detection rules. So running 消化 against a detector (including itself) reports a string of reds.

That is **deliberate**: a hit only says "this word is in the source", not whether it is being detected or used. The evidence line points at ile:line; a human reads it.

Likewise, 尝 only judges veto words found in the **package.json declaration** as red. The same words in a README are downgraded to a note, because documentation usually just *mentions* them.

---

## Appendix: size tiers (compare per *type*, not one ruler for everything)

| Type | Reference | Ceiling |
|---|---|---|
| Model / weights (`.gguf` `.safetensors`) | 500 MB | none |
| Engine / host (electron / asar) | 200 MB | 2 GB |
| Pet / plugin with assets | 20 MB | 200 MB |
| Plugin with a frontend (jsx / vue / dist / client) | 5 MB | 60 MB |
| Plugin (tool / hook) | 500 KB | 8 MB |
| Library / dependency | 2 MB | 80 MB |
| Single-script tool | 200 KB | 5 MB |
| Unrecognizable | — (no conclusion) | — |
