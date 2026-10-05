<div align="center">

# Dispatch Envelope

**Prove whether a building's flexible loads fit inside a capped supply — and prove exactly why not.**

[CI](https://github.com/aniruddhaadak80/dispatch-envelope/actions/workflows/ci.yml) ·
[License](https://github.com/aniruddhaadak80/dispatch-envelope/blob/main/LICENSE) ·
[Issues](https://github.com/aniruddhaadak80/dispatch-envelope/issues)

</div>

---

## The problem

You have an EV charger, an immersion heater and a washer on a supply capped at 7 kW. Two of
them want to run at once. You want to know the cheapest legal arrangement — and when there is
none, you want to know **which two appliances are responsible**, not a guess.

A chatbot will tell you there "might be a conflict". This tells you the minimal conflicting set,
the slot, and the arithmetic:

```console
$ dispatch-envelope prove examples/overnight-conflict.json
INFEASIBLE — mandatory demand in slot 0 is 13 kW against a 10 kW limit — a deficit of 3 kW

  reason:     MANDATORY_DEMAND_EXCEEDS_LIMIT
  minimal:    yes
  slot:       0  required 13 kW > limit 10 kW  (deficit 3 kW)

  minimal conflicting set:
    heat-pump     7 kW  window 0..0  min 1
    water-tanks   6 kW  window 0..0  min 1

  optional loads excluded from the proof: 2 kW
```

The optional 2 kW load is **absent from the core**, because it is not in conflict. A proof that
listed every load would be useless. `minimal: yes` is a claim the engine verifies: removing any
one listed load restores feasibility.

## Quick start

```bash
git clone https://github.com/aniruddhaadak80/dispatch-envelope.git
cd dispatch-envelope
npm install
npm run build
node packages/cli/dist/bin.js doctor
```

`doctor` probes the runtime, the skill catalog and the plugin registry, and prints a fix hint
for anything that fails:

```console
$ node packages/cli/dist/bin.js doctor
dispatch-envelope doctor
  [PASS] node     v22.23.2
  [PASS] package  dispatch-envelope@0.1.0
  [PASS] skills   4 skills, 0 invalid
  [PASS] plugins  2 active, 0 disabled
  [WARN] config   no product.config.json — using defaults
         fix: run with defaults, or create product.config.json

all required checks passed
```

The binary is `dispatch-envelope` once installed globally; the commands below use the repo-local
path so they work from a fresh clone.

## Walkthrough

### 1. Solve a site

```bash
node packages/cli/dist/bin.js solve examples/overnight-tariff.json
```

```console
plan: feasible, objective cost, 1 search nodes
cost: 235c  peak: 6 kW in slot 5

  load        kW  slots
  EV charge    3  5..8
  Immersion heater  3  4..5 (optional)
  Washer dryer 2  6..7 (optional)

  slot  price  kW   headroom
     0     28   0  .......
     1     26   0  .......
     2     24   0  .......
     3     30   0  .......
     4     18   3  ###....
     5      9   3  ###....
     6      8   5  #####..
     7      9   5  #####..
     8     14   3  ###....
     9     22   3  ###....
    10     31   0  .......
    11     33   0  .......
```

Loads land in the cheapest slots, and the bar is drawn against the cap so an oversubscribed plan
is visible without arithmetic. Add `--json` for machine output, or `--save <id>` to write the
plan to the flat-file store.

### 2. Prove why not

```bash
node packages/cli/dist/bin.js prove examples/overnight-conflict.json
```

See the top of this file. Two `reason` codes matter:

| Code                             | Meaning                               | The fix                     |
| -------------------------------- | ------------------------------------- | --------------------------- |
| `MANDATORY_DEMAND_EXCEEDS_LIMIT` | a supply problem                      | more capacity, or defer     |
| `NO_FEASIBLE_PLACEMENT`          | a **window** problem — the total fits | widen a window, not the cap |

### 3. Run the engine directly

It is a pure function over stdin/stdout — no server, no port, no daemon:

```console
$ echo '{"op":"describe","input":null}' | python -m dispatch_envelope
```

Set `PYTHONPATH=services/engine/src` if the module is not importable. Same input, same output,
every time: no clock, no network, no randomness, no filesystem.

### 4. Ask it over MCP

Dispatch Envelope is a tool provider for other agents:

```json
{
  "mcpServers": {
    "dispatch-envelope": {
      "command": "node",
      "args": ["packages/cli/dist/bin.js", "mcp", "serve"]
    }
  }
}
```

```bash
node scripts/e2e-mcp.mjs
```

That script launches the real server as a child process, speaks the real protocol to it, and
asserts on values only a working solver can produce — a per-slot envelope, a verified schedule,
and a minimal unsat core. A stubbed server would prove nothing.

### 5. Look at the envelope

```bash
npm run build
npx next start --port 3000 --cwd apps/web
```

The signature element is the **envelope band**: one column per slot, where the ceiling is the
most that slot could carry, the floor is what is already committed to it, and the amber overlay
is what the dispatched plan draws. A column whose amber reaches the ceiling is a tripped supply,
and you see it before reading a number.

The page is server-rendered from fixtures that **the real Python engine generated** — see
"one engine, not two" below.

### 6. Run the whole gate

```bash
npm run check
```

This is the exact command CI runs, in the same order: format, lint, typecheck, six policy gates,
fixture drift, the TypeScript tests, the Python tests, the build, and the MCP end-to-end proof.

## One engine, not two

The web app cannot spawn Python on Vercel, and reimplementing the solver in TypeScript would
create a second code path — the thing this architecture exists to prevent.

So `apps/web/fixtures/*.json` is **generated by the real engine** by `npm run gen:fixtures`, and
`npm run check:fixtures` fails the build if those files ever drift from what the solver currently
computes. The deployed page shows real solver output, there is exactly one implementation, and
drift is a red build.

## How it works

```
                 ┌──────────────┐
  CLI ──────────▶│              │
  Web ──────────▶│  ToolRegistry│──▶ packages/memory  (flat-file plan store)
  MCP server ───▶│              │
                 └──────────────┘
                        │
                        └──▶ services/engine  (pure Python, stdin/stdout)
```

The invariants:

1. Tools are **stateless**. State lives in `packages/memory`.
2. Input is validated **before** the handler runs, never after.
3. Permissions are **declared**, and a call exceeding the granted set is refused.
4. A duplicate tool name **throws**, naming both registrants.
5. No cross-package deep imports. `check:boundaries` enforces it.
6. The engine is **pure**. No clock, no network, no randomness, no filesystem.

### The footprint ladder

Where new capability goes, in order of preference:

1. Extend an existing tool
2. Add a CLI command plus a skill
3. Add a service-gated tool
4. Add a plugin
5. Add an MCP server tool
6. Add a new core tool — **last resort**

Every core tool is paid for in context window on every request, forever. Plugins are free. That
asymmetry is the whole reason for the ladder.

## What ships

| Surface              | Status  | What it is                                                          |
| -------------------- | ------- | ------------------------------------------------------------------- |
| CLI                  | shipped | `solve`, `prove`, `tools`, `doctor`, `mcp serve`, `mcp call`        |
| Web (Vercel)         | shipped | server-rendered Next.js, renders the engine's own output            |
| MCP server           | shipped | six tools over stdio, verified by a real client                     |
| MCP client           | shipped | used by `scripts/e2e-mcp.mjs` to prove the server really speaks MCP |
| Skills catalog       | shipped | four skills, `SKILL.md` discovery, validation, version gating       |
| Plugin registry      | shipped | tariff suppliers; manifest is data, so loading cannot execute code  |
| Memory               | shipped | flat-file plan store, atomic writes                                 |
| Deterministic engine | shipped | `propagate_envelope`, `prove_infeasible`, `dispatch`                |
| Docs and ADRs        | shipped | `docs/`, including the reasoning behind each decision               |
| Evals                | shipped | the end-to-end MCP script and the fixture drift gate                |

### Deliberate omissions

**No desktop shell.** An Electron wrapper around a dashboard adds a packaging surface and no
capability. It also cannot be verified headlessly, so claiming it "works" would be a claim
nothing in this repo could check.

**No channels.** A Slack or webhook adapter that reports a plan nobody asked for is scope
theatre. Load dispatch is a decision a human makes deliberately, not a notification.

Both omissions were taken from the scaffold, and `apps/web/lib/product.ts` lists only surfaces
that exist — a listed surface must work.

**No plugin-only privileged path.** A plugin registers through the same registry every other
surface uses. There is no way to bypass permission checks or validation.

## Units

Power is whole kW. Time is whole slots. Money is whole cents per kWh. There is no float anywhere
in the domain, so nothing is ever "approximately over the limit" — and a fractional value is
**rejected** (`NON_INTEGER`) rather than truncated, because silently dropping half a kilowatt is
exactly the bug this product exists to prevent.

## Configuration

Layered, later wins: **defaults → `product.config.json` → environment**.

| Key                | Default       | Meaning                         |
| ------------------ | ------------- | ------------------------------- |
| `productEnv`       | `development` | runtime mode                    |
| `dataDir`          | `.data`       | where plans are written         |
| `engine.python`    | `python`      | interpreter for the engine      |
| `engine.timeoutMs` | `10000`       | hard ceiling on one engine call |
| `logLevel`         | `info`        | log verbosity                   |

An invalid value raises a `ValidationError` naming the field — it is never coerced. See
[docs/configuration.md](docs/configuration.md).

## Documentation

| Page                                       | Read it when                              |
| ------------------------------------------ | ----------------------------------------- |
| [getting-started](docs/getting-started.md) | you have just cloned this                 |
| [architecture](docs/architecture.md)       | you need the map before changing anything |
| [cli](docs/cli.md)                         | you are scripting the CLI                 |
| [mcp](docs/mcp.md)                         | you are connecting an agent               |
| [skills](docs/skills.md)                   | you are writing or editing a skill        |
| [plugins](docs/plugins.md)                 | you are adding an extension               |
| [ci](docs/ci.md)                           | you are adding a gate                     |
| [troubleshooting](docs/troubleshooting.md) | something is broken                       |
| [adr/](docs/adr/)                          | you want the reasoning behind a decision  |

## Development

```bash
npm install
npm run build          # turbo build across every package
npm run typecheck      # tsc --noEmit across every package
npm run lint           # eslint
npm run format         # prettier --write
npm test               # vitest, every package
npm run pytest         # the Python engine
npm run check          # everything CI runs
npm run gen:fixtures   # regenerate the web fixtures from the engine
npm run e2e            # the MCP end-to-end proof
```

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). The rules that are not negotiable are in
[AGENTS.md](AGENTS.md), and the reasoning behind each is in [docs/adr/](docs/adr/).

## License

MIT — see [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
