#!/usr/bin/env node
// Build the CrazyGames-only variant of Rhythm Void (Basic Launch).
//
//   node tools/build-crazygames.mjs
//
// Reads ./index.html (the live web game) and writes:
//   dist/crazygames/index.html                 the CrazyGames build
//   dist/crazygames/rhythm-void-crazygames.zip ZIP with index.html at the root and nothing else
//
// The live index.html is never modified. Every edit below is an exact text replacement that
// must match exactly the expected number of times; if the source has drifted, the build stops
// with an error instead of silently producing an incomplete variant.
//
// What changes in the CrazyGames build (docs.crazygames.com requirements, Jarvis's readiness check):
//   - Google Analytics removed (no third-party tracking / personal data without a notice)
//   - share text carries no link to the playable web version (SHARE_URL = '')
//   - results-screen beta feedback mailto: removed (outbound links only allowed on the menu)
//   - Beat Mapper dev tool unreachable (Shift+B and ?mapper=1 are inert)
//   - Rename hidden (free-text player names; Developer Terms §4.5)
//   - "Online board coming soon" replaced with neutral copy
//   - version label set to v1.0 (decision 4A: v1.0 in the CrazyGames build only; the live site keeps its own VERSION)
// No dependencies: the ZIP is written with node:zlib (deflate) and a minimal ZIP writer.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'index.html');
const OUT_DIR = join(ROOT, 'dist', 'crazygames');

const src = readFileSync(SRC, 'utf8');
let s = src;
const applied = [];
function edit(label, find, replace, count = 1) {
  const n = s.split(find).length - 1;
  if (n !== count) throw new Error(`[build-crazygames] "${label}": expected ${count} match(es), found ${n}. index.html has drifted; update this script.`);
  s = s.split(find).join(replace);
  applied.push(label);
}
function editRe(label, re, replace, count = 1) {
  const n = (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
  if (n !== count) throw new Error(`[build-crazygames] "${label}": expected ${count} match(es), found ${n}. index.html has drifted; update this script.`);
  s = s.replace(re, replace);
  applied.push(label);
}

// 1. Google Analytics: loader + config block, and the event call.
editRe('remove Google Analytics loader', /<!-- Google tag \(gtag\.js\) -->\s*<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+"><\/script>\s*<script>[\s\S]*?gtag\('config', 'G-[A-Z0-9]+'\);\s*<\/script>/,
  '<!-- CrazyGames build: no third-party analytics. -->');
edit('remove analytics event call', "      window.gtag('event', name, data);\n", '      /* CrazyGames build: analytics removed */\n');

// 2. No link to the playable web version.
edit('empty SHARE_URL', "const SHARE_URL = 'https://playrhythmvoid.com/play/';", "const SHARE_URL = '';   // CrazyGames build: no link to the web version");
edit('share text: skip empty link', '    lines.push(SHARE_URL);', '    if (SHARE_URL) lines.push(SHARE_URL);');
edit('share-best fallback: skip empty link', "(playerName() + ' is playing Rhythm Void. ' + SHARE_URL)", "(playerName() + ' is playing Rhythm Void.' + (SHARE_URL ? ' ' + SHARE_URL : ''))");
// header/inline comments that name the web domain (strings must not appear anywhere in the file)
editRe('strip web-domain comment (header)', /     One thing to check per portal: SHARE_URL below points at\n     https:\/\/playrhythmvoid\.com\/play\/ and is what gets pasted into shared\n     results\. If a portal requires links to stay on their domain, change\n     that one constant\.\n/,
  '     CrazyGames build: SHARE_URL is empty, so shared results carry no link.\n');
editRe('strip web-domain comment (SHARE_URL note)', /  \/\/ NOTE: this must match the host your site actually settles on\. If your\n  \/\/ GitHub Pages CNAME is www\.playrhythmvoid\.com,[^\n]*\n/,
  '  // NOTE (CrazyGames build): no web link is shared from this build.\n');

// 3. Results-screen feedback mailto.
editRe('remove results feedback mailto link', /\n\s*<a class="feedback-link" id="feedbackLink" href="mailto:[^"]*">[^<]*<\/a>/, '');

// 4. Beat Mapper dev tool: unreachable.
edit('Shift+B mapper toggle inert', "if (e.code === 'KeyB' && e.shiftKey && !e.repeat) {", "if (false && e.code === 'KeyB' && e.shiftKey && !e.repeat) {   // CrazyGames build: Beat Mapper disabled");
edit('?mapper=1 inert', 'if (/[?&]mapper=1/.test(location.search)) {', 'if (false) {   // CrazyGames build: ?mapper=1 disabled');

// 4b. Private dev mode: the whole block is deleted, not just hidden. The game keeps only
//     `DevMode && ...` checks, which do nothing while DevMode stays null.
editRe('remove dev mode block', /\n  \/\* DEV:BEGIN \*\/[\s\S]*?\/\* DEV:END \*\/\n/, '\n');

// 5. Rename (free-text names) hidden.
edit('hide Rename button', '<button class="btn tiny" id="renameBtn">Rename</button>', '<button class="btn tiny" id="renameBtn" hidden style="display:none">Rename</button>');

// 6. Neutral leaderboard copy.
editRe('neutral board copy', /<b>Online board coming soon\.<\/b>\s*<span>[^<]*<\/span>/,
  '<b>Your best runs</b>\n        <span>Your weekly best is tracked on this device.</span>');

// 7. Version label: v1.0 in the CrazyGames build only (Dennel's decision 4A, Nov 2).
//    VERSION is the single source of truth: at runtime it fills the menu .version-tag and the
//    settings line ("Rhythm Void " + VERSION), and it is stamped on run records (v: VERSION).
//    Matches whatever the live VERSION is, but exactly once, so a second declaration stops the build.
const CG_VERSION = 'v1.0';
editRe('version label v1.0 (decision 4A)', /const VERSION = 'v[0-9][0-9A-Za-z.\-]*';/,
  `const VERSION = '${CG_VERSION}';   // CrazyGames build: decision 4A (live site keeps its own VERSION)`);

// Final guard: none of these may remain anywhere in the CrazyGames file.
const BANNED = ['googletagmanager', 'gtag(', 'playrhythmvoid.com', 'mailto:', 'DEV:BEGIN', 'DevMode = (', 'devScreen', 'KEY_HASH', '4260230919282620'];
const left = BANNED.filter((b) => s.includes(b));
if (left.length) throw new Error('[build-crazygames] banned strings still present: ' + left.join(', '));
if (s === src) throw new Error('[build-crazygames] no changes applied');
if (!s.includes(`const VERSION = '${CG_VERSION}';`)) throw new Error('[build-crazygames] version label not set to ' + CG_VERSION);

// Write the build + ZIP (index.html at the root, nothing else).
mkdirSync(OUT_DIR, { recursive: true });
const html = Buffer.from(s, 'utf8');
writeFileSync(join(OUT_DIR, 'index.html'), html);
writeFileSync(join(OUT_DIR, 'rhythm-void-crazygames.zip'), zipOne('index.html', html));

const sha = (b) => createHash('sha256').update(b).digest('hex');
console.log(JSON.stringify({
  source: { file: 'index.html', bytes: Buffer.byteLength(src), sha256: sha(Buffer.from(src)) },
  crazygames: { file: 'dist/crazygames/index.html', bytes: html.length, sha256: sha(html) },
  zip: 'dist/crazygames/rhythm-void-crazygames.zip',
  edits: applied,
}, null, 2));

// --- minimal single-file ZIP writer (deflate) ---
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipOne(name, data) {
  const nameBuf = Buffer.from(name, 'utf8');
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 11 << 5 | 1;   // fixed timestamp: reproducible ZIPs
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, nameBuf, comp]);
  const centralPart = Buffer.concat([central, nameBuf]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, end]);
}
