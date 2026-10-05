# Getting started

## Requirements

- Node 22.12 or newer (`.nvmrc` pins the tested version)
- Python 3.11 or newer (only for the deterministic engine)

## Install

```bash
git clone https://github.com/aniruddhaadak80/dispatch-envelope.git
cd dispatch-envelope
npm install
```

## Verify the install

```bash
dispatch-envelope doctor
```

`doctor` probes the runtime, the skill catalog, the plugin registry, and the config, and
prints a fix hint for anything that fails. It is the fastest way to confirm a working
install.

## First run

```bash
node packages/cli/dist/bin.js tools --json                    # what this build can do
node packages/cli/dist/bin.js solve examples/overnight-tariff.json
node packages/cli/dist/bin.js prove examples/overnight-conflict.json
```

`solve` and `prove` exit `1` when the instance is infeasible. That is the answer, not a crash.

## Run the web app

```bash
npm run build
cd apps/web && npm run start
```

Then open <http://localhost:3000> and check <http://localhost:3000/api/health>.

## Run the tests

```bash
npm test            # TypeScript, every package
npm run pytest      # the Python engine
```
