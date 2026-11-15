# Core regression checks

Install with `npm ci` and `npx playwright install chromium webkit`, then run:

```sh
npm test
BROWSER_ENGINE=webkit npm test
```

CI runs Chromium on Linux and WebKit on macOS, with two test files at a time.
`BROWSER_EXECUTABLE` optionally selects a compatible local executable.

The automated suite has a deliberately narrow scope:

- Load, autosave, reload, recovery, and preserving the previous workspace when a save fails.
- Import/export of sketches, workspaces, libraries, images, and portable HTML.
- Selecting the intended object, editing groups, rotation, and entering text or table-cell editing.
- Undo and redo where these operations could lose or change the wrong work.

It does not exhaustively test components, spreadsheets, events, network integrations, catalog
permutations, or styling. Test those features manually when changing them. Add automated coverage
only for a distinct recurring failure within the core scope, usually by extending an existing case.
Older test counts and file lists in the design brief are historical, not a checklist to restore.

Tests use isolated profiles and inject diagnostic access only into test copies of `index.html`.
Wait for durable saves and observable completion; start each mutating action once. Avoid debug
screenshots with fixed filesystem paths, timing benchmarks, and assertions on helper internals.

See [coverage](COVERAGE.md) for the six retained files. Physical iPad input, native Office paste,
and printer scaling remain manual checks. Opening Paperwire itself needs no installation or build.
