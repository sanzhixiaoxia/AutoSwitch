#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
});

runCli().catch((error) => {
  console.error(`错误：${error.message}`);
  if (process.env.AUTOSWITCH_DEBUG || process.env.CREDITPILOT_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
