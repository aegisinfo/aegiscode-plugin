# AEGIS Desktop — Social Marketing Plan (YouTube · Facebook · Reddit · X)

**Product:** AEGIS Desktop — `npm i -g aegis-desktop && aegis` · Electron app, v0.7.1
**Repo:** `aegiscloud/aegiscode-desktop` · **Site / free key:** https://aegiscloud.org
**Owner:** Niklas Borneklint · **Horizon:** 90 days, then re-plan on data
**Guiding rule:** every channel drives to **one** action — *install the app and get a key*. Not stars, not likes.

> Verify version numbers and screenshots immediately before any scheduled post. Everything in this doc that describes *features* is drawn from `README.md` / `docs/product-plan.md`; anything that describes *traction* must be measured, never asserted.

---

## 1. Positioning — the sentence everything else inherits

**Primary claim (the wedge):**

> **AEGIS Desktop is the coding agent you can point at any model — your local Ollama box, your own OpenAI or Anthropic key, or the pooled AEGIS cloud — with one key, one session file, and one cross-machine memory.**

**Three supporting claims (use one per post, never all three):**

1. *Not locked to a host.* The same brain lives in the desktop app, the CLI, and a Claude Code plugin. Claude Code is optional, not required.
2. *Not locked to a provider.* Four model classes in one picker: Aegis Cloud (pooled or pinned), Ollama, any OpenAI-compatible endpoint (LM Studio/OpenRouter/vLLM), any Anthropic-compatible endpoint.
3. *Not a chat toy.* It has a real agentic tool loop — read/write/edit files, glob, grep, persistent shell `exec`, and `task` subagent delegation — behind a diff/approval card, plus an unattended queue (`aegiscode autonomous proceed`) and a global quick launcher on `Ctrl/Cmd+Shift+Space`.

**Anti-positioning (what we are NOT, stated plainly in copy):** not another wrapper with a monthly seat price, not a cloud-only IDE, not a VS Code fork. It's a small app that does the agent loop well and gets out of the way.

**Tagline bank (pick one per channel for consistency):**
- YouTube: *"Bring your own model. Keep your own memory."*
- X: *"One key. Any model. Same memory everywhere."*
- Reddit: *"I built a desktop coding agent that doesn't care which model you use."*
- Facebook: *"Your AI coding assistant, running on the model *you* chose."*

---

## 2. Audiences (write to one at a time)

| # | Segment | Where they live | What hooks them | What repels them |
|---|---|---|---|---|
| **A** | Claude Code / CLI-agent power users | r/ClaudeAI, r/ChatGPTCoding, X AI-dev circle | "same memory as your terminal sessions — thread typed in the CLI shows up in the app, no sync" | marketing gloss, "revolutionary" |
| **B** | Local-LLM / self-hosted crowd | r/LocalLLaMA, r/ollama, r/selfhosted | "Ollama is a first-class class in the picker, no key, no proxy" | anything that phones home by default; be explicit about what syncs |
| **C** | Indie devs & tool hoppers | r/SideProject, r/opensource, FB AI-tools groups, YouTube search | the autonomous queue + approval card: "it committed only the files it wrote" | subscription fatigue, forced signup |

Segment A is the beachhead (highest intent, most likely to file issues and post screenshots for you). Segment B is the credibility engine. Segment C is volume.

---

## 3. The asset factory — record once, publish everywhere

Shoot **five raw screen captures** in week 1 (1440p, clean desktop, no notifications, cursor visible, 60fps). Everything for 90 days is cut from these:

| Capture | Content | Feeds |
|---|---|---|
| **R1 — First run (4 min)** | install → key → first prompt → answer | YouTube long-form, FB Reel, Shorts |
| **R2 — Model switcher (2 min)** | Cloud → Ollama → custom OpenAI baseURL → Anthropic, same prompt, four answers side by side | X thread, Shorts, Reddit GIF |
| **R3 — Tool loop + diff card (3 min)** | "add a retry to the flaky test" → approve diff → `exec` runs tests green | YouTube, Shorts, X, Reddit |
| **R4 — Memory (2 min)** | `/aegis-remember` in Claude Code in the terminal → open desktop → remember button on the reply → recall on second machine | X, YouTube |
| **R5 — Autonomous queue (4 min)** | `aegis autonomous reconcile --auto` → drives PLAN.md phases → commit scoped to written files | YouTube, Reddit (segment A loves this) |

**Slice ratio:** 1 long-form (6–10 min) → 3 Shorts (≤45s, vertical 1080×1920 re-frame) → 1 GIF (≤8 MB, for Reddit/X) → 4 stills (thumbnails, carousels, docs).

**Non-negotiable quality bar:** no fake typing, no sped-up "look how fast"; real repos, real errors, including at least one failure per video. Dev audiences punish perfection-theatre.

---

## 4. Channel plans

### 4.1 YouTube — the trust layer (highest effort, slowest payoff)

**Role:** search-anchored proof. Someone Googling "ollama desktop coding agent" or "claude code alternative gui" in month 4 must find us.

**Two formats, two cadences:**
- **Long-form: 2/month** (weeks 1, 3). 6–10 min, screen + voice, chapters.
- **Shorts: 3/week**, sliced from R2/R3/R4. Vertical, burned-in captions, hook in the first 1.5s.

**Title formula** (benefit + constraint, no clickbait):
- `A desktop coding agent that runs on YOUR model (Ollama, Claude, or pooled)`
- `One session file for CLI and GUI — how AEGIS Desktop shares memory with Claude Code`
- `I queued 10 tasks and walked away: unattended agent runs that only commit what they wrote`
- `Ollama vs Claude vs pooled cloud on the same coding task`

**Thumbnail rule:** one big fragment of real UI (the model-class picker, the diff card) + ≤4 words. No faces, no arrows, no red circles.

**Description template:**
```
AEGIS Desktop — bring your own model, keep your own memory.

Install:   npm i -g aegis-desktop && aegis
Free key:  https://aegiscloud.org
Source:    https://github.com/aegiscloud/aegiscode-desktop

In this video: <3 bullets>
Chapters: 00:00 … / 01:20 … / 03:40 …

Model classes shown: Aegis Cloud pool · Ollama (local, no key) · custom OpenAI-compatible · Anthropic-compatible
Tools shown: readFile writeFile editFile listDir glob grep exec task

#ollama #claudecode #localllm #aidevtools #electron
```
**Chapters on every video.** End screen → best-performing previous video + subscribe. Pinned comment: the install one-liner plus "tell me which model class you want me to benchmark next".

**SEO targets (repeat these phrases naturally):** *local LLM coding agent*, *Ollama desktop agent*, *Claude Code GUI alternative*, *BYOK coding assistant*, *cross-machine AI memory*, *open source coding agent*, *electron AI coding app*.

**Backlog (first 8 long-form):**
1. The 4-minute tour (R1)
2. Any model, one app (R2)
3. Diff-approval agent loop, explained (R3)
4. Memory that follows you across machines (R4)
5. Unattended: the autonomous queue (R5)
6. Local-only mode: what leaves your machine and what doesn't (privacy explainer — highest shareability in segment B)
7. Migrating from a Claude Code–only workflow
8. Building an app *with* AEGIS Desktop, start to finish

---

### 4.2 X — the heartbeat (fastest feedback, cheapest distribution)

**Role:** build-in-public cadence, dev-audience discovery, live iteration notes.

**Cadence:** 1–2 posts/day + 1 thread/week + 10 substantive replies/day.

**Content mix (the 4-3-2-1 rule per 10 posts):** 4 product-in-action (GIF/screenshot + one line), 3 build-in-public (changelog, a bug you fixed, a tradeoff you made), 2 replies-as-content (answer a real question from a real user in public), 1 ask (feedback, feature vote, "what should I benchmark").

**Weekly thread skeleton (Monday):**
```
1/ I shipped <thing> this week in AEGIS Desktop. Here's the problem it solves and the thing I got wrong first. 🧵
2/ The problem: …
3/ What the app does now: <GIF>
4/ The part that surprised me: …
5/ Install: npm i -g aegis-desktop && aegis  ·  free key at aegiscloud.org
6/ What should I build next: (a) … (b) … (c) …  ← replies drive the next sprint
```

**Discovery work that actually moves the needle:**
- Reply-target list (10–15 accounts, not for spam — for *answered* questions): Ollama, LM Studio, LocalLLaMA-adjacent devs, Claude Code tooling accounts, Electron/indie-hacker circles. Rule: never link in the first reply; only link if asked.
- Screenshot-first posts beat link posts ~5:1 on reach. Put the URL in the reply.
- Quote-tweeting your own older posts when a feature ships is free distribution.

**Profile hygiene:** pinned post = the 40-second R3 GIF + install line. Bio: `AEGIS Desktop — one key, any model, same memory everywhere. npm i -g aegis-desktop`. Link → aegiscloud.org with UTM.

**Copy bank:**
- `Your AI coding agent shouldn't care which model you use. AEGIS Desktop runs on pooled cloud, your Ollama box, or your own Anthropic/OpenAI key — same app, same session, same memory.`
- `The diff card is the whole product. The agent proposes, you approve once or for the session, and it only commits files it wrote. GIF:`
- `Terminal thread → desktop app, zero sync. Same ~/.aegiscode/sessions.json.` + 20s clip
- `Local mode, plainly: Ollama class = nothing leaves your machine. Cloud memory sync is opt-in per message (the remember button). No dark patterns.`

---

### 4.3 Reddit — the credibility layer (highest ROI per post, highest ban risk)

**Role:** one well-crafted post per subreddit can out-deliver a month of X. Treat each as a **launch**, not a share.

**Hard rules (break these and you lose the account):**
1. Read the sub's self-promo rules *that week*. Many require karma/age or a flair.
2. **9:1 ratio.** Ten genuinely useful comments in a subreddit before you post anything about your own product.
3. Never a bare link post. Format is always: **problem → what I built → how it works → honest limitations → link in a comment**.
4. Disclose authorship in the first line: *"I built this, so take the comparison with salt."*
5. Answer every comment for the first 6 hours. Reddit ranks by early engagement velocity.
6. One subreddit per day, maximum. No cross-posting the same text.

**Target map:**

| Subreddit | Angle | Format |
|---|---|---|
| **r/LocalLLaMA** | "Ollama is a first-class model class, not a bolt-on. Here's the picker." | Image post (model picker) + comparison in comments. No launch language. |
| **r/ollama** | Setup walkthrough: install → pick Ollama → working agent in 90 seconds | Text post with steps + GIF link |
| **r/ClaudeAI** | "Shared session file with the CLI + the plugin — thread in terminal shows up in the GUI" | Text post, scoped tightly to that one fact |
| **r/ChatGPTCoding** | The agentic tool loop + diff approval card | GIF + text |
| **r/SideProject** | Build story: what I got wrong, what the autonomous queue fixed | Text post, launch tone allowed here |
| **r/opensource** | Repo, license, install, contribution guide | Text + link |
| **r/selfhosted** | Local class + BYOK, explicit data-flow diagram of what syncs | Text post with a diagram |
| **r/LLMDevs** | Architecture: four wire classes over one SSE channel, keys in main process only | Technical text post — no pitch at all, link only if asked |
| **r/commandline** | The CLI/queue side: `aegiscode autonomous reconcile --auto` | Text post |
| **r/electronjs** | Build notes: subtree-split desktop repo, updater, ipc surface | Text post, engineering-only |
| **r/devops** | "Unattended agent that only commits the files it wrote" | Text post, careful with tone |

**Post template (text post, any sub):**
```
Title: <plain, no hype> — e.g. "I made a desktop coding agent where Ollama, Claude, and a pooled cloud are the same picker"

Disclosure: I built this.

Problem: <2 sentences, from your own workflow>

What it does: <4 bullets, feature-level not benefit-level>

What it does NOT do: <3 honest bullets — e.g. no Windows ARM build yet, queue is cloud-class only>

Install: npm i -g aegis-desktop && aegis
Repo: <link>   Free key: aegiscloud.org   ← put this at the END, after the limitations
```

**Comment-farming first:** in the 2 weeks before launch, leave 20+ high-value comments in r/LocalLLaMA / r/ollama / r/ClaudeAI answering model-config questions. Then your launch post has an account history that doesn't look like a drive-by.

**Moderation escalation:** if a mod removes a post, reply once, politely, asking which rule — then fix and re-post in ≥30 days. Never argue, never delete-and-repost instantly.

---

### 4.4 Facebook — reach + retention (lowest priority, cheapest to run)

**Role:** two jobs only — (a) Reels/Shorts syndication for a non-X audience, (b) presence in developer/AI groups, which are surprisingly effective for *non-US* and older-dev reach.

**Cadence:** 3 posts/week on the Page + 3 Reel cross-posts/month (re-cut Shorts with native captions) + 3–5 group posts/month.

**Page setup:** name `AEGIS Desktop` (not a personal profile), category Software, CTA button → aegiscloud.org, pinned post = the 40s demo + install line. Auto-cross-post from the Page to Instagram later if it's cheap.

**Group targets** (join, participate 2 weeks before posting): *Local LLM / AI Enthusiasts*, *Claude AI Users*, *AI for Developers*, *Self-Hosted AI*, *Indie Hackers*, plus any Swedish/Nordic dev groups (localization advantage — post in Swedish there).
Same disclosure + limitations-then-link discipline as Reddit. FB groups punish drive-by links harder than Reddit does; lead with the explanation of *what leaves your machine*.

**Content that works on FB (differs from X):** plain-language explainers, "I switched from X to this" narratives, and screenshots with big readable text. Avoid CLI-only screenshots — they die on FB.

---

## 5. 90-day calendar

| Week | YouTube | X | Reddit | Facebook |
|---|---|---|---|---|
| **0** | Record R1–R5 | Set up profile, pin post, start 10 replies/day | 10 useful comments, no links | Create Page, join 5 groups |
| **1 — Launch** | Long-form #1 (tour) + 3 Shorts | Launch thread + daily GIFs | r/LocalLLaMA (picker image) → r/SideProject | Page live, first Reel |
| **2** | 3 Shorts | 4-3-2-1 mix, week-1 changelog thread | r/ollama + r/ChatGPTCoding | 1 group post (local LLM angle) |
| **3** | Long-form #2 (any model) | Model-comparison thread | r/ClaudeAI (shared session file) | Reel: R2 clip |
| **4** | 3 Shorts | Ask-post: what to benchmark | r/opensource (repo) | 1 group post (Claude users) |
| **5** | Long-form #3 (diff card) | Build-in-public: a bug + fix | r/selfhosted (data-flow) | Reel: R3 clip |
| **6** | 3 Shorts | Privacy/local explainer post | r/LLMDevs (architecture, no pitch) | 1 group post |
| **7** | Long-form #4 (memory) | Cross-machine memory thread | r/commandline (queue) | Reel: R4 clip |
| **8** | 3 Shorts | User-story repost (with permission) | r/devops (unattended) | 1 group post |
| **9** | Long-form #5 (queue) | "10 tasks queued" thread | r/electronjs (build notes) | Reel: R5 clip |
| **10** | 3 Shorts | Roadmap poll thread | r/SideProject follow-up | 1 group post |
| **11** | Long-form #6 (privacy) | Guest/collab outreach thread | r/LocalLLaMA (benchmark, if you have real numbers) | Reel |
| **12** | Long-form #7 (workflow) | 90-day retro, public numbers | r/ollama follow-up | Reel |
| **13** | **Re-plan on data** — kill the bottom channel, double the top | | | |

**Repurposing chain (one asset, five posts):** long-form → Shorts → GIF → X post → Reddit image post → FB Reel. Never create channel-native content except for Reddit text posts (those must be written fresh).

---

## 6. Launch sequence

**T-7:** repo README polished, install verified on a clean machine (Linux AppImage + deb at minimum, macOS dmg if built), a 40-second demo GIF at the top of the README, screenshots in `desktop/README.md`, npm version published and `npx aegis-desktop` smoke-tested. Nothing in this plan works if the install hiccups.

**T-1:** record everything, schedule Shorts, pre-write the X thread and the Reddit drafts, join the FB groups, warm the Reddit account with comments.

**Launch day (Tue–Thu, 14:00–16:00 UTC):**
- 09:00 publish YouTube long-form #1
- 10:00 X launch thread, pinned
- 12:00 Reddit post #1 (r/LocalLLaMA or r/SideProject — whichever your account history fits)
- 15:00 FB Page post + first group post
- Then: **be in the comments for 6 hours.** That's the whole launch.

**T+1:** GitHub/npm/HN-adjacent follow-ups, reply to every issue within 12h, post the first "here's what broke" note.
**T+7:** post the first real user screenshot (ask permission), publish "what we learned in week one" — honest numbers, including the bad channel.

---

## 7. Measurement

**UTM scheme (every link, no exceptions):**
`https://aegiscloud.org/?utm_source=<youtube|x|reddit|facebook>&utm_medium=social&utm_campaign=launch&utm_content=<week>-<asset>`

**Funnel:** impression → profile/repo visit → install command → first run → key issued. Report per channel per week.

**North-star per channel:**
- YouTube: watch-through > 50% on long-form; Shorts → profile clicks
- X: link clicks + profile visits (engagement is a vanity metric here)
- Reddit: **comments per post** (proxy for credibility) and non-author commenters
- Facebook: group-post saves/comment threads, Reel 3s retention

**Targets (day 90, set deliberately modest so they're honest):** 4 long-form + 36 Shorts on YouTube; 300 X followers with ≥5% link CTR on launch posts; 6 subreddit posts with ≥20 comments each and zero removals; 2 qualifed FB groups where you're a recognized participant. Adjust to reality after week 4 — never report a target as a result.

**Kill criteria:** any channel under 5% of total installs at day 45 goes to syndication-only (auto-post, zero bespoke effort) and its hours move to whichever channel leads.

**Instrument once:** GitHub release/npm download counts, aegiscloud.org key-creation source param, and a plain weekly `docs/marketing-log.md` with what shipped, what it got, what you'd change. Public numbers on X only when they're real.

---

## 8. Voice & compliance guardrails

- **No unverifiable claims.** No "10x faster", no invented benchmarks, no "thousands of users". If you haven't measured it, say "in my testing on <machine>".
- **Privacy language must be precise.** Ollama class = local. Cloud memory sync = happens on the remember button / sync; say exactly that. Ambiguity here costs the segment-B audience permanently.
- **Price language:** free key at aegiscloud.org; pooled inference and BYOK relay have a ledger; link to `/pricing` rather than quoting numbers in a tweet that will age badly.
- **Disclose authorship everywhere** (Reddit first line, X bio, FB Page "About").
- **Never edit a post to remove a criticism.** Reply to it.
- **License/attribution:** MIT — say so; it's a trust signal in r/opensource.
- **Don't brand-park accounts.** One Page, one project handle; no fake user accounts, ever.

---

## 9. Budget & tooling (keep it under €50/month)

| Need | Tool | Cost |
|---|---|---|
| Scheduling (X + FB + YT) | Buffer free tier / Typefully free tier | €0 |
| Shorts clipping + captions | CapCut / ffmpeg + Whisper | €0 |
| GIF/screen capture | OBS + Peek + `gifski` | €0 |
| Thumbnails | Figma free / Krita | €0 |
| Analytics | native + aegiscloud.org UTM source param | €0 |
| Optional boost | €50/mo, spent ONLY on the top-performing organic post per channel | €50 |
| **Paid ads** | **none in the first 90 days** | — |

Paid stays off until an organic post proves a hook. Boosting a post that already won is the only defensible spend.

---

## 10. Weekly ritual (90 minutes, non-negotiable)

1. **Mon 20 min** — publish the X thread; schedule the week's Shorts.
2. **Wed 40 min** — record one raw capture (new feature or a better take of an existing one).
3. **Fri 30 min** — log the week in `docs/marketing-log.md`; cut the bottom 20% of planned work; answer all pending replies in the two best channels.

If a week goes by with no log entry, the plan is drifting — re-read §7 kill criteria and cut a channel.
