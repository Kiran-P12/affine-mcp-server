#!/usr/bin/env node
/**
 * Spec 009 / User Story 1 — write-side acceptance.
 *
 * Verifies:
 *  (a) Mid-text canonical link via `append_markdown` produces an inline
 *      LinkedPage reference on the resulting paragraph block.
 *  (b) Paragraph-alone canonical link produces a paragraph block with one
 *      reference delta — NOT an `affine:embed-linked-doc` card (FR-001).
 *  (c) `append_block(type="embed_linked_doc", pageId)` produces a paragraph
 *      block with one reference delta (parity with the markdown-form path).
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
  console.log('=== Spec 009 / US1 — Link Symmetry Write Test ===');
  console.log(`Base URL: ${BASE_URL}\n`);

  const client = new Client({ name: 'affine-mcp-link-symmetry-write-test', version: '1.0.0' });
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

    const target = await call('create_doc', { workspaceId, title: '[link-sym-write] Target' });
    targetDocId = target.docId;
    await settle();
    const probe = await call('create_doc', { workspaceId, title: '[link-sym-write] Probe' });
    probeDocId = probe.docId;
    await settle();

    // (a) mid-text canonical link
    console.log('[Test a] Mid-text canonical link via append_markdown');
    await call('append_markdown', { workspaceId, docId: probeDocId,
      markdown: `See [Target](affine://doc/${targetDocId}) for context.` });
    await settle();
    const r1 = await call('read_doc', { workspaceId, docId: probeDocId });
    const para = r1.blocks.find(b => b.flavour === 'affine:paragraph' && b.references?.some(r => r.pageId === targetDocId));
    expect(para, 'paragraph with target reference not found');
    expect(para.references.length === 1, `expected 1 reference, got ${para.references.length}`);
    expect(para.references[0].pageId === targetDocId, `pageId mismatch`);
    console.log(`  PASS: mid-text reference at span [${para.references[0].from}, ${para.references[0].to})\n`);

    // (b) paragraph-alone canonical link
    console.log('[Test b] Paragraph-alone canonical link via append_markdown');
    await call('append_markdown', { workspaceId, docId: probeDocId,
      markdown: `[Target Standalone](affine://doc/${targetDocId})` });
    await settle();
    const r2 = await call('read_doc', { workspaceId, docId: probeDocId });
    const refParas = r2.blocks.filter(b => b.flavour === 'affine:paragraph' && b.references?.some(r => r.pageId === targetDocId));
    expect(refParas.length >= 2, `expected ≥2 paragraphs with target reference, got ${refParas.length}`);
    const noCard = r2.blocks.every(b => b.flavour !== 'affine:embed-linked-doc');
    expect(noCard, 'paragraph-alone canonical link must NOT produce affine:embed-linked-doc');
    console.log('  PASS: paragraph-alone link produced paragraph with inline reference (no card)\n');

    // (c) append_block(type="embed_linked_doc")
    console.log('[Test c] append_block(type="embed_linked_doc") produces paragraph with reference');
    const ablock = await call('append_block', { workspaceId, docId: probeDocId, type: 'embed_linked_doc', pageId: targetDocId });
    await settle();
    const r3 = await call('read_doc', { workspaceId, docId: probeDocId });
    const card = r3.blocks.find(b => b.id === ablock.blockId);
    expect(card, 'newly added block not in read_doc');
    expect(card.flavour === 'affine:paragraph', `expected paragraph, got ${card.flavour}`);
    expect(card.references?.length === 1 && card.references[0].pageId === targetDocId, 'expected single reference');
    console.log('  PASS: explicit embed_linked_doc write path now produces paragraph with reference\n');

    console.log('=== ALL TESTS PASSED ===');
  } finally {
    try { if (probeDocId) await call('delete_doc', { workspaceId, docId: probeDocId }); } catch {}
    try { if (targetDocId) await call('delete_doc', { workspaceId, docId: targetDocId }); } catch {}
    await client.close().catch(() => {});
  }
}

main().catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
