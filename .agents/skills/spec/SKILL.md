---
name: spec
description: Load before multi-file work, meaning any change whose diff cannot be described in one sentence. Writes a short spec (acceptance criteria, files, out of scope, end-to-end verification) that the build follows and the reviewer checks the diff against, citing its lines.
---

# Spec

Load before multi-file work — any change whose diff cannot be described in one sentence.

## Process

1. **Problem Statement:** Define the user or architectural problem concisely.
2. **Acceptance Criteria:** State falsifiable conditions of satisfaction.
3. **Touched Files:** Identify which files are modified or created.
4. **Out of Scope:** Explicitly state what will NOT be touched to avoid scope creep.
5. **End-to-End Verification:** Define exact gate checks, unit tests, and runtime proofs.
