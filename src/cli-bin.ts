#!/usr/bin/env node
import { runCli } from './cli.js';

runCli(process.argv)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
