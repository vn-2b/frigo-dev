# Inventory Truth release train — ancestry certification (2026-09-12)

Repository: `vb-2f/frigo-dev`, **GitHub repository ID 1364064929** (verified via
`GET /repositories/1364064929` → `vb-2f/frigo-dev`, default branch `main`).
Review HEAD: **`5cb4caa0d5b3c86b00954d77cd40b16027c21df1`** (T12 docs HEAD).
Application release candidate: **`d15600186c3e73faba011eb690ac6cd70e8d3d2d`**.

## Ancestry results (`git merge-base --is-ancestor <sha> 5cb4caa`)

| Checkpoint | SHA | Ancestor of T12 docs HEAD |
| --- | --- | --- |
| main baseline | `d1b06732f8a80db4e77986df31ff28d9f04641fa` | ✅ |
| T08 application (`feat(t08): add guarded idempotent legacy backfill`) | `dd2ecc6f7066250dfdc5214a3d6c356e1479b61e` | ✅ |
| T08 verified checkpoint | `fb00f46d4633c9659e812be9f86119533973a8bd` | ✅ |
| T08 docs | `8f8788c1a0c9e486657751ef3875a5baa5334dec` | ✅ |
| T09 application freeze | `bf391c5fdcdd9e9c2f2257db515815e082cb4381` | ✅ |
| T09 docs HEAD | `d522769ae89496fd4b3f26419f1fdfe23d9e926a` | ✅ |
| T10 application freeze | `7393edcd4fb9cc8bb4df2a06628fb5dc57f8607b` | ✅ |
| T10 docs HEAD | `c71692a5a6bd398c1296f2dd747aa356a39cfedc` | ✅ |
| T11 application freeze | `c15c9a81fc4367b3506a7e2693798ebe1424b0a9` | ✅ |
| T11 docs HEAD | `847b03632d924b136002cb1791e7f75cb15365e1` | ✅ |
| T12 application freeze | `d15600186c3e73faba011eb690ac6cd70e8d3d2d` | ✅ (direct parent of `5cb4caa`) |

No expected ancestor is missing. T08 ancestry was derived from Git
(`git log d1b0673..8f8788c`): 8 linear commits `43718c2 → e6ba715 → cdffb42 →
dd2ecc6 → b5577ea → 4cc290f → fb00f46 → 8f8788c`, matching the historical notes.

## Linear history main → T12 (55 commits, 3 train merges, no rewrites)

```
d1b0673  main baseline (Merge PR #12) ── origin/main is STILL exactly this SHA
   │
   ├─ T08 ── 43718c2 e6ba715 cdffb42 [0023] dd2ecc6 (app) b5577ea 4cc290f fb00f46 8f8788c (docs)
   │
   ├─ T09 ── e56f163 c212ded 5d10bc5 13133b3 [0024] cc3121d b036b25 [0025,0026] 811f7e8 8bf32ed
   │         9bd1e6b [0027] 66858c5 2b138cc aa43e06 aa44d2a 9bf9ac0 [0028] 999fab5 2742738 6999b64
   │         e796f69 f06289b df73bc0 8552fe5 bf391c5 [0029] (app freeze) d522769 (docs)
   │         99e4b7b (PR-tooling overlay auto-commit) 09f13c4 (overlay restored to repo blob)
   │
   ├─ 668920f  Merge PR #1 (T09 → train base hoplite/kydonia-2785bb72)
   │
   ├─ T10 ── 6c28858 [0030] 18519f0 a3abd6d (overlay auto-commit) ab1e983 (restored) aa17aee
   │         4c414fa bf86efb 7393edc (app freeze) c71692a (docs)
   │
   ├─ 30ce4ea  Merge T10 into train base
   │
   ├─ T11 ── 657201f c7e2296 (overlay auto-commit) 4553b8a (overlay REMOVED from tree) e64ee77
   │         c15c9a8 (app freeze) 847b036 (docs)
   │
   ├─ 14c02f8  Merge T11 into train base
   │
   └─ T12 ── 22f675d 24668c2 d156001 (APPLICATION FREEZE / RELEASE CANDIDATE)
                                       │
                                     5cb4caa (T12 DOCS HEAD — review start)
```

`[00NN]` marks the commit that introduced each Inventory Truth migration.

## Main divergence

| Comparison | merge-base | behind main | ahead of main | files | +/− |
| --- | --- | --- | --- | --- | --- |
| `origin/main` … `d156001` (app RC) | `d1b0673` | 0 | 54 | 120 | +24,242 / −185 |
| `origin/main` … `5cb4caa` (docs HEAD) | `d1b0673` | 0 | 55 | — | — |

**`origin/main` has NOT advanced: it is exactly `d1b06732…`.** The release train
is a pure fast-forward candidate; no new main commits exist to audit for
semantic overlap.

## Train merges

`668920f`, `30ce4ea`, `14c02f8` merge each task branch into the internal train
base `hoplite/kydonia-2785bb72`. None touches `main`. Merge parents are exactly
the task docs HEADs (`d522769`+corrections, `c71692a`, `847b036`).
