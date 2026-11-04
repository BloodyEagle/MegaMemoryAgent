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
