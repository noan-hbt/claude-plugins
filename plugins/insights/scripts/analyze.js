#!/usr/bin/env node
'use strict';

const { analyze, suggest, renderMarkdown } = require('./lib');

async function main() {
  const options = {};
  let json = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write('Usage: node analyze.js [--days 30] [--project <substring>] [--json] [--config-dir <dir> ...]\n');
      return;
    }
    if (argument === '--json') { json = true; continue; }
    if (!['--days', '--project', '--config-dir'].includes(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    if (argument === '--days') options.days = Number(value);
    else if (argument === '--project') options.project = value;
    else (options.configDirs ||= []).push(value);
  }
  const stats = await analyze(options);
  const suggestions = suggest(stats);
  process.stdout.write(json ? `${JSON.stringify({ stats, suggestions }, null, 2)}\n` : `${renderMarkdown(stats, suggestions)}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`insights: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { main };
