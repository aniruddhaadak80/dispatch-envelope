# ADR 0004 — Storage is flat file, and the web renders engine output

**Status:** accepted · **Date:** 2026-10-05

## Context

The scaffold arrived with SQLite in `packages/memory` and an Electron shell in `apps/desktop`.
Both were deliberate choices for a generic agent product. Neither fits this one.

A dispatch plan is a document a human reads, edits by hand, diffs in a pull request, and pastes
into an issue. SQLite gives none of that without a query interface, and it drags a native build
into `npm install` for a store that will hold tens of rows.

Separately, `apps/web` cannot spawn Python on Vercel. The scaffold's answer was that the web app
is self-contained. For a solver, that answer has a trap: the tempting fix is to reimplement the
solver in TypeScript, which creates a second implementation free to disagree with the real one
forever, and nobody notices until a plan is wrong.

## Decision

1. **Storage is one JSON document per plan**, written to a temp file in the same directory and
   then renamed. The rename is atomic on POSIX and Windows, so a reader never sees a half-written
   plan and a crash leaves the previous one intact. Plan ids are validated rather than escaped:
   `../escape` sanitises to something surprising, and rejecting is safer.

2. **The web app renders output the real engine generated.** `scripts/gen-fixtures.mjs` calls the
   solver and writes `apps/web/fixtures/*.json`. `npm run check:fixtures` regenerates and
   compares, failing the build on drift.

3. **Desktop and channels are omitted**, not stubbed.

## Consequences

- `npm install` compiles nothing native, and a corrupt store is visible to `cat`.
- The deployed page shows real solver output, with exactly one implementation of the solver.
- A change to solver behaviour **must** be accompanied by `npm run gen:fixtures`, or the build
  fails. That is the gate doing its job, not an obstacle.
- No desktop installer and no notification adapters. Both were recorded in `AGENTS.md` as
  decisions so a later contributor sees a choice rather than an oversight.

## Alternatives rejected

- **Keep SQLite.** Rejected: a native dependency and an opaque file format for a store whose
  contents are meant to be read and diffed by humans.
- **Reimplement the solver in TypeScript for the web app.** Rejected: two implementations, one
  truth, and no way to tell which one a screenshot came from.
- **Have the web app call a hosted engine service.** Rejected: it makes a static deploy depend on
  a running process, and this product has no reason to be a service.
- **Ship the Electron shell anyway.** Rejected: a surface that cannot be verified in CI is a
  surface whose "working" claim is unfalsifiable.
