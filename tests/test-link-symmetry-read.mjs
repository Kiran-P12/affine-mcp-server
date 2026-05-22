#!/usr/bin/env node
/**
 * Spec 009 / User Story 2 — read-side acceptance.
 *
 * Verifies:
 *  (a) read_doc surfaces structured `references[]` on text-bearing block
 *      flavours (paragraph, heading, list) when an inline reference is
 *      present (FR-003 universal coverage).
 *  (b) list_children enumerates inline references with `kind: "inline"`
 *      and `sourceBlockId`, plus block-level cards with `kind: "embed"`
 *      (FR-005).
 *
 * Note: the embed_linked_doc card read-path (pageId / linkedTitle on a
 * card block) is verifiable only against UI-authored cards; this test
 * focuses on the inline path which is fully reachable via MCP after spec
 * 009 (the `embed_linked_doc` write path now produces inline references).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error('AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh');
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');

function parseContent(result) {
  const t = result?.content?.[0]?.text;
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}
function assertResult(toolName, result) {
  if (result?.isError) throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || 'unknown'}`);
  const parsed = parseContent(result);
  if (parsed && typeof parsed === 'object' && parsed.error) throw new Error(`${toolName} failed: ${parsed.error}`);
  return parsed;
}
function expect(cond, message) { if (!cond) throw new Error(message); }

async function main() {
  console.log('=== Spec 009 / US2 — Link Symmetry Read Test ===');
  console.log(`Base URL: ${BASE_URL}\n`);

  const client = new Client({ name: 'affine-mcp-link-symmetry-read-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      XDG_CONFIG_HOME: '/tmp/affine-mcp-e2e-noconfig',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(`[mcp-server] ${chunk}`));
  const settle = (ms = 800) => new Promise(r => setTimeout(r, ms));

  async function call(toolName, args = {}) {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    return assertResult(toolName, result);
  }

  let workspaceId, targetDocId, probeDocId;
  try {
    await client.connect(transport);
    const workspaces = await call('list_workspaces');
    workspaceId = workspaces[0]?.id;
    if (!workspaceId) throw new Error('No workspace available');

    const target = await call('create_doc', { workspaceId, title: '[link-sym-read] Target' });
    targetDocId = target.docId;
    await settle();
    const probe = await call('create_doc_from_markdown', {
      workspaceId,
      title: '[link-sym-read] Probe',
      markdown: [
        `# Heading with [Target](affine://doc/${targetDocId}) ref`,
        ``,
        `Para mentions [Target](affine://doc/${targetDocId}) inline.`,
        ``,
        `- list item with [Target](affine://doc/${targetDocId}) inline`,
        `- another list item without ref`,
        ``,
        `[Target Standalone](affine://doc/${targetDocId})`,
      ].join('\n'),
    });
    probeDocId = probe.docId;
    await settle();

    // (a) read_doc surfaces references[] on heading, paragraph, list
    console.log('[Test a] read_doc references[] on heading, paragraph, list');
    const r = await call('read_doc', { workspaceId, docId: probeDocId });
    const blocksByText = (substr) => r.blocks.filter(b => b.text && b.text.toLowerCase().includes(substr));
    const heading = blocksByText('heading with')[0];
    expect(heading, 'heading block not found');
    expect(heading.references?.length === 1 && heading.references[0].pageId === targetDocId, 'heading reference missing/wrong');
    const para = blocksByText('para mentions')[0];
    expect(para, 'paragraph block not found');
    expect(para.references?.length === 1 && para.references[0].pageId === targetDocId, 'paragraph reference missing/wrong');
    const listItem = blocksByText('list item with')[0];
    expect(listItem, 'list item block not found');
    expect(listItem.references?.length === 1 && listItem.references[0].pageId === targetDocId, 'list item reference missing/wrong');
    console.log('  PASS: heading, paragraph, and list item all surface references[]\n');

    // (b) list_children inline-kind enumeration
    console.log('[Test b] list_children inline-kind enumeration');
    const lc = await call('list_children', { workspaceId, docId: probeDocId });
    const inlineRefs = (lc.children || []).filter(c => c.kind === 'inline' && c.docId === targetDocId);
    expect(inlineRefs.length >= 4, `expected ≥4 inline children targeting ${targetDocId}, got ${inlineRefs.length}`);
    expect(inlineRefs.every(c => typeof c.sourceBlockId === 'string' && c.sourceBlockId.length > 0), 'sourceBlockId missing on inline child');
    console.log(`  PASS: list_children returned ${inlineRefs.length} inline-kind children with sourceBlockId\n`);

    console.log('=== ALL TESTS PASSED ===');
  } finally {
    try { if (probeDocId) await call('delete_doc', { workspaceId, docId: probeDocId }); } catch {}
    try { if (targetDocId) await call('delete_doc', { workspaceId, docId: targetDocId }); } catch {}
    await client.close().catch(() => {});
  }
}

main().catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
