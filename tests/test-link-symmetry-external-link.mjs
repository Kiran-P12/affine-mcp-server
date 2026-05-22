#!/usr/bin/env node
/**
 * Spec 009 / User Story 4 — external markdown links survive round-trip.
 *
 * Regression fix: the prior markdown renderer ignored TextDelta attributes
 * entirely (paragraph and list cases used `block.text` only), which silently
 * dropped both internal `attributes.reference` AND external `attributes.link`.
 * The delta-aware emitter introduced for US3 fixes both. This test pins the
 * external-link half of the fix as a separate acceptance.
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
  console.log('=== Spec 009 / US4 — External Link Round-trip Regression Test ===');
  console.log(`Base URL: ${BASE_URL}\n`);

  const client = new Client({ name: 'affine-mcp-link-symmetry-external-test', version: '1.0.0' });
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

  let workspaceId, probeDocId;
  try {
    await client.connect(transport);
    const workspaces = await call('list_workspaces');
    workspaceId = workspaces[0]?.id;
    if (!workspaceId) throw new Error('No workspace available');

    const inputMd = [
      `See [Anthropic](https://anthropic.com) for context, plus [OpenAI](https://openai.com) too.`,
      ``,
      `- list item with [Anthropic](https://anthropic.com) inside`,
      `- second list item with [Hugging Face](https://huggingface.co) inside`,
    ].join('\n');

    const probe = await call('create_doc_from_markdown', { workspaceId, title: '[link-sym-ext] Probe', markdown: inputMd });
    probeDocId = probe.docId;
    await settle();

    console.log('[Test] Export markdown and verify external links round-trip with text + URL');
    const exp = await call('export_doc_markdown', { workspaceId, docId: probeDocId });
    const out = String(exp.markdown || '');
    console.log('--- exported markdown (first 400 chars) ---');
    console.log(out.slice(0, 400));
    console.log('---');

    // Each external link's URL must survive (this is the regression case — old
    // adapter dropped URLs to bare text "Anthropic" / "OpenAI").
    expect(out.includes('https://anthropic.com'), 'https://anthropic.com URL must survive');
    expect(out.includes('https://openai.com'), 'https://openai.com URL must survive');
    expect(out.includes('https://huggingface.co'), 'https://huggingface.co URL must survive');

    // Display text must also be present, paired with the URL via [text](url) shape.
    expect(/\[Anthropic\]\(https:\/\/anthropic\.com\)/.test(out), '[Anthropic](https://anthropic.com) form expected');
    expect(/\[OpenAI\]\(https:\/\/openai\.com\)/.test(out), '[OpenAI](https://openai.com) form expected');
    expect(/\[Hugging Face\]\(https:\/\/huggingface\.co\)/.test(out), '[Hugging Face](https://huggingface.co) form expected');

    console.log('  PASS: all external [text](url) pairs round-tripped intact\n');
    console.log('=== ALL TESTS PASSED ===');
  } finally {
    try { if (probeDocId) await call('delete_doc', { workspaceId, docId: probeDocId }); } catch {}
    await client.close().catch(() => {});
  }
}

main().catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
