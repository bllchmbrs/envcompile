#!/usr/bin/env bun

import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`envcompile: ${message}`);
  process.exitCode = error.exitCode || 1;
});
