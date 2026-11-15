# Testing Paperwire

Install development dependencies with `npm ci`, then install browsers with
`npx playwright install chromium webkit`.

```sh
npm test
BROWSER_ENGINE=webkit npm test
```

CI runs these commands with two files at a time. To check a specific change:

```sh
node --test tests/workspace-storage.test.cjs
node --test --test-name-pattern='clipboard' tests/regressions.test.cjs
```

`BROWSER_EXECUTABLE` optionally selects a compatible local browser executable.
Tests use isolated profiles and inject their diagnostic evaluator only into test copies of
`index.html`. Opening the app itself needs no installation or build.

## What earns a test

Keep checks for losing work, incompatible files, unsafe scripts, broken core editing, incorrect
connected results, and unintended network actions. Prefer a user journey with independently
checked output. Add a regression when it covers a distinct failure that existing tests would miss.
Avoid one test for every helper, catalog setting, cosmetic variant, or delivery milestone. The
same result rarely needs separate helper, editor, reader, and demo suites. A new test should
usually replace or extend the closest existing scenario.

The suite was pruned from 1,787 cases in 175 files to 479 cases in 33 files in November 2026. Old validation counts and file lists
in the design brief describe historical runs; they are not a checklist to restore.
See [retained coverage](COVERAGE.md) for the current scope.

## Browser checks

Wait for graph settlement and completed paints, and await `persistWorkspace()` before reloads.
Use deterministic delayed replies for race tests. Start each mutating action once and check its
observable result; avoid returning long-lived application promises through `page.evaluate`.
Keep clipboard interception inside the browser profile, away from the OS clipboard.

Physical iPad input, native Office paste, and printer scaling still need occasional manual checks.

## Generated examples

When changing component sources or the exported runtime, refresh the affected fixtures:

```sh
node tools/update-builtin-catalog.cjs
node tools/update-builtin-catalog.cjs --check
node tools/update-example-workspace.cjs
node tools/update-workspace-runtime-example.cjs
node tools/update-http-integrations-example.cjs
node tools/update-mqtt-integrations-example.cjs
```

The retained catalog, generator, public-demo, and export checks protect source synchronization
and portable output. Optional `tests/*performance.cjs` scripts are manual benchmarks, outside CI.
