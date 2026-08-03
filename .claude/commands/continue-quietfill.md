---
description: Resume QuietFill from the tested FCC and settlement-contract milestone
---

Resume the QuietFill Flare Summer Signal build using `CLAUDE.md` as the authoritative handoff.

First inspect `git status`, the latest commits, and all current diffs. Run `forge test`, then run the TypeScript type-check, tests, and build. Do not discard existing work or rewrite the contract architecture unless a failing test or official Flare interface proves it necessary.

Continue with the first incomplete item under "Resume Work in This Order" in `CLAUDE.md`. Keep the product non-gambling and production-oriented: Coston2 deployment, hosted FCC proxy, and a public frontend are required. Never substitute mock settlement, a frontend-selected winner, an unsigned proxy response, or a localhost-only submission.

If Go bindings are still missing, generate them on this machine only after checking available disk space. Prefer a direct Go 1.25.1+ installation over pulling a large Docker image. After each logical milestone, run relevant tests, inspect the diff for secrets, commit with a focused message, and push `main` to `origin`.
