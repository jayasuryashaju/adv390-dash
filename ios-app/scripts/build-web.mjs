// Copies ../web into ./www for Capacitor, bundles the native BLE plugin and renders the app icon.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'www');
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(path.join(root, '..', 'web'), www, { recursive: true });
rmSync(path.join(www, 'sw.js'), { force: true });

await build({ entryPoints: [path.join(root, 'native-ble-entry.js')], bundle: true, format: 'iife', minify: true, outfile: path.join(www, 'native-ble.js') });
const html = readFileSync(path.join(www, 'index.html'), 'utf8');
if (!html.includes('<script type="module" src="app.js">')) throw new Error('index.html script tag not found');
writeFileSync(path.join(www, 'index.html'), html.replace('<script type="module" src="app.js">', '<script src="native-ble.js"></script>\n  <script type="module" src="app.js">'));

mkdirSync(path.join(root, 'assets'), { recursive: true });
const svg = readFileSync(path.join(root, '..', 'web', 'icon.svg'));
await sharp(svg, { density: 1200 }).resize(1024, 1024).flatten({ background: '#dde3df' }).png().toFile(path.join(root, 'assets', 'icon-only.png'));
console.log('www ready');
