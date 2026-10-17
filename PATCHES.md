# Fork patches

Every deviation from upstream Paperclip core must be recorded here before it is merged.

## Active core deviations

None.

The fork currently contains no runtime, UI, schema, approval, checkout, transition, runner, or branding changes relative to upstream `v2026.1012.0`. `UPSTREAM.md` and this file are fork-administration records, not application patches.

## Candidate patch: issue-transition policy hook

Status: **not implemented**

A future generic seam may be proposed if the external research-operations plugin proves unable to enforce a required invariant:

```text
beforeIssueTransition(context) -> allow | deny(reason)
```

Any implementation must be domain-neutral and upstreamable. Garmin- or New Edge-specific policy must remain in the external plugin.

Potential consumers include:

- producer and reviewer independence;
- required review completion;
- L3/L4 human approval;
- frozen test-card hashes;
- evidence manifests before completion;
- restoration records when required.

Removal condition: remove the patch when upstream provides an equivalent supported pre-transition policy hook, then migrate the plugin and prove behavior with the acceptance suite.

## Required entry format

Add one section per patch with:

- patch identifier and commit or pull request;
- affected files;
- reason the plugin SDK cannot supply the behavior;
- user-visible and migration impact;
- tests and rollback procedure;
- upstream issue or pull request;
- explicit removal condition.
