# Core coverage

| File | Purpose |
| --- | --- |
| `regressions.test.cjs` | Portable exports, clipboard images and objects, failed saves, legacy files, selection, groups, rotation, text editing, and the public demo |
| `workspace-storage.test.cjs` | Durable saves and reloads, large drawings, concurrent edits, corrupt-data recovery, and local HTML files |
| `import-integrity.test.cjs` | Imports stay with the intended sketch, remain undoable, and reject invalid geometry without losing work |
| `library-transfer.test.cjs` | Library/shape export and import preserve content and produce independent placed copies |
| `script-pooling.test.cjs` | Saved scripts round-trip compactly; malformed references fail before replacing work |
| `text-edit-overlap.test.cjs` | Mouse and touch enter the correct text or table editor through overlapping objects and groups |

[Testing guide](README.md) documents the deliberately narrow scope and commands. Specialized
feature behavior and cosmetic permutations are outside this gate.
