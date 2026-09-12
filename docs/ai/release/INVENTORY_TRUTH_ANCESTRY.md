# Inventory Truth release train — ancestry graph (independent verification, 2026-09-12)

Verified from Git objects in a fresh detached worktree at review HEAD
`5cb4caa0d5b3c86b00954d77cd40b16027c21df1` after fetching all refs from
`vn-2f/frigo-dev` (GitHub repository ID **1364064929**; the historical owner name
`vb-2f/frigo-dev` now answers HTTP 301 to the same repository ID). Nothing was
merged, rebased, reset, cherry-picked or force-pushed.

## Checkpoints and `git merge-base --is-ancestor <SHA> 5cb4caa`

| Checkpoint | SHA | Ancestor of T12 docs HEAD |
| --- | --- | --- |
| Main baseline (`origin/main` today) | `d1b06732f8a80db4e77986df31ff28d9f04641fa` | YES |
| T08 application (`feat(t08): add guarded idempotent legacy backfill`) | `dd2ecc6f7066250dfdc5214a3d6c356e1479b61e` | YES |
| T08 verified checkpoint | `fb00f46d4633c9659e812be9f86119533973a8bd` | YES |
| T08 final docs | `8f8788c1a0c9e486657751ef3875a5baa5334dec` | YES |
| T09 application freeze | `bf391c5fdcdd9e9c2f2257db515815e082cb4381` | YES |
| T09 docs HEAD | `d522769ae89496fd4b3f26419f1fdfe23d9e926a` | YES |
| T10 application freeze | `7393edcd4fb9cc8bb4df2a06628fb5dc57f8607b` | YES |
| T10 docs HEAD | `c71692a5a6bd398c1296f2dd747aa356a39cfedc` | YES |
| T11 application freeze | `c15c9a81fc4367b3506a7e2693798ebe1424b0a9` | YES |
| T11 docs HEAD | `847b03632d924b136002cb1791e7f75cb15365e1` | YES |
| T12 application freeze (**release candidate**) | `d15600186c3e73faba011eb690ac6cd70e8d3d2d` | YES — direct parent of `5cb4caa` |
| T12 docs HEAD (review start) | `5cb4caa0d5b3c86b00954d77cd40b16027c21df1` | — |

Ordered chain (each earlier checkpoint is an ancestor of the next): main → dd2ecc6 →
fb00f46 → 8f8788c → bf391c5 → d522769 → 7393edc → c71692a → c15c9a8 → 847b036 →
d156001 → 5cb4caa: **11/11 YES**. `5cb4caa` differs from `d156001` only under
`docs/` (12 files, +218/−15). Missing expected application ancestors: **none**.

T08 ancestry from Git (not from notes): the first T08 commit `43718c2`
(`docs(t08): add isolated inventory truth working context`) has parent `d1b0673`;
T08 application commits are `e6ba715 → cdffb42 → dd2ecc6`, followed by docs
`b5577ea → 4cc290f → fb00f46 → 8f8788c`. T09 begins at `e56f163` directly on
`8f8788c`.

Counts from `d1b0673`: 55 commits to `5cb4caa` (36 first-parent), 54 to `d156001`.
`origin/main` is exactly `d1b0673` (0 commits behind either candidate).

## ASCII graph (time flows downward; `M` = merge commit inside the train)

```
d1b0673  main baseline  ── origin/main today (unchanged)
   │
   │  T08 — inventory truth foundation
   ├─ 43718c2 ─ e6ba715 ─ cdffb42 ─ dd2ecc6 (app) ─ b5577ea ─ 4cc290f ─ fb00f46 (verified) ─ 8f8788c (docs)
   │
   │  T09 — lot engine / event authority
   ├─ e56f163 ─ c212ded ─ 5d10bc5 ─ 13133b3 ─ cc3121d ─ b036b25 ─ 811f7e8 ─ 8bf32ed ─ 9bd1e6b ─ 66858c5
   ├─ 2b138cc ─ aa43e06 ─ aa44d2a ─ 9bf9ac0 ─ 999fab5 ─ 2742738 ─ 6999b64 ─ e796f69 ─ f06289b ─ df73bc0 ─ 8552fe5
   │                                                   │
   │                                                   └─ bf391c5 (T09 APP FREEZE) ─ d522769 (T09 DOCS) ─ 99e4b7b* ─ 09f13c4*
   │                                                                                                                   │
   ├─ M 668920f  "Merge pull request #1 from vb-2f/hoplite/himera-6d3eda84"  (parents 8552fe5, 09f13c4) ◄────────────┘
   │
   │  T10 — observations / reconciliation (branch hoplite/himera-6d3eda84-t10-observation-reconciliation)
   │     6c28858 ─ 18519f0 ─ a3abd6d* ─ ab1e983* ─ 4c414fa ─ bf86efb ─ 7393edc (T10 APP FREEZE) ─ c71692a (T10 DOCS)
   ├─ M 30ce4ea  "Merge T10"  (parents 668920f, c71692a) ◄──────────────────────────────────────────────────┘
   │
   │  T11 — read authority (…-t11-inventory-read-authority)
   │     657201f ─ c7e2296* ─ 4553b8a† ─ e64ee77 ─ c15c9a8 (T11 APP FREEZE) ─ 847b036 (T11 DOCS)
   ├─ M 14c02f8  "Merge T11"  (parents 30ce4ea, 847b036) ◄────────────────────────────────────────┘
   │
   │  T12 — closed loop (…-t12-inventory-closed-loop)
   ├─ 22f675d (first freeze) ─ 24668c2 ─ d156001 (T12 APP FREEZE = RELEASE CANDIDATE)
   │
   └─ 5cb4caa  T12 DOCS HEAD  ← this review starts here (docs-only delta from d156001)
         │
         └─ b794ee8  later docs commit on the T12 branch tip ("certify … NOT READY: 2 P2");
                     not part of the RC, not the base of this review, reproduced independently below
```

`*` = PR-tooling auto-commit of the platform workspace overlay `.hoplite/settings.json`
(SHA-256 `6d8f5b45…`) immediately followed by a corrective commit restoring the
repository blob (`09f13c4`, `ab1e983`).
`†` = `4553b8a` **deletes** `.hoplite/settings.json` from the branch tree instead of
restoring the main blob; the file is absent from every later tree including the
release candidate (see certification defect D1).

## Merge commits between checkpoints

| Merge | Parents | Purpose |
| --- | --- | --- |
| `668920f` (2026-09-11) | `8552fe5`, `09f13c4` | PR #1 — folds the published T09 branch (freeze `bf391c5`, docs `d522769`) into the train |
| `30ce4ea` (2026-09-12) | `668920f`, `c71692a` | T10 (freeze `7393edc`, docs `c71692a`) |
| `14c02f8` (2026-09-12) | `30ce4ea`, `847b036` | T11 (freeze `c15c9a8`, docs `847b036`) |

No merge from `main` occurs anywhere in the train; the merge base of `origin/main`
with both `d156001` and `5cb4caa` is `d1b0673` itself (pure fast-forward geometry).
