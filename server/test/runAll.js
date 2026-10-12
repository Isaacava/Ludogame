'use strict';
// Runs every *.test.js in its own process (the integration tests start a real server and exit when done) and reports each one.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 120000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + f);
  if (!ok) console.log(((r.stderr || '') + (r.stdout || '')).split('\n').filter(l => l && !/^\[waha\]|listening/.test(l)).slice(0, 8).map(l => '    ' + l).join('\n'));
}
console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nAll ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
