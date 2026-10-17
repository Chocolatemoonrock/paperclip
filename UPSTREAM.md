# Upstream baseline

This repository is a thin fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip).

## Current tested baseline

| Field | Value |
|---|---|
| Upstream repository | `paperclipai/paperclip` |
| Release tag | `v2026.1012.0` |
| Upstream commit | `bba6a45f0d364cfd962ac59b3bdf2426a8222adb` |
| Release date | 2026-10-12 |
| Plugin API | `1` |
| Plugin SDK package version | `1.0.0` |
| Exact mirror branch | `upstream-sync/v2026.1012.0` |

The `upstream-sync/v2026.1012.0` branch points directly at the unmodified upstream commit. The `main` branch starts from that commit and carries only the fork-administration documents until an explicitly recorded patch is approved.

## Update policy

1. Review a stable upstream release and its migration notes.
2. Create `upstream-sync/<tag>` at the exact upstream release commit.
3. Test database migration, plugin compatibility, import/export, restart/restore, and rollback.
4. Update this file and `PATCHES.md` in a reviewed pull request.
5. Move `main` only after the release is approved.
6. Build and deploy only from a tagged commit in this fork.

Running instances must never auto-update from upstream. The external research-operations plugin must remain pinned to the same host baseline.
