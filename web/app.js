import { Trip, RearBrake, BLE, commands, createClock, parseFramePacket, encodeFramePacket, hex, idLabel, frameKey, CaptureStore,
  decodeSignal, validateSignal, toCsv, KTM_MAP, DEFAULT_CALIBRATION, decodeKtm, IdHunter, maskLabel, demoFrames } from './core.mjs';

const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).has('demo');

// Demo data must never touch the real bike's trips, calibration or saved signals.
const scope = demo ? '-demo' : '';
const keys = { signals: `adv390-signals-v1${scope}`, calibration: `adv390-calibration-v1${scope}`, theme: 'adv390-theme', tiles: 'adv390-tiles-v1', shift: 'adv390-shift-v1', palette: 'adv390-palette-v1', hideKnown: 'adv390-hide-known-v1', trips: `adv390-trips-v1${scope}` };
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { notice('Browser storage is unavailable; settings last until you close this page.'); } };

const store = new CaptureStore();
const hunter = new IdHunter();
const clock = createClock();
const rearBrake = new RearBrake();
const telemetry = () => {
  const tel = decodeKtm(rows(), calibration, deviceNow());
  return tel.brakeLight === undefined ? tel : { ...tel, ...rearBrake.read() };
};
let signals = load(keys.signals, []).flatMap(s => { try { return [validateSignal(s)]; } catch { return []; } });
let calibration = { ...DEFAULT_CALIBRATION, ...load(keys.calibration, {}) };
if (demo) calibration.leanCalibrated = true; // generated lean is already in degrees
const trips = [0, 1].map(i => new Trip(load(keys.trips, [])[i] ?? {}));
let status = null, previousStatus = null, bootId = null, rate = 0;
let link = 'idle'; // idle | connecting | connected | reconnecting
let paused = false, frozenRows = null, view = 'ride';
let lastDeviceUs = 0, lastPacketAt = 0;
let engineRunning = false, keysTimer = 0;
let lastStartPressAt = -Infinity; // The bus stays up while cranking; 0x120 D3 bit 0x10 shows the start button.
const session = { speed: 0, rpm: 0, lean: 0 };

function notice(text) {
  $('notice').hidden = !text;
  $('notice').textContent = text || '';
}

// ===========================================================================
// Transports: Web Bluetooth, and generated demo traffic with the same packets
// ===========================================================================
class BleTransport {
  constructor(handlers) { this.h = handlers; this.chain = Promise.resolve(); this.wanted = false; }
  queue(op) { // Web Bluetooth allows one GATT operation at a time.
    const next = this.chain.catch(() => {}).then(op);
    this.chain = next;
    return next;
  }
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE.service] }, { namePrefix: BLE.name }], optionalServices: [BLE.service] });
    this.device.addEventListener('gattserverdisconnected', () => this.lost());
    this.wanted = true;
    await this.open();
  }
  async open() {
    this.h.state('connecting');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(BLE.service);
    [this.frames, this.status, this.control] = await Promise.all([BLE.frames, BLE.status, BLE.control].map(u => service.getCharacteristic(u)));
    this.frames.addEventListener('characteristicvaluechanged', e => {
      const v = e.target.value;
      this.h.packet(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await this.frames.startNotifications();
    this.retries = 0;
    this.h.state('connected');
    await this.readStatus();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.readStatus(), 1000);
  }
  async readStatus() {
    try {
      const value = await this.queue(() => this.status.readValue());
      this.h.status(JSON.parse(new TextDecoder().decode(value)));
    } catch {}
  }
  send(bytes) { return this.queue(() => this.control.writeValueWithResponse(bytes)).then(() => this.readStatus()); }
  lost() {
    clearInterval(this.timer);
    if (!this.wanted) { this.h.state('idle'); return; }
    this.h.state('reconnecting');
    // The reader reboots in about a second if it loses power (e.g. bike USB socket while cranking).
    const wait = Math.min(10000, 500 * 2 ** (this.retries = (this.retries || 0) + 1) / 2);
    setTimeout(() => this.open().catch(() => this.lost()), wait);
  }
  disconnect() { this.wanted = false; this.device?.gatt.disconnect(); }
}

// iPhone app: Safari has no Web Bluetooth, so the Capacitor build bundles a native BLE plugin as window.NativeBle.
class NativeBleTransport {
  constructor(handlers) { this.h = handlers; this.wanted = false; this.retries = 0; }
  async connect() {
    const ble = window.NativeBle;
    await ble.initialize();
    this.id = (await ble.requestDevice({ services: [BLE.service], namePrefix: BLE.name })).deviceId;
    this.wanted = true;
    await this.open();
  }
  async open() {
    const ble = window.NativeBle;
    this.h.state('connecting');
    await ble.connect(this.id, () => this.lost());
    await ble.startNotifications(this.id, BLE.service, BLE.frames, v => this.h.packet(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
    this.retries = 0;
    this.h.state('connected');
    await this.readStatus();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.readStatus(), 1000);
  }
  async readStatus() {
    try { this.h.status(JSON.parse(new TextDecoder().decode(await window.NativeBle.read(this.id, BLE.service, BLE.status)))); } catch {}
  }
  async send(bytes) {
    await window.NativeBle.write(this.id, BLE.service, BLE.control, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return this.readStatus();
  }
  lost() {
    clearInterval(this.timer);
    if (!this.wanted) { this.h.state('idle'); return; }
    this.h.state('reconnecting');
    const wait = Math.min(10000, 500 * 2 ** (this.retries = this.retries + 1) / 2);
    setTimeout(() => this.open().catch(() => this.lost()), wait);
  }
  disconnect() { this.wanted = false; window.NativeBle.disconnect(this.id).catch(() => {}).finally(() => this.lost()); }
}

class DemoTransport {
  constructor(handlers) {
    this.h = handlers;
    this.sim = { rpm: 1350, throttle: 0, gear: 'N', clutch: false, speed: 0, lean: 0, tilt: 2, coolant: 42, brake: 0, killRun: true,
      map: 0, standUp: true, tcButton: false, indicatorLeft: false, indicatorRight: false, highBeam: false, fuel: 0x9c };
    this.state = { running: true, bitrate: 500000, mode: 'changes', received: 0, start: performance.now() };
    this.held = null;
    this.scene = new URLSearchParams(location.search).get('demo');
  }
  connect() {
    this.h.state('connected');
    this.timer = setInterval(() => this.tick(), 40);
    return Promise.resolve();
  }
  tick() {
    const t = (performance.now() - this.state.start) / 1000, s = this.sim;
    const cycle = t % 24;
    const gears = [0, 1, 2, 3, 4, 5, 6];
    const g = cycle < 2 ? 0 : Math.min(6, 1 + Math.floor((cycle - 2) / 3.2));
    const within = ((cycle - 2) % 3.2) / 3.2;
    s.gear = gears[g] === 0 ? 'N' : String(gears[g]);
    s.clutch = g > 0 && within < 0.06;
    s.rpm = g === 0 ? 1350 + Math.round(Math.random() * 30) : Math.round(4200 + within * 4800);
    s.throttle = g === 0 ? 0 : Math.round(25 + within * 60);
    s.speed = g === 0 ? 0 : (s.rpm / 1000) * [0, 4.4, 6.9, 9.3, 11.4, 13.3, 15][g];
    s.lean = Math.sin(t / 2.3) * 28;
    s.odo = (s.odo ?? 2143) + s.speed * 0.04 / 3600;
    s.coolant = Math.min(88, 42 + t * 1.5);
    s.brake = cycle > 22 ? 15000 : Math.round(Math.random() * 3) * 16;
    s.rearBrake = cycle > 21.5 || (cycle > 9 && cycle < 10.5);
    s.standUp = t > 1.5;
    // The ID hunter's demo: the selected control only moves while "Record with control" runs.
    const blink = Math.floor(t * 1.5) % 2 === 0;
    s.indicatorLeft = this.held === 'indicator-left' && blink;
    s.indicatorRight = this.held === 'indicator-right' && blink;
    s.highBeam = this.held === 'high-beam';
    s.tcButton = this.held === 'other' && blink;
    const scene = this.scene;
    if (scene === 'kill' || scene === 'off') Object.assign(s, { rpm: 0, throttle: 0, speed: 0, gear: 'N', clutch: false, killRun: scene === 'off', standUp: false });
    if (scene === 'rain') s.map = 2;
    if (scene === 'offroad') s.map = 1;
    if (scene === 'modes') s.map = [0, 2, 1][Math.floor(t / 6) % 3];
    if (scene === 'hot') s.coolant = 108;
    if (scene === 'stand') s.standUp = false;
    if (scene === 'qsoff') s.quickshifter = false;
    if (!this.state.running) return;
    const frames = demoFrames(s, Math.round(t * 1e6));
    frames.forEach(f => { f.count = this.state.mode === 'raw' ? 1 : 2; });
    this.state.received += frames.length * 2;
    this.h.packet(encodeFramePacket(frames));
    if (Math.floor(t * 25) % 25 === 0) this.h.status(this.statusJson(t));
  }
  statusJson(t) {
    const st = this.state;
    return { bootId: 'demo', running: st.running, bitrate: st.bitrate, mode: st.mode, received: st.received,
      lastFrameUs: Math.round(t * 1e6), uptimeUs: Math.round(t * 1e6), ids: 9, idOverflow: 0, driverMissed: 0,
      driverOverruns: 0, busErrors: 0, linkDropped: 0, rawSkipped: 0, error: '', freeHeap: 182000 };
  }
  send(bytes) {
    if (bytes[0] === 0x01) Object.assign(this.state, { running: true, bitrate: bytes[1] | bytes[2] << 8 | bytes[3] << 16 | bytes[4] << 24 });
    if (bytes[0] === 0x02) this.state.running = false;
    if (bytes[0] === 0x03) this.state.mode = bytes[1] ? 'raw' : 'changes';
    this.h.status(this.statusJson((performance.now() - this.state.start) / 1000));
    return Promise.resolve();
  }
  disconnect() { clearInterval(this.timer); this.h.state('idle'); }
}

const handlers = {
  state(next) {
    link = next;
    const text = { idle: 'Not connected', connecting: 'Connecting…', connected: demo ? 'Demo data' : 'Connected', reconnecting: 'Signal lost, reconnecting…' }[next];
    $('link-text').textContent = text;
    $('link-dot').dataset.state = next;
    $('link-dot').querySelector('use').setAttribute('href', `#i-${next === 'connected' ? 'bluetooth-connected' : next === 'reconnecting' ? 'bluetooth-slash' : 'bluetooth'}`);
    $('connect-text').textContent = next === 'idle' ? (demo ? 'Start demo' : 'Connect') : 'Disconnect';
    if (next === 'connected') keepAwake();
    syncControls();
  },
  packet(bytes) {
    let frames;
    try { frames = parseFramePacket(bytes, clock); } catch { return; }
    if (!frames.length) return;
    lastDeviceUs = frames[frames.length - 1].us;
    lastPacketAt = performance.now();
    store.ingest(frames);
    hunter.observe(frames);
    rearBrake.observe(frames);
    trips.forEach(trip => trip.observe(frames, calibration.fuelScale));
  },
  status(next) {
    if (bootId && next.bootId !== bootId) {
      store.clear(); clock.reset(); rearBrake.reset();
      notice('The reader restarted. Capture starts fresh.');
    }
    bootId = next.bootId;
    if (previousStatus && next.uptimeUs > previousStatus.uptimeUs)
      rate = Math.max(0, Math.round((next.received - previousStatus.received) * 1e6 / (next.uptimeUs - previousStatus.uptimeUs)));
    previousStatus = status = next;
    if (!$('bitrate').dataset.edited) $('bitrate').value = String(next.bitrate);
    $('stream-mode').value = next.mode;
    syncControls();
  }
};

const nativeApp = !!window.NativeBle;
const transport = demo ? new DemoTransport(handlers) : nativeApp ? new NativeBleTransport(handlers) : new BleTransport(handlers);

async function toggleConnection() {
  if (link !== 'idle') { transport.disconnect(); return; }
  if (!demo && !nativeApp && !navigator.bluetooth) {
    notice(window.isSecureContext
      ? 'This browser has no Bluetooth access. Use Chrome or Edge on Android, Windows, macOS or Linux. On iPhone, use the Bluefy browser.'
      : 'Bluetooth only works on https:// or localhost pages. Open the dashboard from its https address.');
    return;
  }
  try {
    if (!demo) notice('');
    await transport.connect();
  } catch (err) {
    handlers.state('idle');
    if (err?.name !== 'NotFoundError') notice(`Could not connect: ${err?.message || err}. Check the reader is powered and within a few metres.`);
  }
}

let wakeLock = null;
async function keepAwake() {
  if (window.Capacitor?.Plugins?.KeepAwake) { window.Capacitor.Plugins.KeepAwake.keepAwake().catch(() => {}); return; }
  try { if (!wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } } catch {}
}
document.addEventListener('visibilitychange', () => { if (link === 'connected') keepAwake(); });

// Device time "now", extrapolated from the newest frame. Used to age values.
const deviceNow = () => lastPacketAt ? lastDeviceUs + (performance.now() - lastPacketAt) * 1000 : null;
const rows = () => (paused && frozenRows) || store.rows;

// ===========================================================================
// Ride
// ===========================================================================
const REV_MAX = 12000, REV_WARN = 9000;

// Programmable two-stage shift light, like the KTM: an orange frame from stage 1, the whole screen orange from stage 2.
const SHIFT_DEFAULT = { on: true, stage1: 8000, stage2: 8800 }, SHIFT_TEST_MS = 4000;
let shift = { ...SHIFT_DEFAULT, ...load(keys.shift, {}) };
let shiftTestUntil = 0;

// Cluster colour themes. Each ride mode has its own; the defaults follow the bike's mode colours.
const PALETTES = [
  { id: 'orange', name: 'KTM orange' }, { id: 'blue', name: 'Rain blue' }, { id: 'yellow', name: 'Rally yellow' },
  { id: 'red', name: 'Race red' }, { id: 'green', name: 'Lime' }, { id: 'teal', name: 'Teal' },
  { id: 'violet', name: 'Violet' }, { id: 'white', name: 'Mono white' }
];
const PALETTE_DEFAULT = { Street: 'orange', Rain: 'blue', Offroad: 'yellow' };
let palettes = { ...PALETTE_DEFAULT, ...load(keys.palette, {}) };
function applyPalette() {
  const cluster = $('view-ride');
  cluster.dataset.palette = palettes[cluster.dataset.mode] ?? palettes.Street;
}
function shiftStage(rpm) {
  const now = performance.now();
  if (now < shiftTestUntil) return now < shiftTestUntil - SHIFT_TEST_MS / 2 ? 1 : 2;
  if (!shift.on || !rpm) return 0;
  return rpm >= shift.stage2 ? 2 : rpm >= shift.stage1 ? 1 : 0;
}
const COOL_MIN = 40, COOL_MAX = 120, COOL_HOT = 105;
const clamp01 = x => Math.max(0, Math.min(1, x));
// Fuel left is an estimate until the tank sender is found on the bus: tank size minus what Trip 2 has counted since the
// last brim fill-up (the fuel calibration asks the rider to reset Trip 2 there).
const FUEL_LOW = 0.15;
const tankL = () => calibration.tankL ?? DEFAULT_CALIBRATION.tankL;
const fuelLeft = () => Math.max(0, tankL() - trips[1].fuelL);
// Range from fuel left and the measured economy (Trip 2 first, it spans the tank; else Trip 1).
const rangeKm = () => { const eco = trips[1].stats().economy ?? trips[0].stats().economy; return eco ? fuelLeft() * eco : null; };

// Street sweep: segments along a rising curve, thicker toward the redline. Each sweep carries its own geometry.
let sweepCount = 0;
function buildSweep(g) {
  // The Street rev counter: one bright line that climbs a ramp from (x0, y0) at `angle` degrees, bends through radius r
  // and rises `rise` along the top to x1, with a glow fading inward from it. Its colour runs cool blue, white, the
  // accent at the redline, red at the top. The whole scale shows dimly and the part up to the revs shows bright.
  const [x0, y0, angle, r, top, x1, rise, glow, num] = ['x0', 'y0', 'angle', 'r', 'top', 'x1', 'rise', 'glow', 'num'].map(k => Number(g.dataset[k] ?? 0));
  const a = angle * Math.PI / 180, bendY = top + r - r * Math.cos(a), ramp = (y0 - bendY) / Math.sin(a);
  const cx = x0 + ramp * Math.cos(a) + r * Math.sin(a), cy = top + r;
  const pts = [[x0, y0]];
  for (let i = 0; i <= 120; i++) { const p = a * (1 - i / 120); pts.push([cx - r * Math.sin(p), cy - r * Math.cos(p)]); }
  pts.push([x1, top - rise]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum.at(-1);
  const at = (s, h) => { // the point s along the line, moved h outward (negative: inward)
    s = Math.min(length - 0.01, Math.max(0.01, s));
    let i = 1;
    while (i < pts.length - 1 && (cum[i] < s || cum[i] === cum[i - 1])) i++;
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], seg = cum[i] - cum[i - 1], f = (s - cum[i - 1]) / seg;
    const dx = (bx - ax) / seg, dy = (by - ay) / seg;
    return [ax + (bx - ax) * f + dy * h, ay + (by - ay) * f - dx * h];
  };
  const pt = p => p.map(v => v.toFixed(1)).join(',');
  const along = (from, to, h) => { const k = Math.max(2, Math.ceil((to - from) / 8)); return Array.from({ length: k + 1 }, (_, i) => at(from + (to - from) * i / k, h)); };
  const band = (from, to, h0, h1) => [...along(from, to, h0), ...along(from, to, h1).reverse()].map(pt).join(' ');
  // The glow starts at 60% depth and reaches full depth at the end of the bend, so the slanted ramp does not read
  // wider than the top run.
  const bendEnd = cum.at(-2), depth = s => glow * (0.6 + 0.4 * Math.min(1, s / bendEnd) ** 2 * (3 - 2 * Math.min(1, s / bendEnd)));
  const glowBand = (f0, f1) => {
    const k = Math.ceil(length / 8), ss = Array.from({ length: k + 1 }, (_, i) => length * i / k);
    return [...ss.map(s => at(s, -f0 * depth(s))), ...ss.reverse().map(s => at(s, -f1 * depth(s) - 0.8))].map(pt).join(' ');
  };
  const id = `rev${sweepCount++}`, sAt = rpm => rpm / REV_MAX * length, off = rpm => ((at(sAt(rpm), 0)[0] - x0) / (x1 - x0)).toFixed(3);
  const grad = `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x1}" y2="0">` +
    `<stop offset="0" style="stop-color: var(--rev-cool)"/><stop offset="${off(4500)}" style="stop-color: var(--rev-mid)"/>` +
    `<stop offset="${off(8300)}" style="stop-color: var(--rev-mid)"/><stop offset="${off(REV_WARN + 300)}" style="stop-color: var(--accent)"/>` +
    `<stop offset="${off(11000)}" style="stop-color: var(--red)"/><stop offset="1" style="stop-color: var(--red)"/></linearGradient>`;
  const steps = 22; // thin bands, each fainter, so the glow fades smoothly inward; each overlaps the next to hide seams
  const layers = Array.from({ length: steps }, (_, k) =>
    `<polygon points="${glowBand(k / steps, (k + 1) / steps)}" fill="url(#${id}g)" opacity="${(0.9 * (1 - (k + 0.5) / steps) ** 1.3).toFixed(3)}"/>`).join('');
  const line = `<polyline class="rev-line" points="${along(0, length, 0).map(pt).join(' ')}" stroke="url(#${id}g)"/>`;
  let ticks = '', nums = '';
  for (let v = 0; v <= REV_MAX; v += 500) {
    const s = sAt(v), major = v % 1000 === 0, tone = v >= 11000 ? ' class="red"' : v >= REV_WARN ? ' class="hot"' : '';
    const [ax, ay] = at(s, 9), [bx, by] = at(s, 9 + (major ? 16 : 9));
    ticks += `<line${tone} x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"${major ? '' : ' data-minor=""'}/>`;
    if (major) { const [x, y] = at(s, num); nums += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${g.dataset.font}"${tone}>${v / 1000}</text>`; }
  }
  g.innerHTML = `<defs>${grad}<clipPath id="${id}c"><polygon/></clipPath></defs>` +
    `<g class="rev-track">${layers}${line}</g><g class="rev-lit" clip-path="url(#${id}c)">${layers}${line}</g>` +
    `<line class="rev-tip"/><g class="ticks">${ticks}</g><g class="nums">${nums}</g>`;
  const clip = g.querySelector('clipPath polygon'), tip = g.querySelector('.rev-tip');
  return {
    g,
    set(f) { // f: 0..1 of the full scale
      const s = Math.min(1, Math.max(0, f)) * length;
      clip.setAttribute('points', s < 1 ? '' : band(0, s, 30, -glow - 10));
      tip.toggleAttribute('hidden', s < 1);
      const [ax, ay] = at(s, -depth(s) * 0.7), [bx, by] = at(s, 6);
      tip.setAttribute('x1', ax.toFixed(1)); tip.setAttribute('y1', ay.toFixed(1)); tip.setAttribute('x2', bx.toFixed(1)); tip.setAttribute('y2', by.toFixed(1));
    }
  };
}
let sweeps = [];

const svgns = 'http://www.w3.org/2000/svg';
function buildSegbar(g) { // segmented bars: rev counter, fuel and coolant
  const [x, y, w, h, n, gap] = ['x', 'y', 'w', 'h', 'n', 'gap'].map(k => Number(g.dataset[k]));
  const vertical = g.dataset.dir === 'v', kind = g.dataset.kind;
  const size = ((vertical ? h : w) - gap * (n - 1)) / n;
  g.replaceChildren();
  for (let i = 0; i < n; i++) {
    const r = document.createElementNS(svgns, 'rect'), top = (i + 1) / n;
    if (vertical) r.setAttribute('x', x), r.setAttribute('y', (y + h - (i + 1) * size - i * gap).toFixed(1)), r.setAttribute('width', w), r.setAttribute('height', size.toFixed(1));
    else r.setAttribute('x', (x + i * (size + gap)).toFixed(1)), r.setAttribute('y', y), r.setAttribute('width', size.toFixed(1)), r.setAttribute('height', h);
    r.setAttribute('rx', 2);
    if (kind === 'rpm' ? top * REV_MAX > REV_WARN : kind === 'fuel' ? top <= FUEL_LOW + 1e-9 : COOL_MIN + top * (COOL_MAX - COOL_MIN) > COOL_HOT) r.setAttribute('class', 'warn');
    g.append(r);
  }
}
function buildScale(g) { // 0-12 rev numbers under a straight rev bar
  const [x, w, y] = ['x', 'w', 'y'].map(k => Number(g.dataset[k]));
  g.innerHTML = Array.from({ length: REV_MAX / 1000 + 1 }, (_, k) =>
    `<text x="${(x + w * k * 1000 / REV_MAX).toFixed(1)}" y="${y}" font-size="${g.dataset.font}"${k * 1000 >= REV_WARN ? ' class="hot"' : ''}>${k}</text>`).join('');
}
function buildGauges() {
  sweeps = [...document.querySelectorAll('.sweep')].map(buildSweep);
  document.querySelectorAll('.segbar').forEach(buildSegbar);
  document.querySelectorAll('.scale').forEach(buildScale);
}

// The landscape screens stretch to the stage, so no width is left empty on any phone: each drawing keeps its height
// and gains width. Groups marked data-anchor="right" or "center" move with that edge or the middle; data-stretch
// lengthens a rev bar (x1), a bar or scale (w), a rect (width), a rule (x2) or a red zone (zone <share>).
// A stage narrower than the drawing keeps the drawing whole and centres it.
function fitScreens() {
  let changed = false;
  for (const svg of document.querySelectorAll('.wide-svg')) {
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const [, , w0, h0] = (svg.dataset.viewbox ??= svg.getAttribute('viewBox')).split(' ').map(Number);
    const ratio = box.width / box.height, w = Math.max(w0, h0 * ratio), h = w / ratio, dx = Math.round(w - w0);
    svg.setAttribute('viewBox', `0 ${((h0 - h) / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
    if (svg.dataset.dx === String(dx)) continue;
    svg.dataset.dx = dx;
    changed = true;
    for (const el of svg.querySelectorAll('[data-anchor]')) el.setAttribute('transform', `translate(${el.dataset.anchor === 'center' ? dx / 2 : dx} 0)`);
    for (const el of svg.querySelectorAll('[data-stretch]')) {
      const [kind, share] = el.dataset.stretch.split(' '), keep = (key, read) => Number(el.dataset[key] ??= read());
      if (kind === 'x1' || kind === 'w') el.dataset[kind] = keep('base', () => el.dataset[kind]) + dx;
      else if (kind === 'zone') {
        el.setAttribute('x', keep('baseX', () => el.getAttribute('x')) + dx * share);
        el.setAttribute('width', keep('base', () => el.getAttribute('width')) + dx * (1 - share));
      } else el.setAttribute(kind, keep('base', () => el.getAttribute(kind)) + dx);
    }
  }
  if (changed) { buildGauges(); render(); }
}

const show = (id, value, digits = 0) => { $(id).textContent = value === undefined || value === null ? '--' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }); };
const lamp = (id, on) => $(id).classList.toggle('on', !!on);

// Lamps sit in the top line on every page, so they update whatever the view.
function renderLamps(tel) {
  const live = link === 'connected' && tel.rpm !== undefined;
  lamp('lamp-neutral', live && tel.gear === 'N');
  lamp('lamp-stand', live && tel.standUp === false);
  lamp('lamp-kill', live && tel.killRun === false);
  lamp('lamp-temp', live && tel.coolant >= COOL_HOT);
  lamp('lamp-tc', live && tel.traction === 'Off');
  const qs = $('lamp-qs');
  lamp('lamp-qs', live && tel.quickshifter !== undefined);
  qs.classList.toggle('amber', tel.quickshifter === false); qs.classList.toggle('green', tel.quickshifter !== false);
  qs.lastElementChild.textContent = tel.quickshifter === false ? 'QS off' : 'QS on';
  qs.title = tel.quickshifter === false ? 'Quickshifter off' : 'Quickshifter on';
  lamp('lamp-abs', live && tel.absMode === 'Offroad');
  lamp('lamp-clutch', live && tel.clutch);
  lamp('lamp-brake', live && tel.brakeLight);
}

// All three ride-mode layouts read from the same values: elements name what they show with data-bind,
// bars with data-meter, segmented bars with .segbar and data-kind, status groups with data-alert.
let rideEls = null;
function rideElements() {
  const q = sel => [...$('view-ride').querySelectorAll(sel)];
  return rideEls ??= { bind: q('[data-bind]'), meter: q('[data-meter]'), segbars: q('.segbar'), alertGroups: q('[data-alert]'), leanRot: q('[data-lean-rot]'), engine: q('[data-engine]'), uncal: q('[data-show="uncal"]'), modeIcon: q('[data-mode-icon]') };
}

function renderRide(tel) {
  if (tel.startButton) lastStartPressAt = performance.now();
  const rpm = tel.rpm ?? 0;
  const engine = link !== 'connected' || !lastPacketAt ? null
    : tel.rpm === undefined ? 'No data'
    : tel.startButton || (rpm < 500 && performance.now() - lastStartPressAt < 3000) ? 'Starting'
    : rpm >= 500 ? 'Running' : rpm > 0 ? 'Stopping' : 'Engine off';
  const fmt = (v, d = 0) => v === undefined || v === null ? '--' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const upper = v => (v ?? '--').toUpperCase();
  const leanKnown = calibration.leanCalibrated && tel.lean !== undefined;
  const values = {
    speed: fmt(tel.speed), rpm: fmt(tel.rpm), gear: tel.gear ?? '--',
    engine: engine ?? (link === 'connected' ? 'Waiting for data' : 'Not connected'),
    throttle: fmt(tel.throttle), brake: fmt(tel.frontBrakePct), rearBrake: fmt(tel.rearBrakePct), coolant: fmt(tel.coolant),
    rideMode: tel.rideMode ?? '--', leanDeg: leanKnown ? `${Math.round(Math.abs(tel.lean))}°` : '--', leanSide: !leanKnown ? '' : tel.lean < -1 ? 'LEFT' : tel.lean > 1 ? 'RIGHT' : 'UPRIGHT',
    traction: tel.traction ?? '--', abs: tel.absMode ?? '--', qs: tel.quickshifter === undefined ? '--' : tel.quickshifter ? 'On' : 'Off',
    tcTag: `[ TC ${upper(tel.traction)} ]`, absTag: `[ ABS ${upper(tel.absMode)} ]`, fuel: fmt(fuelLeft(), 1), range: fmt(rangeKm()), odo: fmt(tel.odometer)
  };
  const pct = {
    throttle: tel.throttle, brake: tel.frontBrakePct, rearBrake: tel.rearBrakePct,
    rpm: tel.rpm === undefined ? null : rpm / REV_MAX * 100,
    coolant: tel.coolant === undefined ? null : (tel.coolant - COOL_MIN) / (COOL_MAX - COOL_MIN) * 100,
    fuel: fuelLeft() / tankL() * 100
  };
  const alert = { brake: tel.frontBrakePct > 0, rearBrake: !!tel.rearBrake, traction: tel.traction === 'Off', abs: tel.absMode === 'Offroad', qs: tel.quickshifter === false,
    tcTag: tel.traction === 'Off', absTag: tel.absMode === 'Offroad', coolant: tel.coolant >= COOL_HOT, rpm: rpm >= REV_WARN, fuel: fuelLeft() / tankL() < FUEL_LOW };

  const el = rideElements();
  for (const node of el.bind) {
    const key = node.dataset.bind;
    if (node.textContent !== values[key]) node.textContent = values[key];
    node.classList.toggle('alert', !!alert[key]);
    if (key === 'gear') node.classList.toggle('neutral', tel.gear === 'N');
  }
  for (const node of el.meter) {
    const p = pct[node.dataset.meter];
    node.style.setProperty('--v', p === undefined || p === null ? 0 : clamp01(p / 100));
    node.closest('.inbar, .hairline')?.classList.toggle('active', !!alert[node.dataset.meter]);
  }
  for (const bar of el.segbars) {
    const p = pct[bar.dataset.kind], lit = p === undefined || p === null ? 0 : Math.round(clamp01(p / 100) * bar.children.length);
    [...bar.children].forEach((seg, i) => seg.classList.toggle('on', i < lit));
    bar.classList.toggle('limit', bar.dataset.kind === 'rpm' && rpm >= REV_WARN);
    bar.classList.toggle('low', bar.dataset.kind === 'fuel' && !!alert.fuel);
  }
  for (const g of el.alertGroups) g.classList.toggle('alert', !!alert[g.dataset.alert]);
  const tilt = leanKnown ? Math.max(-60, Math.min(60, tel.lean)).toFixed(1) : 0;
  for (const g of el.leanRot) g.setAttribute('transform', `rotate(${tilt} ${g.dataset.px} ${g.dataset.py})`);
  for (const node of el.engine) {
    node.dataset.state = engine ?? '';
    node.title = engine === 'No data' ? 'No engine frames: ignition off, or the reader lost power (the bike\'s USB socket switches off while cranking)' : '';
  }
  for (const node of el.uncal) node.toggleAttribute('hidden', !!calibration.speedCalibrated); // works on SVG too
  for (const node of el.modeIcon) node.setAttribute('href', iconRef(RIDE_MODE_ICONS[tel.rideMode] ?? 'motorcycle'));

  const stage = shiftStage(rpm);
  document.body.classList.toggle('shift-1', stage === 1);
  document.body.classList.toggle('shift-2', stage === 2);
  for (const sweep of sweeps) {
    sweep.set((pct.rpm ?? 0) / 100);
    sweep.g.classList.toggle('limit', rpm >= REV_WARN);
  }

  engineRunning = engine === 'Running';
  renderMode(tel);
  renderStateScreen(tel, engine);
  renderAlert(tel);
}

// Each ride mode has its own cluster: colours, texture and layout come from [data-mode] in the stylesheet.
let splashTimer = 0;
function renderMode(tel) {
  const cluster = $('view-ride'), next = tel.rideMode;
  if (!next || cluster.dataset.mode === next) return;
  const first = !cluster.dataset.mode;
  cluster.dataset.mode = next;
  applyPalette();
  if (first) return; // No splash for the mode the bike was already in.
  const splash = $('mode-splash');
  $('splash-icon').setAttribute('href', iconRef(RIDE_MODE_ICONS[next] ?? 'motorcycle'));
  $('splash-name').textContent = next;
  $('splash-detail').textContent = [tel.traction && `Traction ${tel.traction.toLowerCase()}`, tel.absMode && `ABS ${tel.absMode}`].filter(Boolean).join(', ');
  splash.hidden = true; void splash.offsetWidth; splash.hidden = false; // restart the animation
  clearTimeout(splashTimer);
  splashTimer = setTimeout(() => { splash.hidden = true; }, 1700);
}

// Warnings sit over the tiles, never over the speed. Several can show at once, side by side.
let alertSignature = '';
function renderAlert(tel) {
  const alerts = [
    tel.coolant >= COOL_HOT && { tone: 'red', icon: 't-temp', text: `Engine hot ${Math.round(tel.coolant)} °C` },
    tel.killRun === false && { tone: 'red', icon: 't-kill', text: 'Kill switch on', detail: "Engine can't start" },
    tel.standUp === false && { tone: 'amber', icon: 't-stand', text: 'Side stand down' }
  ].filter(Boolean);
  const box = $('cluster-alert'), signature = JSON.stringify(alerts);
  box.hidden = !alerts.length;
  if (signature === alertSignature) return;
  alertSignature = signature;
  box.innerHTML = alerts.map(a => `<div class="alert-item" data-tone="${a.tone}">${icon(a.icon)}<span>${a.text}${a.detail ? `<small>${a.detail}</small>` : ''}</span></div>`).join('');
}

// Full screens for the states where the cluster has nothing to show. They only report what the bike says.
const SCREENS = {
  idle: { icon: 'bluetooth', title: 'Not connected', text: 'Switch the ignition on, then connect to the reader.', action: true },
  connecting: { icon: 'bluetooth', title: 'Connecting…', text: 'Looking for the reader. Keep the phone within a few metres of the bike.' },
  reconnecting: { icon: 'bluetooth-slash', tone: 'amber', title: 'Signal lost, reconnecting…', text: 'The reader stopped answering. It reconnects by itself once it is in range and powered again.' },
  waiting: { icon: 'broadcast', title: 'Waiting for the bike', text: 'The reader is connected but sees no engine data. Switch the ignition on.', dismiss: true },
};
let shownScreen = null, dismissedScreen = null, screenSignature = '';

function screenFor(tel, engine) {
  if (link !== 'connected') return link;
  if (!lastPacketAt || tel.rpm === undefined) return 'waiting';
  return null; // The kill switch and side stand show as banners on the cluster, not as screens.
}

function renderStateScreen(tel, engine) {
  const key = screenFor(tel, engine);
  if (key !== shownScreen) { shownScreen = key; dismissedScreen = null; }
  const screen = $('state-screen'), def = SCREENS[key];
  screen.hidden = !def || key === dismissedScreen;
  if (screen.hidden) { screenSignature = ''; return; }
  const checks = [];
  const trip = i => trips[i].stats().distance;
  const facts = [['Odometer', tel.odometer, 0, 'km'], ['Coolant', tel.coolant, 0, '°C'], ['Trip 1', trip(0), 1, 'km'], ['Trip 2', trip(1), 1, 'km']];
  const signature = JSON.stringify([key, link, demo, checks, facts.map(([, v, d]) => v === undefined || v === null ? null : Number(v).toFixed(d))]);
  if (signature === screenSignature) return;
  screenSignature = signature;
  screen.dataset.tone = def.tone ?? '';
  $('state-icon').setAttribute('href', iconRef(def.icon));
  $('state-title').textContent = def.title;
  $('state-text').textContent = def.text;
  $('state-checks').hidden = !checks.length;
  $('state-checks').innerHTML = checks.map(c => `<li class="${c.ok ? 'ok' : 'warn'}">${icon(c.ok ? 'check-circle' : 'warning-circle')}<span>${c.label}</span><b>${c.value}</b></li>`).join('');
  const live = key !== 'idle' && key !== 'connecting';
  $('state-facts').hidden = !live;
  $('state-facts').innerHTML = facts.map(([label, v, d, unit]) => `<div><dt>${label}</dt><dd>${v === undefined || v === null ? '--' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}<small>${unit}</small></dd></div>`).join('');
  $('state-action').hidden = !def.action;
  $('state-action').textContent = demo ? 'Start demo' : 'Connect';
  $('state-dismiss').hidden = !def.dismiss;
}

// Tiles: small widgets under the cluster. The rider picks which ones and in what order.
const iconRef = name => `#${name.startsWith('t-') ? name : `i-${name}`}`;
const icon = name => `<svg class="i" aria-hidden="true"><use href="${iconRef(name)}"/></svg>`;
const RIDE_MODE_ICONS = { Street: 'road-horizon', Rain: 'cloud-rain', Offroad: 'mountains' };
const tripStat = (i, key) => () => trips[i].stats()[key];
const WIDGETS = {
  economyNow: { icon: 'gas-pump', label: 'Economy now', unit: 'km/L', digits: 1, trips: true, get: t => t.instantEconomy },
  fuelNow: { icon: 'drop', label: 'Fuel use now', unit: 'L/h', digits: 2, trips: true, get: t => t.fuelRate },
  trip1: { icon: 'path', label: 'Trip 1', unit: 'km', digits: 1, trips: true, get: tripStat(0, 'distance') },
  trip1Economy: { icon: 'gas-pump', label: 'Trip 1 average', unit: 'km/L', digits: 1, trips: true, get: tripStat(0, 'economy') },
  trip1Fuel: { icon: 'drop', label: 'Trip 1 fuel used', unit: 'L', digits: 2, trips: true, get: tripStat(0, 'fuelL') },
  trip2: { icon: 'path', label: 'Trip 2', unit: 'km', digits: 1, trips: true, get: tripStat(1, 'distance') },
  trip2Economy: { icon: 'gas-pump', label: 'Trip 2 average', unit: 'km/L', digits: 1, trips: true, get: tripStat(1, 'economy') },
  trip2Fuel: { icon: 'drop', label: 'Trip 2 fuel used', unit: 'L', digits: 2, trips: true, get: tripStat(1, 'fuelL') },
  fuelLeft: { icon: 'gas-pump', label: 'Fuel left (est.)', unit: 'L', digits: 1, trips: true, get: () => fuelLeft(), bar: () => fuelLeft() / tankL() * 100, alert: () => fuelLeft() / tankL() < FUEL_LOW },
  odometer: { icon: 'road-horizon', label: 'Odometer', unit: 'km', get: t => t.odometer },
  coolant: { icon: 'thermometer-simple', label: 'Coolant', unit: '°C', get: t => t.coolant, alert: v => v >= COOL_HOT, bar: v => (v - COOL_MIN) / (COOL_MAX - COOL_MIN) * 100 },
  throttle: { icon: 'gauge', label: 'Throttle', unit: '%', get: t => t.throttle, bar: v => v },
  frontBrake: { icon: 'hand-grabbing', label: 'Front brake', unit: '%', get: t => t.frontBrakePct, bar: v => v, alert: v => v > 0 },
  rearBrake: { icon: 'sneaker-move', label: 'Rear brake', unit: '%', get: t => t.rearBrakePct, bar: v => v, alert: v => v > 0 },
  rideMode: { icon: v => RIDE_MODE_ICONS[v] ?? 'motorcycle', label: 'Ride mode', get: t => t.rideMode },
  traction: { icon: 't-tc', label: 'Traction control', get: t => t.traction, alert: v => v === 'Off' },
  quickshifter: { icon: 't-qs', label: 'Quickshifter', get: t => t.quickshifter === undefined ? undefined : t.quickshifter ? 'On' : 'Off', alert: v => v === 'Off' },
  abs: { icon: 't-abs', label: 'ABS', get: t => t.absMode, alert: v => v === 'Offroad' },
  topSpeed: { icon: 'flag-checkered', label: 'Top speed', unit: 'km/h', get: () => session.speed },
  lean: { icon: 'crosshair-simple', label: 'Lean', unit: '°', get: t => t.lean === undefined ? undefined : Math.abs(t.lean) }
};
const DEFAULT_TILES = ['economyNow', 'trip1', 'odometer', 'coolant'], MAX_TILES = 8;
let tiles = load(keys.tiles, DEFAULT_TILES).filter(w => WIDGETS[w]).slice(0, MAX_TILES);
let tileSignature = '';

function buildTiles() {
  tileSignature = tiles.join();
  $('tiles').replaceChildren(...tiles.map(key => {
    const w = WIDGETS[key];
    const tile = document.createElement(w.trips ? 'button' : 'div');
    tile.className = `tile${w.trips ? ' link' : ''}`;
    if (w.trips) { tile.type = 'button'; tile.title = 'Open trip details'; }
    const label = document.createElement('span'); label.className = 'tile-label';
    label.innerHTML = icon(typeof w.icon === 'string' ? w.icon : 'motorcycle');
    label.append(w.label);
    const value = document.createElement('span'); value.className = 'tile-value';
    const figure = document.createElement('b');
    value.append(figure);
    if (w.unit) { const unit = document.createElement('small'); unit.textContent = w.unit; value.append(unit); }
    tile.append(label, value);
    if (w.bar) { const bar = document.createElement('i'); bar.className = 'tile-bar'; tile.append(bar); }
    return tile;
  }));
}

function renderTiles(tel) {
  if (tiles.join() !== tileSignature) buildTiles();
  [...$('tiles').children].forEach((tile, i) => {
    const w = WIDGETS[tiles[i]], v = w.get(tel);
    const empty = v === undefined || v === null;
    tile.querySelector('b').textContent = empty ? '--' : typeof v === 'number' ? v.toLocaleString(undefined, { minimumFractionDigits: w.digits ?? 0, maximumFractionDigits: w.digits ?? 0 }) : v;
    tile.classList.toggle('alert', !empty && !!w.alert?.(v));
    if (typeof w.icon === 'function') tile.querySelector('use').setAttribute('href', iconRef(w.icon(v)));
    if (w.bar) tile.querySelector('.tile-bar').style.setProperty('--v', empty ? 0 : Math.max(0, Math.min(1, w.bar(v) / 100)));
  });
}

function fillTileSlots() {
  $('tile-slots').replaceChildren(...tiles.map((key, i) => {
    const li = document.createElement('li');
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Tile ${i + 1}`);
    select.append(...Object.entries(WIDGETS).map(([k, w]) => new Option(w.label, k, false, k === key)));
    select.addEventListener('change', () => { tiles[i] = select.value; saveTiles(); });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'quiet small'; remove.innerHTML = `${icon('trash')}Remove`;
    remove.disabled = tiles.length <= 1;
    remove.addEventListener('click', () => { tiles.splice(i, 1); saveTiles(); fillTileSlots(); });
    li.append(select, remove);
    return li;
  }));
  $('tiles-add').disabled = tiles.length >= MAX_TILES;
}
function saveTiles() { save(keys.tiles, tiles); }

// The trip screen sits behind the ride display.
function renderTrips(tel) {
  $('max-speed').textContent = session.speed;
  $('max-rpm').textContent = session.rpm.toLocaleString();
  $('max-lean').textContent = calibration.leanCalibrated ? `${session.lean}°` : '--';
  show('fuel-rate', tel.fuelRate, 2);
  show('fuel-inst', tel.instantEconomy, 1);
  $('fuel-flag').hidden = !!calibration.fuelCalibrated;
  trips.forEach((trip, i) => {
    const s = trip.stats(), box = $(`trip-${i}`);
    const put = (f, v, digits) => { box.querySelector(`[data-f="${f}"]`).textContent = v === null || v === undefined ? '--' : Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }); };
    put('distance', s.distance, 1); put('economy', s.economy, 1); put('rate', s.rate, 2); put('fuel', s.fuelL, 2);
    put('per100', s.economy ? 100 / s.economy : null, 2);
    put('speed', s.runS >= 60 && s.distance ? s.distance / (s.runS / 3600) : null, 0);
    box.querySelector('[data-f="time"]').textContent = s.runS < 60 ? `${Math.round(s.runS)} s` : `${Math.floor(s.runS / 3600) ? `${Math.floor(s.runS / 3600)} h ` : ''}${Math.floor(s.runS / 60) % 60} min`;
  });
}

function renderClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ===========================================================================
// Bus
// ===========================================================================
const knownAs = new Map();
for (const s of KTM_MAP) knownAs.set(`S:D:${s.id}`, [...(knownAs.get(`S:D:${s.id}`) || []), s.label]);
function labelsFor(key) {
  const own = signals.filter(s => frameKey({ ...s, remote: false }) === key).map(s => s.name);
  return [...new Set([...(knownAs.get(key) || []), ...own])].join(', ');
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderBus() {
  const now = deviceNow();
  const filter = $('filter').value.trim().replace(/^0x/i, '').toUpperCase();
  const onlyUnknown = $('hide-known').checked;
  let hidden = 0;
  const list = [...rows().entries()].filter(([, r]) => hex(r.frame.id, r.frame.extended ? 8 : 3).includes(filter))
    .filter(([key]) => { const known = !!labelsFor(key); if (onlyUnknown && known) hidden++; return !(onlyUnknown && known); })
    .sort(([, a], [, b]) => a.frame.extended - b.frame.extended || a.frame.id - b.frame.id);
  const body = document.createDocumentFragment();
  for (const [key, r] of list) {
    const f = r.frame, age = Math.max(0, (now - f.us) / 1000);
    const tr = document.createElement('tr');
    if (age > 2000) tr.className = 'stale';
    const data = document.createElement('td');
    data.className = 'bytes';
    if (f.remote) data.textContent = 'remote request';
    f.data.forEach((byte, i) => {
      const b = document.createElement('span');
      if (now - r.changedAt[i] < 700000) b.className = 'changed';
      b.textContent = hex(byte, 2);
      data.append(b);
    });
    tr.append(cell(idLabel(f.id, f.extended), 'id'), data, cell(r.count.toLocaleString(), 'num'),
      cell(r.interval === null ? '--' : `${r.interval.toFixed(r.interval < 10 ? 1 : 0)} ms`, 'num'),
      cell(age > 1000 ? `${(age / 1000).toFixed(1)} s` : `${Math.round(age)} ms`, 'num'), cell(labelsFor(key), 'known'));
    body.append(tr);
  }
  $('frames').replaceChildren(body);
  $('hidden-count').textContent = onlyUnknown && hidden ? `(${hidden} known hidden)` : '';
  $('frames-empty').hidden = list.length > 0;
  $('frames-empty').textContent = store.rows.size ? (onlyUnknown && hidden ? 'Every ID seen so far is already known. Change something on the bike.' : 'No IDs match the filter.') : 'No frames yet. Connect the reader and switch the ignition on.';
  $('received').textContent = (status?.received ?? 0).toLocaleString();
  $('rate').textContent = rate.toLocaleString();
  $('unique').textContent = store.rows.size;
  const losses = (status?.driverMissed ?? 0) + (status?.driverOverruns ?? 0) + (status?.linkDropped ?? 0) + (status?.rawSkipped ?? 0);
  $('losses').textContent = losses.toLocaleString();
  $('losses').title = status ? `CAN driver missed ${status.driverMissed + status.driverOverruns}, Bluetooth dropped ${status.linkDropped} packets, raw frames skipped ${status.rawSkipped}, bus errors ${status.busErrors}` : '';
  $('export').disabled = store.size === 0;
  $('buffer-detail').textContent = `${store.size.toLocaleString()} records kept for export${store.evicted ? `, ${store.evicted.toLocaleString()} oldest dropped` : ''}. Marked bytes changed in the last 0.7 s.`;
}

function syncControls() {
  const live = link === 'connected';
  $('apply').disabled = !live;
  $('stop').disabled = !live || !status?.running;
  $('hunt-baseline').disabled = !live || hunting;
  $('hunt-action').disabled = !live || hunting || !baselineDone;
  $('device-detail').textContent = !live ? 'Connect to the reader to control capture.'
    : status?.error ? `Reader error: ${status.error}. Check wiring and bus speed.`
    : !status?.running ? 'Capture is stopped.'
    : status.lastFrameUs && status.uptimeUs - status.lastFrameUs > 2e6 ? `Listening at ${status.bitrate / 1000} kbit/s, but no frames. Is the ignition on?`
    : `Listening at ${status?.bitrate / 1000} kbit/s on GPIO5, listen-only.${status?.busErrors ? ` ${status.busErrors} bus errors: check the bus speed.` : ''}`;
}

// ===========================================================================
// Find an ID
// ===========================================================================
const TARGETS = [
  { key: 'indicator-left', name: 'Left indicator', action: 'Switch the left indicator on and off three times.' },
  { key: 'indicator-right', name: 'Right indicator', action: 'Switch the right indicator on and off three times.' },
  { key: 'high-beam', name: 'High beam', action: 'Switch high beam on before you press record and keep it on.', held: true },
  { key: 'horn', name: 'Horn', action: 'Tap the horn five or six times.' },
  { key: 'rear-brake', name: 'Rear brake', action: 'Press and release the rear brake pedal several times.' },
  { key: 'front-brake-switch', name: 'Front brake switch', action: 'Pull and release the front brake lever several times. Pressure is already on 0x290; this looks for the light switch.' },
  { key: 'abs-mode', name: 'ABS mode', action: 'Change the ABS mode in the dash menu and back, twice.' },
  { key: 'menu-buttons', name: 'Handlebar menu buttons', action: 'Press one menu button repeatedly. Repeat the search for each button.' },
  { key: 'qs-setting', name: 'Quickshifter on/off setting', action: 'Open the dash menu and switch the quickshifter off, then on, then off and on again. Leave the bike stationary.' },
  { key: 'hazards', name: 'Hazard lights', action: 'Switch the hazards on and off twice.' },
  { key: 'other', name: 'Something else', action: 'Operate the control repeatedly, or hold it for the whole recording if it stays on.' }
];
let hunting = false, baselineDone = false, liveCandidates = [];

function fillTargets() {
  $('hunt-target').replaceChildren(...TARGETS.map(t => new Option(t.name, t.key)));
  const sync = () => {
    const t = TARGETS.find(x => x.key === $('hunt-target').value);
    $('hunt-how').textContent = t.held ? 'A held control: keep it on for the whole second recording.' : 'A control you switch: work it several times during the second recording.';
    $('hunt-action-hint').textContent = `${t.action} 8 seconds.`;
    baselineDone = false; $('baseline-state').textContent = ''; $('action-state').textContent = '';
    $('hunt-results-wrap').hidden = true;
    syncControls();
  };
  $('hunt-target').addEventListener('change', sync);
  sync();
}

function record(phase, seconds, label) {
  hunting = true; syncControls();
  hunter.begin(phase);
  if (demo && phase === 'action') transport.held = $('hunt-target').value;
  let left = seconds;
  $(label).textContent = `${left} s`;
  const timer = setInterval(() => {
    left--;
    $(label).textContent = left > 0 ? `${left} s` : 'Done';
    if (left > 0) return;
    clearInterval(timer);
    hunter.end();
    if (demo) transport.held = null;
    hunting = false;
    if (phase === 'baseline') baselineDone = true;
    else showCandidates();
    syncControls();
  }, 1000);
}

function showCandidates() {
  const target = TARGETS.find(t => t.key === $('hunt-target').value);
  liveCandidates = hunter.results(12);
  const body = document.createDocumentFragment();
  liveCandidates.forEach((c, n) => {
    const tr = document.createElement('tr');
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'quiet small'; save.textContent = 'Save';
    save.addEventListener('click', () => openSignalDialog({ name: target.key === 'other' ? '' : target.name, id: c.id, extended: c.extended,
      start: c.byte ?? 0, length: 1, mask: c.mask, unit: c.mask ? 'on/off' : '' }));
    if (c.byte === null) save.disabled = true;
    const live = cell('--', 'num live');
    live.dataset.n = n;
    tr.append(cell(idLabel(c.id, c.extended), 'id'), cell(c.byte === null ? 'all' : `D${c.byte}`),
      cell(c.mask ? maskLabel(c.mask) : c.byte === null ? '--' : 'whole byte'), cell(c.detail), live, document.createElement('td'));
    tr.lastChild.append(save);
    body.append(tr);
  });
  $('hunt-results').replaceChildren(body);
  $('hunt-none').hidden = liveCandidates.length > 0;
  $('hunt-results-wrap').hidden = false;
}

function renderFind() {
  document.querySelectorAll('#hunt-results .live').forEach(td => {
    const c = liveCandidates[td.dataset.n];
    const f = rows().get(c.key)?.frame;
    if (!f || c.byte === null) { td.textContent = f ? 'present' : '--'; return; }
    const byte = f.data[c.byte];
    td.textContent = c.mask ? ((byte & c.mask) ? 'on' : 'off') : hex(byte, 2);
  });
}

// ===========================================================================
// Signals and calibration
// ===========================================================================
const SOURCE = { confirmed: ['Confirmed on your bike', 'confirmed'], capture: ['From your capture, check vs dash', 'capture'],
  ktm: ['KTM family, check it', 'ktm'], calibrate: ['Needs calibration', 'calibrate'], absent: ['ID not sent on your bike', 'absent'] };
function buildMap() {
  $('ktm-map').replaceChildren(...KTM_MAP.map(s => {
    const tr = document.createElement('tr');
    const badge = document.createElement('span');
    const [text, cls] = SOURCE[s.source];
    badge.className = `badge ${cls}`; badge.textContent = text;
    const live = cell('--', 'num'); live.dataset.key = s.key;
    tr.append(cell(s.label), cell(idLabel(s.id, false), 'id'), cell(s.where), cell(s.rule), live, document.createElement('td'));
    tr.lastChild.append(badge);
    return tr;
  }));
}

const formatLive = v => v === undefined || v === null ? '--' : typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : v;
let signalSignature = '';
function renderPalettePicker() {
  $('palette-picker').innerHTML = Object.keys(PALETTE_DEFAULT).map(mode => `<fieldset class="palette-row">
    <legend>${icon(RIDE_MODE_ICONS[mode])}${mode}</legend>
    ${PALETTES.map(p => `<label class="swatch" data-palette="${p.id}"><input type="radio" name="palette-${mode}" value="${p.id}"${palettes[mode] === p.id ? ' checked' : ''}><span class="dot"></span>${p.name}</label>`).join('')}
  </fieldset>`).join('');
}

function fillShiftForm() {
  $('shift-on').checked = shift.on;
  $('shift-1').value = shift.stage1;
  $('shift-2').value = shift.stage2;
  $('shift-state').textContent = shift.on
    ? `On: orange frame from ${shift.stage1.toLocaleString()} rpm, full orange screen from ${shift.stage2.toLocaleString()} rpm.`
    : 'Off.';
}

// Rear-view bike that leans to the measured angle: left of the screen is the rider's left, so it matches looking at the bike from behind.
const leanMax = { left: 0, right: 0 };
function renderLean(tel) {
  const lean = tel.lean, shown = lean === undefined ? 0 : Math.max(-60, Math.min(60, lean));
  const rad = shown * Math.PI / 180;
  $('lean-bike').setAttribute('transform', `rotate(${shown.toFixed(1)} 180 214)`);
  $('lean-tip').setAttribute('cx', (180 + 168 * Math.sin(rad)).toFixed(1));
  $('lean-tip').setAttribute('cy', (214 - 168 * Math.cos(rad)).toFixed(1));
  $('lean-tip').style.visibility = lean === undefined ? 'hidden' : 'visible';
  if (lean !== undefined) { leanMax.left = Math.max(leanMax.left, -lean); leanMax.right = Math.max(leanMax.right, lean); }
  $('lean-readout').textContent = lean === undefined ? '--' : Math.abs(lean) < 1 ? 'Upright' : `${Math.abs(lean).toFixed(0)}° ${lean < 0 ? 'left' : 'right'}`;
  $('lean-extremes').textContent = `Most left ${Math.round(leanMax.left)}° · most right ${Math.round(leanMax.right)}°${calibration.leanCalibrated ? '' : ' · scale not calibrated'}`;
}

function renderSignals() {
  const tel = telemetry();
  document.querySelectorAll('#ktm-map [data-key]').forEach(td => { td.textContent = formatLive(tel[td.dataset.key]); });
  $('cal-speed-state').textContent = calibration.speedCalibrated ? `Calibrated: 1 raw step = ${calibration.speedScale.toPrecision(4)} km/h.` : `Not calibrated. Using a guess of ${DEFAULT_CALIBRATION.speedScale} km/h per raw step.`;
  $('cal-fuel-state').textContent = `${calibration.fuelCalibrated ? 'Calibrated' : 'Not calibrated, using a guess'}: ${(calibration.fuelScale ?? DEFAULT_CALIBRATION.fuelScale).toPrecision(3)} L/h per step. Trip 2 has counted ${trips[1].fuelL.toFixed(2)} L, so about ${fuelLeft().toFixed(1)} of ${tankL()} L is left.`;
  if (document.activeElement !== $('cal-tank-value')) $('cal-tank-value').value = tankL();
  if (!$('cal-brake').disabled) $('cal-brake-state').textContent = `100 % = raw ${(calibration.brakeMax ?? DEFAULT_CALIBRATION.brakeMax).toLocaleString()}. Raw now: ${tel.frontBrake?.toLocaleString() ?? '--'}.`;
  $('cal-lean-state').textContent = calibration.leanCalibrated ? `Calibrated: zero at raw ${calibration.leanZero}, ${calibration.leanScale.toPrecision(3)}° per step.` : `Not calibrated. Raw lean now: ${tel.leanRaw ?? '--'}.`;

  renderLean(tel);

  const signature = JSON.stringify(signals);
  if (signature !== signalSignature) {
    signalSignature = signature;
    $('signals').replaceChildren(...signals.map((s, i) => {
      const card = document.createElement('article');
      card.className = 'signal';
      const head = document.createElement('header');
      const name = document.createElement('strong'); name.textContent = s.name;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'quiet small'; remove.textContent = 'Delete'; remove.dataset.remove = i;
      head.append(name, remove);
      const value = document.createElement('div'); value.className = 'signal-value';
      const meta = document.createElement('p'); meta.className = 'hint';
      meta.textContent = `${idLabel(s.id, s.extended)} · D${s.start}${s.length > 1 ? `-D${s.start + s.length - 1}` : ''}${s.mask ? ` · bits ${maskLabel(s.mask)}` : ''} · ×${s.scale} ${s.offset ? `+ ${s.offset}` : ''}`;
      card.append(head, value, meta);
      return card;
    }));
    $('signals-empty').hidden = signals.length > 0;
  }
  const now = deviceNow();
  signals.forEach((s, i) => {
    const f = rows().get(frameKey({ ...s, remote: false }))?.frame;
    const v = f && now - f.us < 2e6 ? decodeSignal(f, s) : null;
    const el = $('signals').children[i]?.querySelector('.signal-value');
    if (el) el.textContent = v === null ? '--' : `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${s.unit}`;
  });
}

function openSignalDialog(prefill = {}) {
  const form = $('signal-form');
  form.reset();
  $('signal-error').textContent = '';
  if (prefill.name !== undefined) $('signal-name').value = prefill.name;
  if (prefill.id !== undefined) $('signal-id').value = hex(prefill.id, prefill.extended ? 8 : 3);
  if (prefill.extended !== undefined) $('signal-format').value = String(prefill.extended);
  if (prefill.start !== undefined) $('signal-start').value = prefill.start;
  if (prefill.length !== undefined) $('signal-length').value = prefill.length;
  $('signal-mask').value = prefill.mask ? maskLabel(prefill.mask) : '';
  if (prefill.unit !== undefined) $('signal-unit').value = prefill.unit;
  $('signal-dialog').showModal();
}

function wheelRaw() {
  return decodeKtm(store.rows, calibration, deviceNow()).rearWheelRaw ?? null;
}

// ===========================================================================
// Wiring
// ===========================================================================
// A stray tap must not wipe a trip: the first tap arms the button, a second within 3 s confirms.
function confirmTap(button, action) {
  const text = button.lastChild;
  if (button.dataset.armed) {
    clearTimeout(button.armTimer);
    delete button.dataset.armed;
    text.textContent = button.dataset.label;
    action();
    return;
  }
  button.dataset.label ??= text.textContent;
  button.dataset.armed = 'true';
  text.textContent = 'Tap again';
  button.armTimer = setTimeout(() => { delete button.dataset.armed; text.textContent = button.dataset.label; }, 3000);
}

const VIEWS = ['ride', 'trips', 'bus', 'find', 'signals'];
function setView(next) {
  view = next;
  history.replaceState(null, '', `#${next}`); // A reload, or a saved link, opens the same page.
  const key = next === 'trips' ? 'ride' : next; // Trips is a screen behind Ride.
  document.querySelectorAll('.view-btn').forEach(b => b.dataset.view === key ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== next;
  render();
}

const KEYS_SHOW_MS = 4000;
function syncKeys() {
  const auto = view === 'ride' && engineRunning;
  if (auto === document.body.classList.contains('keys-auto')) return;
  document.body.classList.toggle('keys-auto', auto);
  document.body.classList.remove('keys-shown');
}
function showKeys() {
  if (!document.body.classList.contains('keys-auto')) return;
  document.body.classList.add('keys-shown');
  clearTimeout(keysTimer);
  keysTimer = setTimeout(() => document.body.classList.remove('keys-shown'), KEYS_SHOW_MS);
}

function render() {
  const tel = telemetry();
  renderLamps(tel);
  syncKeys(); // uses the engine state from the previous frame
  if (!paused) {
    session.speed = Math.max(session.speed, Math.round(tel.speed ?? 0));
    session.rpm = Math.max(session.rpm, tel.rpm ?? 0);
    if (calibration.leanCalibrated) session.lean = Math.max(session.lean, Math.round(Math.abs(tel.lean ?? 0)));
  }
  if (view !== 'ride') document.body.classList.remove('shift-1', 'shift-2'); // the shift light only covers the Ride screen
  if (view === 'ride') { renderRide(tel); renderTiles(tel); }
  else if (view === 'trips') renderTrips(tel);
  else if (view === 'bus') renderBus();
  else if (view === 'find') renderFind();
  else renderSignals();
}

let lastFrameAt = 0, lastTripSave = 0;
function loop(t) {
  if (t - lastFrameAt > 45) { if (!paused || view !== 'bus') render(); lastFrameAt = t; }
  if (t - lastTripSave > 5000) { save(keys.trips, trips); lastTripSave = t; renderClock(); }
  requestAnimationFrame(loop);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-text').textContent = theme === 'dark' ? 'Day' : 'Night';
  $('theme-icon').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  document.querySelector('meta[name=theme-color]').content = theme === 'dark' ? '#000000' : '#f3f6f7';
}

document.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('connect').addEventListener('click', toggleConnection);
$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  save(keys.theme, next);
});
$('tiles').addEventListener('click', e => { if (e.target.closest('.tile.link')) setView('trips'); });
$('open-trips').addEventListener('click', () => setView('trips'));
$('state-action').addEventListener('click', toggleConnection);
document.addEventListener('pointerdown', showKeys);
document.querySelector('.keys').addEventListener('focusin', showKeys);
$('state-dismiss').addEventListener('click', () => { dismissedScreen = shownScreen; });
$('trips-back').addEventListener('click', () => setView('ride'));
$('edit-tiles').addEventListener('click', () => { fillTileSlots(); $('tiles-dialog').showModal(); });
$('tiles-add').addEventListener('click', () => {
  tiles.push(Object.keys(WIDGETS).find(k => !tiles.includes(k)) ?? 'odometer');
  saveTiles(); fillTileSlots();
});
$('tiles-default').addEventListener('click', () => { tiles = [...DEFAULT_TILES]; saveTiles(); fillTileSlots(); });
$('reset-session').addEventListener('click', e => confirmTap(e.currentTarget, () => { Object.assign(session, { speed: 0, rpm: 0, lean: 0 }); }));

$('bitrate').addEventListener('change', () => { $('bitrate').dataset.edited = 'true'; });
$('capture-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await transport.send(commands.start(Number($('bitrate').value)));
    delete $('bitrate').dataset.edited;
    notice('');
  } catch (err) { notice(`Could not start capture: ${err.message}`); }
});
$('stop').addEventListener('click', () => transport.send(commands.stop()).catch(err => notice(`Could not stop capture: ${err.message}`)));
$('stream-mode').addEventListener('change', () => {
  if (link !== 'connected') return;
  transport.send(commands.mode($('stream-mode').value === 'raw')).catch(err => notice(`Could not change mode: ${err.message}`));
});
$('pause').addEventListener('click', () => {
  paused = !paused;
  frozenRows = paused ? new Map(store.rows) : null;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
});
$('hide-known').checked = load(keys.hideKnown, true);
$('hide-known').addEventListener('change', () => { save(keys.hideKnown, $('hide-known').checked); renderBus(); });
$('clear').addEventListener('click', () => { store.clear(); frozenRows = paused ? new Map() : null; });
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([toCsv(store.frames())], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `adv390-can-${new Date().toISOString().replace(/[:.]/g, '-')}${status?.mode === 'raw' ? '' : '-latest-per-id'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('hunt-baseline').addEventListener('click', () => record('baseline', 5, 'baseline-state'));
$('hunt-action').addEventListener('click', () => record('action', 8, 'action-state'));

$('cal-speed').addEventListener('submit', e => {
  e.preventDefault();
  const raw = wheelRaw();
  if (!raw) { notice('The rear wheel is not turning in the data (0x12D). Spin it steadily, or ride at a steady speed, then try again.'); return; }
  calibration = { ...calibration, speedScale: Number($('cal-speed-value').value) / raw, speedCalibrated: true };
  save(keys.calibration, calibration);
  notice('Speed calibrated against your speedometer. Speedometers read a few percent high, so this matches the dash rather than GPS.');
});
$('lean-max-reset').addEventListener('click', () => { leanMax.left = leanMax.right = 0; });
$('cal-lean-zero').addEventListener('click', () => {
  const tel = decodeKtm(store.rows, calibration, deviceNow());
  if (tel.leanRaw === undefined) { notice('No lean data yet (0x12F). Connect with the ignition on.'); return; }
  calibration = { ...calibration, leanZero: tel.leanRaw };
  save(keys.calibration, calibration);
  notice(`Upright set at raw ${tel.leanRaw}. Now lean the bike to a known angle and enter it.`);
});
$('cal-brake').addEventListener('click', () => {
  let max = 0, left = 5;
  $('cal-brake').disabled = true;
  const sample = setInterval(() => { max = Math.max(max, decodeKtm(store.rows, calibration, deviceNow()).frontBrake ?? 0); }, 30);
  const tick = setInterval(() => {
    $('cal-brake-state').textContent = `${--left} s`;
    if (left > 0) return;
    clearInterval(sample); clearInterval(tick);
    $('cal-brake').disabled = false;
    if (max < 2000) { notice('The brake reading barely rose. Squeeze the lever hard for the whole 5 seconds, then try again.'); return; }
    calibration = { ...calibration, brakeMax: max };
    save(keys.calibration, calibration);
    notice(`Full squeeze set at raw ${max.toLocaleString()}. The dashboard now shows front brake as a percentage of that.`);
  }, 1000);
  $('cal-brake-state').textContent = `${left} s`;
});
document.querySelectorAll('[data-reset-trip]').forEach(button => button.addEventListener('click', () => confirmTap(button, () => {
  const i = Number(button.dataset.resetTrip);
  trips[i].reset();
  save(keys.trips, trips);
  notice(`Trip ${i + 1} reset.`);
})));
$('shift-form').addEventListener('submit', e => {
  e.preventDefault();
  const stage1 = Number($('shift-1').value), stage2 = Number($('shift-2').value);
  if (stage2 <= stage1) { $('shift-state').textContent = 'Stage 2 must be higher than stage 1. Raise stage 2 or lower stage 1.'; return; }
  shift = { on: $('shift-on').checked, stage1, stage2 };
  save(keys.shift, shift);
  fillShiftForm();
  notice(shift.on ? `Shift light saved: orange frame from ${stage1.toLocaleString()} rpm, full orange screen from ${stage2.toLocaleString()} rpm.` : 'Shift light switched off.');
});
$('palette-picker').addEventListener('change', e => {
  palettes[e.target.name.replace('palette-', '')] = e.target.value;
  save(keys.palette, palettes);
  applyPalette();
});
$('palette-default').addEventListener('click', () => {
  palettes = { ...PALETTE_DEFAULT };
  save(keys.palette, palettes);
  renderPalettePicker();
  applyPalette();
  notice('Cluster colours set back to the defaults: Street orange, Rain blue, Offroad yellow.');
});
$('shift-test').addEventListener('click', () => {
  shiftTestUntil = performance.now() + SHIFT_TEST_MS;
  setView('ride');
});
$('cal-tank').addEventListener('submit', e => {
  e.preventDefault();
  calibration = { ...calibration, tankL: Number($('cal-tank-value').value) };
  save(keys.calibration, calibration);
  notice(`Tank size saved: ${calibration.tankL} L. Fuel left counts down from this after each brim fill-up and Trip 2 reset.`);
});
$('cal-fuel').addEventListener('submit', e => {
  e.preventDefault();
  const measured = trips[1].fuelL;
  if (measured < 0.5) { notice('Trip 2 has measured less than half a litre so far. Ride a full tank with the dashboard connected, then calibrate at the fill-up.'); return; }
  const litres = Number($('cal-fuel-value').value);
  calibration = { ...calibration, fuelScale: (calibration.fuelScale ?? DEFAULT_CALIBRATION.fuelScale) * litres / measured, fuelCalibrated: true };
  save(keys.calibration, calibration);
  trips[1].fuelL = litres;
  trips[1].reset();
  save(keys.trips, trips);
  notice(`Fuel calibrated: the dashboard had counted ${measured.toFixed(2)} L, the pump says ${litres} L. Trip 2 has been reset for the next tank.`);
});
$('cal-lean').addEventListener('submit', e => {
  e.preventDefault();
  const tel = decodeKtm(store.rows, calibration, deviceNow());
  const steps = tel.leanRaw === undefined ? 0 : Math.abs(tel.leanRaw - calibration.leanZero);
  if (steps < 5) { notice('The lean reading has barely moved from zero. Lean the bike further, then try again.'); return; }
  calibration = { ...calibration, leanScale: Number($('cal-lean-value').value) / steps, leanCalibrated: true };
  save(keys.calibration, calibration);
  notice('Lean calibrated.');
});

$('add-signal').addEventListener('click', () => openSignalDialog());
$('close-dialog').addEventListener('click', () => $('signal-dialog').close());
$('signals').addEventListener('click', e => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  confirmTap(b, () => {
    signals.splice(Number(b.dataset.remove), 1);
    save(keys.signals, signals);
  });
});
$('signal-form').addEventListener('submit', e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    const signal = validateSignal({
      name: d.name.trim(), id: parseInt(d.id.replace(/^0x/i, ''), 16), extended: d.extended === 'true', signed: d.signed === 'true',
      start: Number(d.start), length: Number(d.length), endian: d.endian, scale: Number(d.scale), offset: Number(d.offset), unit: d.unit.trim(),
      ...(d.mask.trim() ? { mask: parseInt(d.mask.trim().replace(/^0x/i, ''), 16) } : {})
    });
    if (signals.length >= 48) throw Error('You can keep up to 48 signals. Delete one first.');
    signals.push(signal);
    save(keys.signals, signals);
    $('signal-dialog').close();
    notice(`Saved "${signal.name}". It now shows on the Signals view and labels its ID on the Bus view.`);
  } catch (err) { $('signal-error').textContent = err.message; }
});

applyTheme(load(keys.theme, null) ?? 'dark');
buildGauges();
document.querySelectorAll('.wide-svg').forEach(svg => new ResizeObserver(fitScreens).observe(svg));
fillShiftForm();
renderPalettePicker();
applyPalette();
renderClock();
buildMap();
fillTargets();
handlers.state('idle');
if (!window.NativeBle && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
if (VIEWS.includes(location.hash.slice(1))) setView(location.hash.slice(1));
requestAnimationFrame(loop);
