type TextKind = 'heading' | 'subheading' | 'body';

type EntrySpec = {
  heading: string;
  subheading: string;
  body: string;
};

type FrameSpec = {
  id: string;
  entries: EntrySpec[];
};

const PLUGIN_DATA_KEY = 'scriptFlowActivityId';
const FRAME_PREFIX = '[SCRIPT_FLOW]';
const FRAME_WIDTH = 420;
const FRAME_PADDING = 24;
const BODY_FONT: FontName = { family: 'Inter', style: 'Regular' };
const HEADING_FONT: FontName = { family: 'Inter', style: 'Bold' };

const runtimeEditorType = (figma as PluginAPI & { editorType?: string }).editorType;
if (runtimeEditorType && runtimeEditorType !== 'figma' && runtimeEditorType !== 'slides') {
  figma.notify('This plugin supports Figma Design and Figma Slides.');
  figma.closePlugin();
}

figma.showUI(__html__, {
  width: 460,
  height: 580,
  themeColors: true,
});

figma.ui.onmessage = async (message: {
  type?: string;
  input?: string;
  createMissingFrames?: boolean;
  createMissingContent?: boolean;
  width?: number;
  height?: number;
}) => {
  if (message.type === 'refresh') {
    await runRefresh(message.input ?? '', message.createMissingFrames ?? false, message.createMissingContent ?? false);
    return;
  }

  if (message.type === 'resize-ui') {
    const width = Math.max(360, Math.min(1000, Math.round(message.width ?? 460)));
    const height = Math.max(320, Math.min(1200, Math.round(message.height ?? 580)));
    figma.ui.resize(width, height);
    return;
  }

  if (message.type === 'close') {
    figma.closePlugin();
  }
};

async function runRefresh(rawInput: string, createMissingFrames: boolean, createMissingContent: boolean): Promise<void> {
  const frames = parseFrames(rawInput);

  if (frames.length === 0) {
    figma.notify('No frame blocks found. Use "# frame-id" sections.');
    figma.ui.postMessage({
      type: 'refresh-result',
      ok: false,
      message: 'No frame blocks found. Add at least one "# frame-id" block.',
    });
    return;
  }

  let summary;
  try {
    summary = await upsertFrames(frames, createMissingFrames, createMissingContent);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    figma.notify(`Refresh failed: ${errorMessage}`);
    figma.ui.postMessage({
      type: 'refresh-result',
      ok: false,
      message: `Refresh failed: ${errorMessage}`,
    });
    return;
  }

  let message =
    `Refreshed ${summary.updatedFrames} existing frame(s), created ` +
    `${summary.createdFrames} new frame(s), and wrote ${summary.updatedLayers} text layer(s) ` +
    `for ${summary.updatedEntries} heading/body pair(s).`;

  if (summary.discardedBodyOverflow > 0) {
    message += ` Discarded ${summary.discardedBodyOverflow} overflow body block(s).`;
  }

  if (summary.skippedMissingFrames > 0) {
    message += ` Skipped ${summary.skippedMissingFrames} missing frame(s).`;
  }

  if (summary.debugLines.length > 0) {
    message += `\n\nDebug matches:\n${summary.debugLines.join('\n')}`;
  }

  figma.notify(message);
  figma.ui.postMessage({
    type: 'refresh-result',
    ok: true,
    message,
    debugLines: summary.debugLines,
  });

  if (summary.focusNodes.length > 0) {
    figma.currentPage.selection = summary.focusNodes;
    figma.viewport.scrollAndZoomIntoView(summary.focusNodes);
  }
}

function parseFrames(rawInput: string): FrameSpec[] {
  const lines = rawInput.replace(/\r/g, '').split('\n');
  const frames: FrameSpec[] = [];
  let currentFrame: FrameSpec | null = null;
  let currentHeading = '';
  let currentSubheading = '';
  let currentBodyLines: string[] = [];

  const pushEntry = (): void => {
    if (!currentFrame || !currentHeading.trim()) {
      currentHeading = '';
      currentSubheading = '';
      currentBodyLines = [];
      return;
    }

    currentFrame.entries.push({
      heading: currentHeading.trim(),
      subheading: currentSubheading.trim(),
      body: currentBodyLines.join('\n').trim(),
    });
    currentHeading = '';
    currentSubheading = '';
    currentBodyLines = [];
  };

  const pushFrame = (): void => {
    if (currentFrame && currentFrame.id && currentFrame.entries.length > 0) {
      frames.push(currentFrame);
    }
  };

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const compact = trimmed.trim();

    if (compact.startsWith('# ') && !compact.startsWith('## ')) {
      pushEntry();
      pushFrame();
      currentFrame = {
        id: normalizeIdentifier(compact.slice(2)),
        entries: [],
      };
      continue;
    }

    if (!currentFrame) {
      continue;
    }

    if (compact.startsWith('## ')) {
      pushEntry();
      currentHeading = compact.slice(3).trim();
      currentSubheading = '';
      currentBodyLines = [];
      continue;
    }

    if (compact.startsWith('### ')) {
      currentSubheading = compact.slice(4).trim();
      // Splits the body here too, same as a literal "---" line, so text
      // before and after the subheading land in separate body blocks.
      currentBodyLines.push('---');
      continue;
    }

    if (!currentHeading) {
      continue;
    }

    currentBodyLines.push(trimmed);
  }

  pushEntry();
  pushFrame();
  return frames;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

async function upsertFrames(
  frames: FrameSpec[],
  createMissingFrames: boolean,
  createMissingContent: boolean,
): Promise<{
  createdFrames: number;
  updatedFrames: number;
  updatedLayers: number;
  updatedEntries: number;
  discardedBodyOverflow: number;
  skippedMissingFrames: number;
  debugLines: string[];
  focusNodes: SceneNode[];
}> {
  const topLevelFrames = getTopLevelFrames();
  const frameTemplate = pickFrameTemplate(topLevelFrames);
  const frameById = new Map<string, FrameNode>();

  for (const frame of topLevelFrames) {
    const pluginId = frame.getPluginData(PLUGIN_DATA_KEY);
    const idFromName = parseIdFromFrameName(frame.name);
    const normalizedName = normalizeIdentifier(frame.name);
    // Name wins over pluginData: clone() copies plugin data, so duplicated
    // frames inherit a stale id that would otherwise shadow their real name.
    const key = idFromName || normalizedName || pluginId;
    if (key && !frameById.has(key)) {
      frameById.set(key, frame);
    }
  }

  let createdFrames = 0;
  let updatedFrames = 0;
  let updatedLayers = 0;
  let updatedEntries = 0;
  let discardedBodyOverflow = 0;
  let skippedMissingFrames = 0;
  const debugLines: string[] = [];
  const focusNodes: SceneNode[] = [];

  for (const frameSpec of frames) {
    let frame = frameById.get(frameSpec.id) ?? null;
    const frameExisted = Boolean(frame);
    if (!frame) {
      if (!createMissingFrames) {
        skippedMissingFrames += 1;
        debugLines.push(`${frameSpec.id} -> skipped (missing)`);
        continue;
      }
      frame = createFrameForScript(frameSpec.id, topLevelFrames.length + createdFrames, frameTemplate, topLevelFrames);
      frameById.set(frameSpec.id, frame);
      topLevelFrames.push(frame);
      createdFrames += 1;
      debugLines.push(`${frameSpec.id} -> created ${frame.name}`);
    } else {
      updatedFrames += 1;
      debugLines.push(`${frameSpec.id} -> matched ${frame.name}`);
    }

    frame.setPluginData(PLUGIN_DATA_KEY, frameSpec.id);

    // A frame the plugin just created has no content yet, so its children
    // always need creating regardless of the checkbox; only an already
    // existing frame's missing content is gated by createMissingContent.
    const allowCreateContent = createMissingContent || !frameExisted;

    const headingTexts = frameSpec.entries.map((entry) => entry.heading);
    const subheadingTexts = frameSpec.entries.map((entry) => entry.subheading);
    const bodyBlocks = frameSpec.entries.flatMap((entry) => splitBodyIntoBlocks(entry.body));
    const existingBodyNodes = getOrderedTextChildrenByKind(frame, 'body');
    const maxExistingBodySlots = existingBodyNodes.length;
    const maxWritableBodies = allowCreateContent
      ? bodyBlocks.length
      : Math.min(maxExistingBodySlots, bodyBlocks.length);
    if (!allowCreateContent && bodyBlocks.length > maxExistingBodySlots) {
      discardedBodyOverflow += bodyBlocks.length - maxExistingBodySlots;
    }

    for (let i = 0; i < headingTexts.length; i += 1) {
      const position = i + 1;
      const headingNode = allowCreateContent
        ? await findOrCreateTextChild(
            frame,
            getCandidateChildNames('heading', position),
            defaultChildName('heading', position),
            HEADING_FONT,
          )
        : findTextChildByCandidateNames(frame, getCandidateChildNames('heading', position));
      if (!headingNode) {
        continue;
      }
      await writeText(headingNode, headingTexts[i], HEADING_FONT);
      updatedLayers += 1;
      updatedEntries += 1;
    }

    for (let i = 0; i < subheadingTexts.length; i += 1) {
      if (!subheadingTexts[i]) {
        continue;
      }
      const position = i + 1;
      const subheadingNode = allowCreateContent
        ? await findOrCreateTextChild(
            frame,
            getCandidateChildNames('subheading', position),
            defaultChildName('subheading', position),
            HEADING_FONT,
          )
        : findTextChildByCandidateNames(frame, getCandidateChildNames('subheading', position));
      if (!subheadingNode) {
        continue;
      }
      await writeText(subheadingNode, subheadingTexts[i], HEADING_FONT);
      updatedLayers += 1;
    }

    for (let i = 0; i < maxWritableBodies; i += 1) {
      const position = i + 1;
      let bodyNode = existingBodyNodes[i] ?? null;
      if (!bodyNode) {
        bodyNode = await findOrCreateTextChild(
          frame,
          getCandidateChildNames('body', position),
          defaultChildName('body', position),
          BODY_FONT,
        );
        existingBodyNodes.push(bodyNode);
      }

      await writeText(bodyNode, bodyBlocks[i], BODY_FONT);

      updatedLayers += 1;
    }

    focusNodes.push(frame);
  }

  return {
    createdFrames,
    updatedFrames,
    updatedLayers,
    updatedEntries,
    discardedBodyOverflow,
    skippedMissingFrames,
    debugLines,
    focusNodes,
  };
}

function splitBodyIntoBlocks(body: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of body.split('\n')) {
    if (line.trim() === '---') {
      const value = current.join('\n').trim();
      if (value) {
        blocks.push(value);
      }
      current = [];
      continue;
    }
    current.push(line);
  }

  const tail = current.join('\n').trim();
  if (tail) {
    blocks.push(tail);
  }

  return blocks;
}

function getOrderedTextChildrenByKind(frame: FrameNode, kind: TextKind): TextNode[] {
  return collectTextNodesByKind(frame, kind);
}

function parseIdFromFrameName(name: string): string {
  if (!name.startsWith(FRAME_PREFIX)) {
    return '';
  }
  return normalizeIdentifier(name.slice(FRAME_PREFIX.length).trim());
}

function getTopLevelFrames(): FrameNode[] {
  return figma.currentPage.children.filter((node): node is FrameNode => node.type === 'FRAME');
}

function pickFrameTemplate(topLevelFrames: FrameNode[]): FrameNode | null {
  if (topLevelFrames.length === 0) {
    return null;
  }
  const namedTemplate = topLevelFrames.find((frame) => frame.name.trim().toLowerCase() === 'template');
  return namedTemplate ?? topLevelFrames[0];
}

function createFrameForScript(
  frameId: string,
  index: number,
  frameTemplate: FrameNode | null,
  topLevelFrames: FrameNode[],
): FrameNode {
  const frame = frameTemplate ? (frameTemplate.clone() as FrameNode) : figma.createFrame();
  frame.name = `${FRAME_PREFIX} ${frameId}`;

  if (!frameTemplate) {
    frame.layoutMode = 'VERTICAL';
    frame.primaryAxisSizingMode = 'AUTO';
    frame.counterAxisSizingMode = 'FIXED';
    frame.resizeWithoutConstraints(FRAME_WIDTH, 100);
    frame.itemSpacing = 12;
    frame.paddingTop = FRAME_PADDING;
    frame.paddingRight = FRAME_PADDING;
    frame.paddingBottom = FRAME_PADDING;
    frame.paddingLeft = FRAME_PADDING;
    frame.x = index * (FRAME_WIDTH + 80);
    frame.y = 0;
    frame.fills = [{ type: 'SOLID', color: { r: 0.97, g: 0.97, b: 0.97 } }];
  } else {
    const rightMost = topLevelFrames.reduce((max, node) => Math.max(max, node.x + node.width), 0);
    frame.x = rightMost + 80;
    frame.y = frameTemplate.y;
  }

  figma.currentPage.appendChild(frame);
  return frame;
}

async function findOrCreateTextChild(
  frame: FrameNode,
  candidateNames: string[],
  createName: string,
  fallbackFont: FontName,
): Promise<TextNode> {
  const existing = findTextChildByCandidateNames(frame, candidateNames);

  if (existing) {
    return existing;
  }

  const textNode = figma.createText();
  textNode.name = createName;
  await figma.loadFontAsync(fallbackFont);
  textNode.fontName = fallbackFont;
  textNode.characters = '';
  frame.appendChild(textNode);
  return textNode;
}

function findTextChildByCandidateNames(frame: FrameNode, candidateNames: string[]): TextNode | null {
  const wanted = new Set(candidateNames.map((name) => name.toLowerCase()));

  const matchingNodes = collectTextNodes(frame).filter((node) => wanted.has(node.name.toLowerCase()));
  return matchingNodes[0] ?? null;
}

function collectTextNodesByKind(root: FrameNode, kind: TextKind): TextNode[] {
  // Order follows collectTextNodes (frame layer stacking order, topmost
  // first) rather than any number in the layer's name — body layers are
  // all named plain "body", so stacking order is the only source of order.
  return collectTextNodes(root).filter((node) => {
    const name = node.name.toLowerCase().trim();
    if (name === kind) {
      return true;
    }
    return new RegExp(`^${kind}\\s+\\d+$`).test(name);
  });
}

function collectTextNodes(root: SceneNode): TextNode[] {
  if (root.type === 'TEXT') {
    return [root];
  }

  if (!('children' in root)) {
    return [];
  }

  // A frame's own text children always outrank anything nested deeper,
  // regardless of how a sibling sub-frame happens to sit in stacking order.
  const directText: TextNode[] = [];
  const containers: SceneNode[] = [];

  for (let i = root.children.length - 1; i >= 0; i -= 1) {
    const child = root.children[i];
    if (child.type === 'TEXT') {
      directText.push(child);
    } else if ('children' in child) {
      containers.push(child);
    }
  }

  return directText.concat(containers.flatMap((container) => collectTextNodes(container)));
}

function getCandidateChildNames(kind: TextKind, position: number): string[] {
  // Body layers carry no position number — there can be any number of them,
  // and which one is "first" comes from frame layer order, not from a name.
  if (kind === 'body') {
    return ['body', 'Body'];
  }

  if (position === 1) {
    return [
      kind,
      `${kind} 1`,
      `${capitalize(kind)} 1`,
      capitalize(kind),
    ];
  }

  return [
    `${kind} ${position}`,
    `${capitalize(kind)} ${position}`,
  ];
}

function defaultChildName(kind: TextKind, position: number): string {
  if (kind === 'body') {
    return 'body';
  }
  if (position === 1) {
    return kind;
  }
  return `${kind} ${position}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function writeText(textNode: TextNode, value: string, fallbackFont: FontName): Promise<void> {
  if (textNode.characters.length === 0) {
    // getRangeAllFontNames throws on a zero-length range, so empty (freshly
    // created) nodes must skip straight to the fallback font.
    await figma.loadFontAsync(fallbackFont);
    textNode.fontName = fallbackFont;
  } else {
    const uniqueFonts = dedupeFonts(textNode.getRangeAllFontNames(0, textNode.characters.length));
    await Promise.all(uniqueFonts.map((font) => figma.loadFontAsync(font)));
  }
  textNode.characters = value;
}

function dedupeFonts(fonts: FontName[]): FontName[] {
  const seen = new Set<string>();
  const output: FontName[] = [];
  for (const font of fonts) {
    const key = `${font.family}__${font.style}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(font);
    }
  }
  return output;
}
