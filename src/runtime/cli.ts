#!/usr/bin/env node

import { startServer } from './mcp-server.js';

const command = process.argv[2];

if (!command || command === 'mcp-server') {
  startServer().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.stderr.write('Usage: loom-tools [mcp-server]\n');
  process.exit(1);
}
