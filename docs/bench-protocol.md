# Bench protocol: measuring what the knowledge graph actually saves

Two instruments, two different questions:

- **`megamemory bench`** — a script. It measures the **cost of orientation**
  (tokens and time to reach the same knowledge) from the graph's own data.
- **The A/B protocol below** — a manual run. It measures the **behavior of a
  live agent** across whole sessions: what it actually reads, how long until a
  meaningful answer, whether the answer is correct.

One does not replace the other (see [the last section](#what-bench-measures--and-what-it-does-not)).

## The A/B protocol

How to compare two agent sessions honestly. The protocol is executed by hand —
a script cannot run it, because a live agent is part of the measurement.

### Setup

- One project, **10 questions**: half «where exactly does X live»
  (orientation), half «why was it built this way» (design rationale).
- Both sessions answer the same 10 questions, in the same order.
- **Session A — without the graph:** the agent may only read files and grep.
  No `understand`, no memory tools.
- **Session B — with the graph:** `understand` first, then files as needed.

### What to record per question

| Metric | Source |
| --- | --- |
| tokens | provider logs (not estimates) |
| time to first meaningful answer | wall clock, noted manually |
| files read | session log |
| answer correctness | manual check against the known ground truth |

### How to aggregate

- **Medians, not means.** One long «digging» question skews the mean and hides
  the typical case; the median survives it.
- Report orientation questions and rationale questions separately — the graph
  may win one and lose the other.
- The result counts as a win **only if B is cheaper AND not worse on
  correctness**. Cheaper but dumber is not a saving — that is the same rule
  `bench` follows by printing `hit_rate` next to every `ratio`.

## What `bench` measures — and what it does not

`bench` compares token counts the graph reports about itself: the `understand`
answer versus the files of its `file_refs` (or versus an external structural
tool in `--baseline te` mode). That is a **lower bound on orientation cost,
from the graph's point of view**. It does not know:

- whether the agent would have found the answer faster another way;
- whether the answer built on the graph is correct — hence `hit_rate` next to
  every ratio, and questions where the graph lost (`ratio < 1`) printed, not hidden.

The A/B protocol measures the **whole session with a live agent**, including
the human judgement of correctness — but it is manual, slow, and does not fit
CI. Run `bench` often (it is cheap and mechanical), run the A/B protocol when
you need proof the memory actually helps a working agent, not just a reading
list.

**Scope statement (2.1.13).** `bench` measures **context retrieval and hit
quality**: the tokens the graph's answer costs and whether the expected nodes
surfaced. It does **not** measure savings across the whole task execution —
an agent's edit-and-verify loop, its false starts, its re-reads — those live
only in the A/B protocol. Consequently: numbers quoted by **external reviews
of this project are not our measurements** and must not be reproduced in this
repository's docs, README, or CHANGELOG as if they were — cite your own runs
or link the review verbatim.

## How to read the numbers

- **`hit_rate` vs `hit_rate@1`.** `hit_rate` counts a hit when any expected node
  surfaced anywhere in the top-10; `hit_rate@1` counts only when the best expected
  node ranked **first** (the `rank` column shows the position). `hit_rate@1 ≤ hit_rate`
  always — a rank-6 "hit" is a much weaker answer than a rank-1 one.
- **Why `hit_rate@1` can drop after you add knowledge.** Supports (the `informed_by`
  facts behind a decision) contain the query terms verbatim and compete with the
  decision itself, pushing it off rank 1. Since 2.1.7 such **nested supports** fold
  under their decision (`supports` on the node, depth 1) instead of occupying a top
  slot; bench counts a nested support as found at its decision's rank, and
  `meta.supports_inlined` shows how many nodes were folded. When the decision did not
  make the output, its support stays on the top level — knowledge is regrouped, never
  hidden.
- **`r(files)` vs `r(files-top)`.** `r(files)` sums **all** `file_refs` of every found
  node — tens of thousands of tokens and ×50 ratios that no live agent would ever pay,
  because a live agent reads two or three files. Run with `--files-top 3` and read
  `r(files-top)`: the baseline over the first three unique files in the output order.
  `r(files-top) ≤ r(files)` always.
- **`refs: resolved N/M`** — how many unique `file_refs` pointed at existing files.
  Line suffixes (`src/db.ts:9`) resolve to the same file; a ref is tried against
  `ref_roots` (per question), `--ref-root PATH` (repeatable), the git root, then the
  cwd — first hit wins. `missing:N` in the notes means the roots don't match the refs.
- **`unknown_supports`** — found decisions with no confirmed support snapshot: a
  to-confirm queue, not an error. `stale_hits` is the same for decisions whose
  confirmed support has drifted.
- **`cold-start`** — the first question paid the embedding model load; the summary
  prints the warmup time next to the median without it, neither number is hidden.
