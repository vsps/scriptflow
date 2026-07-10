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
# frame-1
## Welcome to the forest
The path splits in two.

## Choice prompt
Go left or go right.

# frame-2
## Left path
You hear water nearby.
```

Rules:

- Frame header must start with `# `.
- Frame header value becomes the frame identifier.
- Inside a frame, each `## ` starts a new heading/body pair.
- An optional `### ` line right after `## ` sets that entry's subheading.
- Body is all lines until the next `### `, `## `, or next `# `.
- The plugin writes each pair to child layers named `Heading N`, `Subheading N` (if provided), and `Body N` inside that frame.

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
