import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp } from './server';
import { ensureBridge } from './launcher';
const { token } = await ensureBridge();
await createMcp(token, process.env.FIGMA_BRIDGE_URL).connect(new StdioServerTransport());
