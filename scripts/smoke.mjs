import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectRoot } from './setup.mjs';

const client = new Client({ name: 'byok-connection-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(projectRoot, 'src', 'server.mjs')], stderr: 'pipe',
  env: { ...process.env, BYOK_CONFIG: process.env.BYOK_CONFIG ?? join(projectRoot, 'config.local.json') } });
let diagnostics = '';
transport.stderr?.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-4000); });
try {
  await client.connect(transport, { timeout: 15000 });
  const tools = await client.listTools();
  const result = await client.callTool({ name: 'get_configuration', arguments: {} });
  if (result.isError) throw new Error(result.content[0].text);
  const resources = await client.listResources();
  const prompts = await client.listPrompts();
  console.log(JSON.stringify({ connected: true, server: client.getServerVersion(), toolCount: tools.tools.length,
    tools: tools.tools.map(tool => tool.name), resources: resources.resources.map(r => r.uri),
    prompts: prompts.prompts.map(p => p.name), configuration: JSON.parse(result.content[0].text),
    inferenceUsed: false }, null, 2));
} catch (error) { console.error(error.message, diagnostics); process.exitCode = 1; }
finally { await client.close(); await transport.close(); }
