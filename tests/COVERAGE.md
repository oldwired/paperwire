# Retained regression coverage

See [Testing Paperwire](README.md) for commands and the policy for adding tests.

| Area | Retained coverage |
| --- | --- |
| Editing and portable output | `regressions`, `text-edit-overlap`, `editor-history`: representative drawing, groups, text, clipboard, printing, deployment settings, demo loading, and offline export |
| Durable work and transfers | `workspace-storage`, `workspace-persistence-contracts`, `import-integrity`, `image-budget-transfer`, `resource-limits`, `script-pooling`: recovery, atomic replacement, identity remapping, limits, and imports that finish after navigation |
| Libraries and sandbox | `library-persistence`, `library-transfer`, `sandbox-lifecycle`, `export-dependencies`, `builtin-catalog-source`: durable personal libraries, file compatibility, script isolation, and synchronized bundled sources |
| Connected programs | `components`, `component-wiring-runtime`, `component-events`, `component-hybrid-events`, `runtime-stability`, `run-preview`, `workspace-runtime`: wiring, typed values, event propagation, execution recovery, isolated preview, and multiple pages |
| Tables and spreadsheets | `data-components`, `data-import-contracts`, `data-transform-contracts`, `shared-dataset-editing`, `spreadsheet-contracts`, `spreadsheet-datasets`: import parsing, stable transforms, shared edits, formulas, and offline table workflows |
| Network integrations | `integration-foundation`, `http-integration-runtime`, `mqtt-runtime-browser`, `mqtt-publish-browser`: destination validation, transient readings, credentials, reconnects, and explicit sends without replay |
| Public examples | `example-workspace-generator`, `workspace-runtime-example-contracts`, plus the public-demo journey in `regressions`: valid artifacts, atomic generation, and the shipped Pages library |

Names above refer to `*.test.cjs` files in this directory. Feature-specific helper contracts,
repeated catalog permutations, detailed cosmetic checks, and milestone closeout suites were
removed. These are deliberate gaps: the retained suite favors representative behavior and
consequential failures over exhaustive permutations of every control.
