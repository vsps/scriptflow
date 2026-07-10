# Script Flow (Figma Plugin)

Transforms markdown-like text into frame-scoped heading/body text layers.

Supported editors: Figma Design and Figma Slides.

## What it does

- Parses input blocks (`# frame-id`) from the plugin UI.
- Traverses all frames on the current page.
- Matches frames by stable identifier.
- Creates missing frames.
- Finds or creates child text layers per frame and writes heading/body content.
- Supports repeatable "Refresh" runs (parse -> diff/remap -> update).

## Input format

Use one section per activity:

```md
# Frame 1
## Welcome to the forest

The path splits in two.
---
Left.
This path is right.
---
Right.
this path is wrong.

# Frame 2
## Left path

You hear water nearby.

# Frame 3
## Right path

You hear water nearby but it's not as good.

### you chose poorly

you go back to the start.
```

Rules:

- Frame header must start with `# ` (not `## `).
- Frame header value is normalized into the frame identifier: lowercased, whitespace collapsed to `-`, and any character outside `a-z0-9-_` stripped. `# Frame One!` becomes `frame-one`.
- Inside a frame, each `## ` starts a new heading/body entry.
- An optional `### ` line right after `## ` sets that entry's subheading.
- An entry's body is every line after it until the next `### `, `## `, or `# `.
- A line containing only `---` splits the current entry's body into separate body blocks, each written to its own `Body N` layer. Blank blocks (nothing between two `---` lines, or a body that is only whitespace) are dropped rather than creating an empty layer.

### Frame matching

Each existing top-level frame on the page is assigned an identifier, checked in this order:

1. If the frame's name starts with `[SCRIPT_FLOW] `, the rest of the name (normalized the same way as a frame header) is the id.
2. Otherwise, the frame's full name, normalized.
3. Otherwise, an id stored on the frame from a previous refresh (invisible plugin data) — used only as a last resort, since a cloned frame carries a stale copy of it.

A frame block from the input is matched to the first page frame whose id equals its identifier. If two frames resolve to the same id, the first one encountered (page order) wins and the rest are ignored. Frames with no match are either created (if "Create missing top-level frames" is checked) or skipped.

### Text layer matching

For each entry, the plugin looks for a child text layer named (case-insensitively) `heading`/`heading 1`/`Heading`/`Heading 1` for the first heading, `heading 2`/`Heading 2` for the second, and so on (same pattern for `subheading` and `body`). A frame's own direct text children are always preferred over text nested inside child containers; if several children share a candidate name, the first one found wins and the match order between siblings is otherwise unspecified. Missing layers are created only if "Create missing content containers" is checked — except a frame the plugin just created always gets its content, regardless of that checkbox.

### Body numbering across `---`

Body block numbering is continuous across the whole frame, not per heading. If entry 1's body contains one `---` (two blocks) and entry 2's body has none, the layers are `Body 1`/`Body 2` for entry 1 and `Body 3` for entry 2 — not `Body 1`/`Body 1` restarted per entry. If an existing frame isn't allowed to grow content and the input has more body blocks than existing `Body N` layers, the extra blocks are discarded (reported in the refresh summary).

## Development

1. Install dependencies:

```bash
npm install
```

2. Build:

```bash
npm run build
```

3. Watch mode (optional):

```bash
npm run watch
```
