import type { MarkdownRenderResult, MarkdownRenderableBlock, TextDelta } from "./types.js";

/**
 * Spec 009 FR-006/FR-007/FR-008: walk a block's TextDelta array and emit
 * markdown that preserves inline formatting and link information that the
 * old plain-text path silently discarded. In particular:
 * - LinkedPage reference deltas (insert: "\u200B" + attributes.reference)
 *   become the canonical link form `[Title](affine://doc/<docId>)`.
 * - External link deltas (attributes.link) become `[text](url)`.
 * - bold/italic/strike/code attributes are preserved.
 * If `deltas` is missing or empty, falls back to `fallback` (the block's
 * plain-text rendering, retaining the legacy behavior for clients that
 * haven't populated deltas yet).
 */
function renderInlineFromDeltas(deltas: TextDelta[] | undefined, fallback: string): string {
  if (!deltas || deltas.length === 0) return fallback;
  const parts: string[] = [];
  for (const delta of deltas) {
    if (typeof delta.insert !== "string") continue;
    const attrs = (delta.attributes ?? {}) as TextDelta["attributes"] & { reference?: { type?: string; pageId?: string; title?: string | null } };
    const ref = attrs?.reference;
    if (
      ref &&
      typeof ref === "object" &&
      ref.type === "LinkedPage" &&
      typeof ref.pageId === "string" &&
      ref.pageId.length > 0
    ) {
      const title =
        typeof ref.title === "string" && ref.title.length > 0 ? ref.title : "Untitled";
      parts.push(`[${title}](affine://doc/${ref.pageId})`);
      continue;
    }
    let text = delta.insert;
    // Inline formatting wrappers, innermost first. Order matches the natural
    // markdown nesting agents are most likely to produce.
    if (attrs.code) text = "`" + text + "`";
    if (attrs.bold) text = `**${text}**`;
    if (attrs.italic) text = `*${text}*`;
    if (attrs.strike) text = `~~${text}~~`;
    if (typeof attrs.link === "string" && attrs.link.length > 0) {
      text = `[${text}](${attrs.link})`;
    }
    parts.push(text);
  }
  return parts.join("");
}

type RenderState = {
  blocksById: Map<string, MarkdownRenderableBlock>;
  warnings: string[];
  warningSet: Set<string>;
  unsupportedCount: number;
  visited: Set<string>;
};

type RenderChunk = {
  lines: string[];
  isList: boolean;
};

function addWarning(state: RenderState, warning: string): void {
  if (!state.warningSet.has(warning)) {
    state.warningSet.add(warning);
    state.warnings.push(warning);
  }
}

function formatQuote(text: string): string[] {
  const lines = text.split("\n");
  return lines.map(line => `> ${line}`);
}

function formatCallout(lines: string[]): string[] {
  return [
    "> [!NOTE]",
    ...lines.map(line => line.length > 0 ? `> ${line}` : ">"),
  ];
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function renderTable(tableData: string[][]): string[] {
  if (tableData.length === 0) {
    return ["| |", "| --- |"];
  }

  const columns = tableData.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) {
    return ["| |", "| --- |"];
  }

  const normalized = tableData.map(row => {
    const copy = [...row];
    while (copy.length < columns) {
      copy.push("");
    }
    return copy;
  });

  const header = normalized[0].map(escapePipe);
  const separator = new Array(columns).fill("---");
  const body = normalized.slice(1).map(row => `| ${row.map(cell => escapePipe(cell ?? "")).join(" | ")} |`);

  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...body,
  ];
}

function childList(block: MarkdownRenderableBlock): string[] {
  return Array.isArray(block.childIds) ? block.childIds : [];
}

function renderBlock(
  blockId: string,
  listDepth: number,
  state: RenderState
): RenderChunk {
  if (state.visited.has(blockId)) {
    return { lines: [], isList: false };
  }
  state.visited.add(blockId);

  const block = state.blocksById.get(blockId);
  if (!block) {
    state.unsupportedCount += 1;
    addWarning(state, `Missing block '${blockId}' while exporting markdown.`);
    return { lines: [], isList: false };
  }

  const text = (block.text ?? "").trim();
  const flavour = block.flavour ?? "";
  const type = block.type ?? "";
  const children = childList(block);

  switch (flavour) {
    case "affine:paragraph": {
      // Spec 009 FR-006/FR-007: prefer delta-aware rendering when available so
      // inline references (`[Title](affine://doc/X)`) and external links
      // (`[text](url)`) survive a markdown round-trip. Falls back to the
      // legacy plain-text path when block.deltas is missing.
      const inlineText = renderInlineFromDeltas(block.deltas, text).trim();
      let lines: string[] = [];

      if (/^h[1-6]$/.test(type)) {
        const level = Number(type.slice(1));
        lines = [`${"#".repeat(level)} ${inlineText}`.trimEnd()];
      } else if (type === "quote") {
        lines = formatQuote(inlineText);
      } else {
        lines = [inlineText];
      }

      for (const childId of children) {
        const child = renderBlock(childId, listDepth, state);
        if (child.lines.length > 0) {
          lines.push(...child.lines);
        }
      }

      return { lines: lines.filter(line => line.length > 0), isList: false };
    }

    case "affine:list": {
      const indent = "  ".repeat(Math.max(0, listDepth));
      const style = type === "numbered" ? "numbered" : type === "todo" ? "todo" : "bulleted";
      const marker =
        style === "numbered"
          ? "1."
          : style === "todo"
            ? block.checked
              ? "- [x]"
              : "- [ ]"
            : "-";
      // Spec 009: delta-aware rendering for list items so a list item
      // containing `[Title](affine://doc/X)` or `[text](url)` round-trips.
      const inlineText = renderInlineFromDeltas(block.deltas, text).trim();
      const lines: string[] = [`${indent}${marker}${inlineText ? ` ${inlineText}` : ""}`];

      for (const childId of children) {
        const child = state.blocksById.get(childId);
        const nextDepth = child?.flavour === "affine:list" ? listDepth + 1 : listDepth;
        const rendered = renderBlock(childId, nextDepth, state);
        if (rendered.lines.length > 0) {
          lines.push(...rendered.lines);
        }
      }

      return { lines, isList: true };
    }

    case "affine:code": {
      const language = block.language ?? "";
      const lines = [`\`\`\`${language}`, block.text ?? "", "\`\`\`"];
      return { lines, isList: false };
    }

    case "affine:divider":
      return { lines: ["---"], isList: false };

    case "affine:bookmark":
    case "affine:embed-youtube":
    case "affine:embed-github":
    case "affine:embed-figma":
    case "affine:embed-loom":
    case "affine:embed-iframe": {
      const url = (block.url ?? "").trim();
      if (!url) {
        state.unsupportedCount += 1;
        addWarning(state, `Bookmark/embed block '${blockId}' had no URL and was skipped.`);
        return { lines: [], isList: false };
      }
      const label = (block.caption ?? "").trim() || text || url;
      return { lines: [`[${label}](${url})`], isList: false };
    }

    case "affine:image": {
      const source = (block.sourceId ?? "").trim();
      if (!source) {
        state.unsupportedCount += 1;
        addWarning(state, `Image block '${blockId}' had no sourceId and was skipped.`);
        return { lines: [], isList: false };
      }
      const alt = (block.caption ?? "").trim() || "image";
      return { lines: [`![${alt}](affine://blob/${source})`], isList: false };
    }

    case "affine:table": {
      if (!block.tableData || block.tableData.length === 0) {
        state.unsupportedCount += 1;
        addWarning(state, `Table block '${blockId}' had no readable cell data.`);
        return { lines: ["| |", "| --- |"], isList: false };
      }
      return {
        lines: renderTable(block.tableData),
        isList: false,
      };
    }

    case "affine:callout": {
      const contentLines: string[] = [];
      for (const childId of children) {
        const child = renderBlock(childId, listDepth, state);
        if (child.lines.length > 0) {
          if (contentLines.length > 0 && !child.isList) {
            contentLines.push("");
          }
          contentLines.push(...child.lines);
        }
      }
      if (contentLines.length === 0 && text.length > 0) {
        contentLines.push(text);
      }
      return {
        lines: formatCallout(contentLines),
        isList: false,
      };
    }

    case "affine:note":
    case "affine:page":
    case "affine:surface": {
      const chunks: string[] = [];
      for (const childId of children) {
        const child = renderBlock(childId, listDepth, state);
        if (child.lines.length > 0) {
          if (chunks.length > 0 && !child.isList) {
            chunks.push("");
          }
          chunks.push(...child.lines);
        }
      }
      return { lines: chunks, isList: false };
    }

    case "affine:embed-linked-doc": {
      // Spec 009 FR-006: emit the canonical link form for block-level link
      // cards instead of the opaque <!-- unsupported --> placeholder. The
      // canonical form round-trips through the parser back into a paragraph
      // containing one inline reference (per FR-001/FR-014). Note: this
      // makes the export lossy on the *kind* dimension (a card on read
      // becomes an inline reference on re-import) but preserves the link
      // target identity, which is what callers actually need.
      if (!block.pageId) {
        state.unsupportedCount += 1;
        addWarning(state, `Embed-linked-doc block '${blockId}' had no pageId and was skipped.`);
        return { lines: [], isList: false };
      }
      const title =
        typeof block.linkedTitle === "string" && block.linkedTitle.length > 0
          ? block.linkedTitle
          : "Untitled";
      return {
        lines: [`[${title}](affine://doc/${block.pageId})`],
        isList: false,
      };
    }

    default: {
      state.unsupportedCount += 1;
      addWarning(state, `Unsupported AFFiNE block flavour '${flavour || "unknown"}' was exported as a comment placeholder.`);
      return {
        lines: [`<!-- unsupported: flavour=${flavour || "unknown"} blockId=${blockId} -->`],
        isList: false,
      };
    }
  }
}

export function renderBlocksToMarkdown(input: {
  rootBlockIds: string[];
  blocksById: Map<string, MarkdownRenderableBlock>;
}): MarkdownRenderResult {
  const state: RenderState = {
    blocksById: input.blocksById,
    warnings: [],
    warningSet: new Set<string>(),
    unsupportedCount: 0,
    visited: new Set<string>(),
  };

  const chunks: RenderChunk[] = [];

  for (const rootId of input.rootBlockIds) {
    const rendered = renderBlock(rootId, 0, state);
    if (rendered.lines.length > 0) {
      chunks.push(rendered);
    }
  }

  const lines: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (i > 0) {
      const previous = chunks[i - 1];
      const shouldInsertBlank = !(previous.isList && chunk.isList);
      if (shouldInsertBlank) {
        lines.push("");
      }
    }
    lines.push(...chunk.lines);
  }

  return {
    markdown: lines.join("\n").trimEnd(),
    warnings: state.warnings,
    lossy: state.unsupportedCount > 0,
    stats: {
      blockCount: state.visited.size,
      unsupportedCount: state.unsupportedCount,
    },
  };
}
