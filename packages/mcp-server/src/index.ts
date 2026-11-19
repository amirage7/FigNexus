import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp } from './server';
import { ensureBridge } from './launcher';
const token = process.env.FIGMA_CHAT_SCOPE ?? (await ensureBridge()).token;
await createMcp(token, process.env.FIGMA_BRIDGE_URL).connect(new StdioServerTransport());
