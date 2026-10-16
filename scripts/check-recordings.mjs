// Fails if any recording in docs/data holds an SSN-shaped string. A trace event's traceId is
// exempt: it is random hex and can contain nine digits in a row by chance.
import { readFileSync, readdirSync } from 'node:fs';

const SSN_LIKE = /\d{3}[- ]?\d{2}[- ]?\d{4}/;
const dir = new URL('../docs/data/', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();

let failures = 0;
let checked = 0;

function walk(value, path, file, exempt) {
  if (typeof value === 'string') {
    checked++;
    if (!exempt && SSN_LIKE.test(value)) {
      failures++;
      console.error(`FAIL ${file} ${path}: ${JSON.stringify(value)}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, file, false));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      walk(v, `${path}.${key}`, file, false);
    }
  }
}

for (const file of files) {
  const json = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  const { events = [], ...rest } = json;
  walk(rest, '$', file, false);
  events.forEach((event, i) => {
    const { data, ...meta } = event;
    walk(meta, `$.events[${i}]`, file, false);
    for (const [key, v] of Object.entries(data ?? {})) {
      walk(v, `$.events[${i}].data.${key}`, file, event.type === 'trace' && key === 'traceId');
    }
  });
  console.log(`ok   ${file}: ${events.length} events`);
}

if (failures > 0) {
  console.error(`${failures} SSN-shaped value(s) found in ${files.length} file(s).`);
  process.exit(1);
}
console.log(`${files.length} file(s), ${checked} string value(s) checked, no SSN-shaped values.`);
