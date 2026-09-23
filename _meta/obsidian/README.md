# Versioned Obsidian defaults

Portable Obsidian configuration for `alambic`. Local `.obsidian/` stays
gitignored; these defaults rebuild the same vault UI on any machine.

## Install / refresh

```bash
_meta/bootstrap-obsidian.sh        # copy missing files only
_meta/bootstrap-obsidian.sh --force  # overwrite local core defaults
_meta/alambic doctor
```

## Included

| File | Purpose |
| --- | --- |
| `defaults/app.json` | New notes → `docs/inbox/manual`, attachments → `docs/assets`; ignore corpus, staging, and research trees |
| `defaults/core-plugins.json` | Search, Properties, Backlinks, Bases, Templates, etc. |
| `defaults/community-plugins.json` | Empty (no AI plugins by default) |
| `defaults/templates.json` | Folder `_meta/templates` |
| `defaults/bookmarks.json` | Hybrid navigation groups |
| `defaults/graph.json` | Color groups for kb / ref / inbox; same corpus, staging, and research path exclusions |
| `defaults/appearance.json` | Default theme following the OS light/dark mode, base font size |

`workspace.json` stays unversioned: pane layout is machine-local.
After bootstrap, open `ref/home.md` and `ref/knowledge-health.base` once.
