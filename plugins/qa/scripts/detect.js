'use strict';

const path = require('node:path');
const { getRoot, readConfig, detect } = require('../hooks/lib');

try {
  const root = getRoot(process.cwd());
  const config = readConfig(root);
  let files = process.argv.slice(2).map(file => path.resolve(file));
  const preview = files.length === 0;
  // Without arguments, inspect root markers using representative file types.
  if (!files.length) files = ['__qa__.py', '__qa__.js', '__qa__.rs', '__qa__.go'].map(file => path.join(root, file));
  const plan = detect(root, files, config);
  if (preview) {
    plan.files = [];
    plan.commands = plan.commands.map(command => {
      for (const file of files) command = command.split(require('../hooks/lib').quote(file)).join(`<edited ${path.extname(file)} files>`);
      return command;
    });
  }
  console.log(JSON.stringify({
    ...plan,
    enabled: config.enabled !== false,
    mode: config.mode || 'related',
    timeoutSec: config.timeoutSec || 180,
    preview,
    configPath: path.join(root, '.claude', 'qa.json')
  }, null, 2));
} catch (error) {
  console.error(`qa: ${error.message}`);
  process.exitCode = 1;
}
