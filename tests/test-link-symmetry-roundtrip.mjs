#!/usr/bin/env node
/**
 * Spec 009 / User Story 3 — round-trip identity acceptance.
 *
 * Writes a doc via `append_markdown` containing canonical doc-link forms
 * (mid-text and standalone) and external markdown links, then exports back
 * via `export_doc_markdown` and checks that every link form survived.
 *
 * Round-trip is checked structurally (not byte-equal) because BlockSuite's
 * markdown adapter normalizes whitespace and may flatten paragraph-alone
 * canonical links into the same paragraph as following blocks. The
 * essential invariant is: every input `affine://doc/<docId>` URI appears
 * in the export, with the right title text adjacent.
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
  console.log('=== Spec 009 / US3 — Link Symmetry Round-trip Test ===');
  console.log(`Base URL: ${BASE_URL}\n`);

  const client = new Client({ name: 'affine-mcp-link-symmetry-roundtrip-test', version: '1.0.0' });
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

    const target = await call('create_doc', { workspaceId, title: '[link-sym-rt] Target' });
    targetDocId = target.docId;
    await settle();

    const inputMd = [
      `Para1 mentions [Target Doc](affine://doc/${targetDocId}) mid-sentence.`,
      ``,
      `[Target Doc Alone](affine://doc/${targetDocId})`,
      ``,
      `- list item with [Target Doc](affine://doc/${targetDocId}) inside`,
      `- list item with [Anthropic](https://anthropic.com) external`,
    ].join('\n');

    const probe = await call('create_doc_from_markdown', { workspaceId, title: '[link-sym-rt] Probe', markdown: inputMd });
    probeDocId = probe.docId;
    await settle();

    console.log('[Test] Export markdown and verify all canonical + external links survive');
    const exp = await call('export_doc_markdown', { workspaceId, docId: probeDocId });
    const out = String(exp.markdown || '');
    console.log('--- exported markdown (first 600 chars) ---');
    console.log(out.slice(0, 600));
    console.log('---');

    // Canonical link must appear at least 3 times (mid-text, standalone, in list)
    const canonicalRe = new RegExp(`affine://doc/${targetDocId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'g');
    const canonicalHits = (out.match(canonicalRe) || []).length;
    expect(canonicalHits >= 3, `expected ≥3 occurrences of affine://doc/${targetDocId}, got ${canonicalHits}`);
    console.log(`  ${canonicalHits} canonical-doc-link occurrences preserved`);

    // External anthropic.com URL must appear (regression fix from old adapter dropping URLs)
    expect(out.includes('https://anthropic.com'), 'external URL https://anthropic.com must survive round-trip');
    expect(out.includes('Anthropic'), 'external link display text Anthropic must be present');
    console.log(`  external [Anthropic](https://anthropic.com) link preserved`);

    // Title text adjacency check: at least one occurrence pairs "Target Doc" with the URI
    expect(/\[Target Doc[^\]]*\]\(affine:\/\/doc\//.test(out), 'expected [Target Doc...](affine://doc/...) form in export');
    console.log('  bracketed-title + canonical-URI adjacency confirmed');

    console.log('\n=== ALL TESTS PASSED ===');
  } finally {
    try { if (probeDocId) await call('delete_doc', { workspaceId, docId: probeDocId }); } catch {}
    try { if (targetDocId) await call('delete_doc', { workspaceId, docId: targetDocId }); } catch {}
    await client.close().catch(() => {});
  }
}

main().catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
