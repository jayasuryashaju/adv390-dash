export const hex = (value, width = 3) => value.toString(16).toUpperCase().padStart(width, '0');
export const frameKey = frame => `${frame.extended ? 'E' : 'S'}:${frame.remote ? 'R' : 'D'}:${frame.id}`;
export const idLabel = (id, extended) => `0x${hex(id, extended ? 8 : 3)}`;

// ---------------------------------------------------------------------------
// Bluetooth protocol (mirror of src/ble_link.cpp)
// ---------------------------------------------------------------------------
export const BLE = {
  name: 'ADV390-CAN',
  service: '4b544d39-0000-4a10-8c00-ca0000000001',
  frames: '4b544d39-0001-4a10-8c00-ca0000000001',
  status: '4b544d39-0002-4a10-8c00-ca0000000001',
  control: '4b544d39-0003-4a10-8c00-ca0000000001'
};

export const commands = {
  start: bitrate => new Uint8Array([0x01, bitrate & 0xff, (bitrate >> 8) & 0xff, (bitrate >> 16) & 0xff, (bitrate >>> 24) & 0xff]),
  stop: () => new Uint8Array([0x02]),
  mode: raw => new Uint8Array([0x03, raw ? 1 : 0])
};

// Device time is sent as the low 32 bits of a microsecond clock; this restores a monotonic value.
export function createClock() {
  let high = 0, last = null;
  return {
    unwrap(low) {
      if (last !== null && low < last && last - low > 0x80000000) high += 0x100000000;
      last = low;
      return high + low;
    },
    reset() { high = 0; last = null; }
  };
}

export function parseFramePacket(bytes, clock) {
  if (bytes.length < 1 || bytes[0] !== 0x01) throw Error('Unknown packet type');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = [];
  let at = 1;
  while (at + 11 <= bytes.length) {
    const raw = view.getUint32(at, true);
    const time = view.getUint32(at + 4, true);
    const count = view.getUint16(at + 8, true);
    const dlc = Math.min(8, bytes[at + 10]);
    const extended = (raw & 0x80000000) !== 0, remote = (raw & 0x40000000) !== 0;
    const length = remote ? 0 : dlc;
    if (at + 11 + length > bytes.length) throw Error('Truncated frame record');
    frames.push({ id: raw & 0x1fffffff, extended, remote, dlc, count: Math.max(1, count),
      us: clock ? clock.unwrap(time) : time, data: Array.from(bytes.subarray(at + 11, at + 11 + length)) });
    at += 11 + length;
  }
  return frames;
}

export function encodeFramePacket(frames) {
  const size = 1 + frames.reduce((n, f) => n + 11 + (f.remote ? 0 : f.data.length), 0);
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  bytes[0] = 0x01;
  let at = 1;
  for (const f of frames) {
    view.setUint32(at, (f.id | (f.extended ? 0x80000000 : 0) | (f.remote ? 0x40000000 : 0)) >>> 0, true);
    view.setUint32(at + 4, f.us % 0x100000000, true);
    view.setUint16(at + 8, f.count ?? 1, true);
    bytes[at + 10] = f.dlc ?? f.data.length;
    if (!f.remote) bytes.set(f.data, at + 11);
    at += 11 + (f.remote ? 0 : f.data.length);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Signal notebook: byte-aligned values, or one byte masked down to a flag/field
// ---------------------------------------------------------------------------
export function validateSignal(signal) {
  if (typeof signal.name !== 'string' || !signal.name.trim() || signal.name.length > 40) throw Error('Enter a name of 1-40 characters.');
  if (typeof signal.extended !== 'boolean' || typeof signal.signed !== 'boolean') throw Error('Invalid frame or number type.');
  if (!Number.isInteger(signal.id) || signal.id < 0 || signal.id > (signal.extended ? 0x1fffffff : 0x7ff)) throw Error('CAN ID is outside the selected frame format.');
  if (!Number.isInteger(signal.start) || !Number.isInteger(signal.length) || signal.start < 0 || signal.length < 1 || signal.length > 4 || signal.start + signal.length > 8) throw Error('Choose 1-4 bytes within payload bytes 0-7.');
  if (!['big', 'little'].includes(signal.endian)) throw Error('Choose a byte order.');
  if (!Number.isFinite(signal.scale) || !Number.isFinite(signal.offset)) throw Error('Scale and offset must be finite numbers.');
  if (typeof signal.unit !== 'string' || signal.unit.length > 16) throw Error('Unit must have at most 16 characters.');
  if (signal.mask !== undefined && signal.mask !== null) {
    if (!Number.isInteger(signal.mask) || signal.mask < 1 || signal.mask > 0xff) throw Error('Bit mask must be 0x01-0xFF.');
    if (signal.length !== 1) throw Error('A bit mask works on a single byte.');
  }
  return signal;
}

export function decodeSignal(frame, signal) {
  validateSignal(signal);
  if (!frame || frame.remote || frame.id !== signal.id || frame.extended !== signal.extended || frame.data.length < signal.start + signal.length) return null;
  if (signal.mask) {
    const shift = Math.log2(signal.mask & -signal.mask);
    return ((frame.data[signal.start] & signal.mask) >> shift) * signal.scale + signal.offset;
  }
  const bytes = frame.data.slice(signal.start, signal.start + signal.length);
  if (signal.endian === 'little') bytes.reverse();
  let raw = bytes.reduce((result, byte) => result * 256 + byte, 0);
  const range = 2 ** (8 * signal.length);
  if (signal.signed && raw >= range / 2) raw -= range;
  const value = raw * signal.scale + signal.offset;
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Capture store
// ---------------------------------------------------------------------------
export class CaptureStore {
  constructor(capacity = 50000, maxIds = 512) {
    this.capacity = capacity;
    this.maxIds = maxIds;
    this.clear();
  }
  clear() {
    this.buffer = new Array(this.capacity); this.head = 0; this.size = 0;
    this.evicted = 0; this.idEvictions = 0; this.rows = new Map(); this.seq = 0; this.total = 0;
  }
  ingest(frames) {
    for (const frame of frames) {
      frame.seq ??= ++this.seq;
      const count = frame.count ?? 1;
      this.total += count;
      if (this.size === this.capacity) this.evicted++;
      else this.size++;
      this.buffer[this.head] = frame; this.head = (this.head + 1) % this.capacity;
      const key = frameKey(frame), previous = this.rows.get(key);
      if (!previous && this.rows.size >= this.maxIds) {
        this.rows.delete(this.rows.keys().next().value); this.idEvictions++;
      }
      this.rows.set(key, { frame, count: (previous?.count ?? 0) + count,
        interval: previous && frame.us > previous.frame.us ? (frame.us - previous.frame.us) / 1000 / count : previous?.interval ?? null,
        changed: frame.data.map((byte, i) => !!previous && byte !== previous.frame.data[i]),
        changedAt: frame.data.map((byte, i) => !!previous && byte !== previous.frame.data[i] ? frame.us : previous?.changedAt?.[i] ?? 0) });
    }
  }
  frames() {
    return Array.from({ length: this.size }, (_, i) => this.buffer[(this.head - this.size + i + this.capacity) % this.capacity]);
  }
}

export function toCsv(frames) {
  return 'sequence,device_time_us,can_id,format,type,dlc,frames_represented,data_hex\r\n' + frames.map(f =>
    [f.seq, f.us, idLabel(f.id, f.extended), f.extended ? 'extended' : 'standard',
      f.remote ? 'remote' : 'data', f.dlc, f.count ?? 1, f.data.map(b => hex(b, 2)).join(' ')].join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// KTM decoding
// Source: blalor/ktm-can (verified on a 2020 690 Enduro R, derived from SuperDuke 1290 work).
// Confirmed on the owner's 390 Adventure: 0x120 rpm, throttle (D2) and kill switch (D3 0x08 set = RUN), 0x129
// gear and clutch, 0x290 front brake and brake light, 0x540 side stand (D3 0x01 set = up), 0x55A odometer.
// 0x540 coolant sits at D5-D6 on the 390 (capture 2026-10-25). 0x12B is not sent on this bike,
// so wheel speed and lean need new IDs (0x176 / 0x177 / 0x12F are the candidates).
// ---------------------------------------------------------------------------
export const signed12 = value => (value & 0x800 ? value - 0x1000 : value);
const be16 = (d, i) => (d[i] << 8) | d[i + 1];

export const KTM_MAP = [
  { key: 'rpm', label: 'Engine speed', id: 0x120, where: 'D0-D1', rule: 'Big-endian, rpm', source: 'confirmed' },
  { key: 'throttle', label: 'Throttle grip', id: 0x120, where: 'D2', rule: '0 closed - 253 fully open → 0-100 %', source: 'confirmed' },
  { key: 'throttleClosed', label: 'Throttle closed switch', id: 0x128, where: 'D2 bit 0x01', rule: '03 closed, 02 open', source: 'confirmed' },
  { key: 'startButton', label: 'Start button', id: 0x120, where: 'D3 bit 0x10', rule: '1 while pressed (18 = RUN + start)', source: 'confirmed' },
  { key: 'killRun', label: 'Kill switch', id: 0x120, where: 'D3 bit 0x08', rule: '08 = RUN, 00 = STOP (690: bit 0x10)', source: 'confirmed' },
  { key: 'rideMode', label: 'Ride mode', id: 0x120, where: 'D4', rule: '0 Street, 2 Rain, 1 Offroad (names to confirm)', source: 'capture' },
  { key: 'gear', label: 'Gear', id: 0x129, where: 'D0 high nibble', rule: '0 = neutral, 1-6', source: 'confirmed' },
  { key: 'clutch', label: 'Clutch lever', id: 0x129, where: 'D0 bit 0x08', rule: '1 = pulled', source: 'confirmed' },
  { key: 'absMode', label: 'ABS mode', id: 0x450, where: 'D3', rule: '01 Road, 02 Offroad (names to confirm; also 0x12A D6 02/04)', source: 'capture' },
  { key: 'traction', label: 'Traction control', id: 0x12a, where: 'D1 bit 0x10', rule: '28 on, 18 off (Offroad mode also turns it off)', source: 'confirmed' },
  { key: 'rearWheel', label: 'Rear wheel speed', id: 0x12d, where: 'D1-D2', rule: 'Raw × speed calibration (guess 0.1 km/h); drops to 0 below ~3', source: 'calibrate' },
  { key: 'speedFilteredRaw', label: 'Vehicle speed, smoothed (raw)', id: 0x12e, where: 'D1-D2', rule: '≈ 0.7 × 0x12D, fades out after the wheel stops', source: 'capture' },
  { key: 'frontWheel', label: 'Front wheel speed (690 layout)', id: 0x12b, where: 'D0-D1', rule: 'Raw × speed calibration', source: 'absent' },
  { key: 'tilt', label: 'Pitch / tilt', id: 0x12b, where: 'D5 + D6 high nibble', rule: 'Signed 12-bit', source: 'absent' },
  { key: 'lean', label: 'Lean angle', id: 0x12b, where: 'D6 low nibble + D7', rule: 'Signed 12-bit × lean calibration', source: 'absent' },
  { key: 'frontBrake', label: 'Front brake pressure', id: 0x290, where: 'D0-D1', rule: 'Raw, unit unknown; rest noise ≤ 48, full squeeze ≈ 23,000', source: 'confirmed' },
  { key: 'frontBrakePct', label: 'Front brake (of full squeeze)', id: 0x290, where: 'D0-D1', rule: 'Below 128 = 0; raw ÷ calibrated maximum', source: 'confirmed' },
  { key: 'brakeLight', label: 'Brake light (either brake)', id: 0x290, where: 'D3 bits 0x0C', rule: '02 off, 0E on; front or rear', source: 'confirmed' },
  { key: 'rearBrake', label: 'Rear brake', id: 0x12f, where: 'D0-D1', rule: 'Rises above its resting level with the pedal (on at +28, off below +12)', source: 'capture' },
  { key: 'rearBrakePct', label: 'Rear brake (of full press)', id: 0x12f, where: 'D0-D1', rule: 'Rise ÷ calibrated maximum; steps of 16', source: 'capture' },
  { key: 'tcButton', label: 'Traction control button', id: 0x450, where: 'D2 bit 0x01', rule: '1 = pressed', source: 'ktm' },
  { key: 'quickshifter', label: 'Quickshifter on/off', id: 0x541, where: 'D0 bit 0x04', rule: '1 = on, 0 = off (owner-checked with the dash menu)', source: 'confirmed' },
  { key: 'standUp', label: 'Side stand', id: 0x540, where: 'D3 bit 0x01', rule: '1 = up, 0 = down (690: D4)', source: 'confirmed' },
  { key: 'coolant', label: 'Coolant temperature', id: 0x540, where: 'D5-D6', rule: 'Big-endian ÷ 10, °C (690: D6-D7)', source: 'capture' },
  { key: 'odometer', label: 'Odometer', id: 0x55a, where: 'D0-D2', rule: 'Big-endian ÷ 10, km (1 Hz)', source: 'confirmed' },
  { key: 'fuelRaw', label: 'Fuel flow (raw)', id: 0x540, where: 'D1 (+D2 high)', rule: 'Per second; idle 19-22, 0 engine off', source: 'capture' },
  { key: 'fuelRate', label: 'Fuel rate', id: 0x540, where: 'D1 (+D2 high)', rule: 'Raw × fuel calibration, L/h', source: 'calibrate' }
];

// 0x120 D4 on the 390 (owner capture): the ride mode number. Names follow KTM's menu order; confirm on the dash.
export const RIDE_MODES = { 0: 'Street', 1: 'Offroad', 2: 'Rain' };
// fuelScale: L/h per raw step of 0x540 D1. 0.018 puts a 390 idle (raw ~21) at ~0.38 L/h: a guess until a fill-up calibrates it.
export const DEFAULT_CALIBRATION = { speedScale: 0.1, speedCalibrated: false, leanScale: 0.1, leanZero: 0, leanCalibrated: false, brakeMax: 17500, rearMax: 48, fuelScale: 0.018, fuelCalibrated: false, tankL: 14.5 }; // brakeMax: the owner's firm stop, raw 15-20k
export const BRAKE_NOISE_FLOOR = 128; // At rest D1 wanders 0x00-0x30 on the owner's bike.

// nowUs: device time used to drop values older than staleUs; null skips the age check.
export function decodeKtm(rows, calibration = DEFAULT_CALIBRATION, nowUs = null, staleUs = 2000000) {
  const out = {};
  const frame = id => {
    const f = rows?.get(`S:D:${id}`)?.frame;
    return f && f.data.length === 8 && (nowUs === null || nowUs - f.us <= staleUs) ? f.data : null;
  };
  const d120 = frame(0x120), d129 = frame(0x129), d12a = frame(0x12a), d12b = frame(0x12b), d12d = frame(0x12d), d12e = frame(0x12e);
  const d128 = frame(0x128), d290 = frame(0x290), d450 = frame(0x450), d540 = frame(0x540), d541 = frame(0x541), d55a = frame(0x55a);
  if (d120) {
    out.rpm = be16(d120, 0);
    out.throttle = Math.min(100, Math.round(d120[2] / 253 * 100)); // owner capture: 0 closed, 253 fully open
    out.killRun = (d120[3] & 0x08) !== 0;                          // 08 = RUN on the 390 (owner-checked)
    out.startButton = (d120[3] & 0x10) !== 0;                      // 18 while the start button is held
    out.map = d120[4];
    out.rideMode = RIDE_MODES[d120[4]] ?? `Mode ${d120[4]}`;
  }
  if (d129) {
    const g = d129[0] >> 4;
    out.gear = g === 0 ? 'N' : g <= 6 ? String(g) : null;
    out.clutch = (d129[0] & 0x08) !== 0;
  }
  if (d128) out.throttleClosed = (d128[2] & 0x01) !== 0;
  if (d12a) out.traction = d12a[1] & 0x10 ? 'Off' : 'On'; // 0x28 on, 0x18 off (owner capture)
  // 390 Adventure (owner capture, rear wheel hand-spun): 0x12D D2 follows the rear wheel and cuts to 0
  // when it stops; 0x12E D2 is a smoothed copy at ~0.7×. D1 is assumed to be the high byte.
  if (d12d) {
    out.rearWheelRaw = be16(d12d, 1);
    out.rearWheel = out.rearWheelRaw * calibration.speedScale;
    out.speed = out.rearWheel;
  }
  if (d12e) out.speedFilteredRaw = be16(d12e, 1);
  if (d12b) {
    out.frontWheel = be16(d12b, 0) * calibration.speedScale;
    out.rearWheel = be16(d12b, 2) * calibration.speedScale;
    out.speed ??= out.frontWheel;
    out.tilt = signed12((d12b[5] << 4) | (d12b[6] >> 4));
    out.leanRaw = signed12(((d12b[6] & 0x0f) << 8) | d12b[7]);
    out.lean = (out.leanRaw - calibration.leanZero) * calibration.leanScale;
  }
  if (d290) {
    out.frontBrake = be16(d290, 0);
    const max = calibration.brakeMax || DEFAULT_CALIBRATION.brakeMax;
    out.frontBrakePct = out.frontBrake < BRAKE_NOISE_FLOOR ? 0 : Math.min(100, Math.round(out.frontBrake / max * 100));
    out.brakeLight = (d290[3] & 0x0c) !== 0; // 0E for front, rear or both; rear comes from RearBrake
  }
  if (d450) {
    out.tcButton = (d450[2] & 0x01) !== 0;
    out.absMode = { 1: 'Road', 2: 'Offroad' }[d450[3]] ?? `Mode ${d450[3]}`; // owner capture: 01 <-> 02
  }
  if (d55a) out.odometer = ((d55a[0] << 16) | (d55a[1] << 8) | d55a[2]) / 10; // 21430 = dash 2,143 km
  if (d541) out.quickshifter = (d541[0] & 0x04) !== 0; // owner capture 2026-10-26: bit flipped with the dash menu setting (owner-confirmed: set = on)
  if (d540) {
    out.standUp = (d540[3] & 0x01) !== 0; // 390: D3 bit 0x01 set = stand up (owner-checked)
    out.coolant = be16(d540, 5) / 10; // 390 Adventure: one byte earlier than the 690
    // D1 is fuel per second on the 390 (owner capture: 0 off, 27 just after a start, 19-22 idling,
    // half in the second the engine stopped). D2 stayed 0; it is read as the high byte for safety.
    out.fuelRaw = d540[1] | (d540[2] << 8);
    out.fuelRate = out.fuelRaw * (calibration.fuelScale ?? DEFAULT_CALIBRATION.fuelScale);
    out.instantEconomy = (out.speed ?? 0) >= 3 && out.fuelRate > 0 ? out.speed / out.fuelRate : null;
  }
  return out;
}

// 0x12F D0-D1 rises with rear brake pressure and ignores the front lever (owner captures 2026-10-25):
// rest ~304 (~220 in an earlier session), the owner's firmest press about +48, in steps of 16. The
// resting level drifts, so it is learned whenever the brake light is off. The raw value is smoothed
// and switched with hysteresis so a medium press does not flicker between steps. A light, quick
// pedal press can stay under the threshold, so with no front pressure the light alone means rear.
// Thresholds from the owner's capture: front-only noise peaks at +22, a firm rear press with the
// front held stays above +38.
export const REAR_RISE_ON = 28, REAR_RISE_OFF = 12;
// A trip: distance from the odometer (exact even across gaps), fuel integrated from 0x540 while frames
// arrive. Economy uses only the kilometres covered while fuel was being measured.
const odometerOf = d => ((d[0] << 16) | (d[1] << 8) | d[2]) / 10;
export class Trip {
  constructor(saved = {}) {
    Object.assign(this, { odoStart: null, odo: null, fuelL: 0, measuredKm: 0, runS: 0 }, saved);
    this.lastFuelUs = null; // Device clock; meaningless across sessions, never saved.
  }
  observe(frames, fuelScale = DEFAULT_CALIBRATION.fuelScale) {
    for (const f of frames) {
      if (f.extended || f.remote || f.data.length !== 8) continue;
      if (f.id === 0x540) {
        const lh = (f.data[1] | (f.data[2] << 8)) * fuelScale;
        const dt = this.lastFuelUs === null ? 0 : (f.us - this.lastFuelUs) / 1e6;
        if (dt > 0 && dt <= 1) {
          this.fuelL += lh * dt / 3600;
          if (lh > 0) this.runS += dt;
        }
        this.lastFuelUs = f.us;
      } else if (f.id === 0x55a) {
        const odo = odometerOf(f.data);
        this.odoStart ??= odo;
        const step = this.odo === null ? 0 : odo - this.odo;
        const fuelLive = this.lastFuelUs !== null && f.us - this.lastFuelUs >= 0 && f.us - this.lastFuelUs < 2e6;
        if (step > 0 && step <= 1 && fuelLive) this.measuredKm += step;
        this.odo = odo;
      }
    }
  }
  reset() { Object.assign(this, { odoStart: this.odo, fuelL: 0, measuredKm: 0, runS: 0 }); }
  stats() {
    return {
      distance: this.odo === null || this.odoStart === null ? null : Math.max(0, this.odo - this.odoStart),
      fuelL: this.fuelL,
      economy: this.fuelL > 0.005 && this.measuredKm >= 0.2 ? this.measuredKm / this.fuelL : null,
      rate: this.runS >= 30 ? this.fuelL / (this.runS / 3600) : null,
      runS: this.runS
    };
  }
  toJSON() { return { odoStart: this.odoStart, odo: this.odo, fuelL: this.fuelL, measuredKm: this.measuredKm, runS: this.runS }; }
}

export class RearBrake {
  constructor() { this.reset(); }
  reset() { this.rest = null; this.raw = undefined; this.light = undefined; this.front = 0; this.on = false; }
  observe(frames) {
    for (const f of frames) {
      if (f.extended || f.remote || f.data.length !== 8) continue;
      if (f.id === 0x290) { this.light = (f.data[3] & 0x0c) !== 0; this.front = be16(f.data, 0); }
      else if (f.id === 0x12f) {
        const raw = be16(f.data, 0);
        this.raw = this.raw === undefined ? raw : this.raw + (raw - this.raw) * 0.2;
        if (this.light === false) this.rest = this.rest === null ? this.raw : this.rest + (this.raw - this.rest) * 0.05;
        this.update();
      }
    }
  }
  update() {
    const rise = this.rest === null ? 0 : Math.max(0, this.raw - this.rest);
    if (this.light !== true) this.on = false;
    else if (this.front < BRAKE_NOISE_FLOOR || rise >= REAR_RISE_ON) this.on = true;
    else if (rise < REAR_RISE_OFF) this.on = false;
  }
  read(max = DEFAULT_CALIBRATION.rearMax) {
    if (this.raw === undefined || this.rest === null) return {};
    const rise = Math.max(0, this.raw - this.rest);
    return { rearRise: Math.round(rise), rearBrake: this.on, rearBrakePct: this.on ? Math.min(100, Math.round(rise / max * 100)) : 0 };
  }
}

// ---------------------------------------------------------------------------
// ID hunter: compare a still baseline with a capture taken while operating a control
// ---------------------------------------------------------------------------
const popcount = v => { let n = 0; for (; v; v &= v - 1) n++; return n; };

export class IdHunter {
  constructor() { this.reset(); }
  reset() { this.phases = { baseline: new Map(), action: new Map() }; this.phase = null; }
  begin(phase) { this.phases[phase] = new Map(); this.phase = phase; }
  end() { this.phase = null; }
  observe(frames) {
    if (!this.phase) return;
    const table = this.phases[this.phase];
    for (const f of frames) {
      if (f.remote) continue;
      const key = frameKey(f);
      let entry = table.get(key);
      if (!entry) table.set(key, entry = { id: f.id, extended: f.extended, frames: 0, bytes: [] });
      entry.frames += f.count ?? 1;
      f.data.forEach((byte, i) => {
        const b = entry.bytes[i] ??= { last: byte, first: byte, min: byte, max: byte, toggled: 0, transitions: 0, values: new Set() };
        if (byte !== b.last) { b.toggled |= byte ^ b.last; b.transitions++; }
        b.last = byte; b.min = Math.min(b.min, byte); b.max = Math.max(b.max, byte);
        if (b.values.size < 64) b.values.add(byte);
      });
    }
  }
  results(limit = 20) {
    const out = [];
    for (const [key, act] of this.phases.action) {
      const base = this.phases.baseline.get(key);
      if (!base) {
        out.push({ key, id: act.id, extended: act.extended, byte: null, mask: null, kind: 'new-id', score: 50,
          detail: 'Only present while you operated the control' });
        continue;
      }
      act.bytes.forEach((a, i) => {
        const b = base.bytes[i];
        if (!b) return;
        const fresh = a.toggled & ~b.toggled;
        const baseStill = b.toggled === 0;
        if (fresh) {
          const bits = popcount(fresh);
          // Few fresh bits that flipped repeatedly while the byte was still at rest: a switch.
          const score = (baseStill ? 40 : 15) + Math.min(a.transitions, 20) * 2 + (bits <= 2 ? 20 : 0);
          out.push({ key, id: act.id, extended: act.extended, byte: i, mask: bits <= 2 ? fresh : null, kind: bits <= 2 ? 'switch' : 'value',
            score, transitions: a.transitions, range: [a.min, a.max], baseRange: [b.min, b.max],
            detail: bits <= 2 ? `Bit ${maskLabel(fresh)} flipped ${a.transitions}× and was steady when still`
              : `Moved ${hex(a.min, 2)}-${hex(a.max, 2)}; at rest ${hex(b.min, 2)}-${hex(b.max, 2)}` });
        } else if (baseStill && a.toggled === 0 && a.last !== b.last) {
          // Held for the whole action phase: one steady value in each phase.
          const diff = a.last ^ b.last;
          out.push({ key, id: act.id, extended: act.extended, byte: i, mask: popcount(diff) <= 2 ? diff : null, kind: 'held', score: 45,
            transitions: 0, range: [a.min, a.max], baseRange: [b.min, b.max],
            detail: `Steady ${hex(b.last, 2)} at rest, steady ${hex(a.last, 2)} while held` });
        }
      });
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}

export const maskLabel = mask => `0x${hex(mask, 2)}`;

// ---------------------------------------------------------------------------
// Demo traffic for the preview (`?demo=1`). Same layout as the KTM map above,
// plus invented IDs 0x2A0 / 0x3C1 so the ID hunter has something to find.
// ---------------------------------------------------------------------------
export function demoFrames(sim, timeUs) {
  const f = (id, data) => ({ id, extended: false, remote: false, dlc: 8, us: timeUs, count: 1, data });
  const gear = sim.gear === 'N' ? 0 : Number(sim.gear);
  const front = Math.round(sim.speed / DEFAULT_CALIBRATION.speedScale);
  const rear = Math.round(sim.speed * 1.02 / DEFAULT_CALIBRATION.speedScale);
  const lean = Math.round(sim.lean / DEFAULT_CALIBRATION.leanScale) & 0xfff;
  const tilt = Math.round(sim.tilt) & 0xfff;
  const coolant = Math.round(sim.coolant * 10);
  const tick = Math.floor(timeUs / 20000) % 6;
  const rearPress = 304 + (sim.rearBrake ? 80 : 0);
  const fuel = sim.rpm > 0 ? Math.round(14 + sim.rpm / 1000 * 3 + sim.throttle * 0.4) : 0;
  const odo = Math.round((sim.odo ?? 2143) * 10);
  return [
    f(0x120, [sim.rpm >> 8, sim.rpm & 0xff, Math.round(sim.throttle * 2.53), sim.killRun ? 0x08 : 0, sim.map, 0, 0, 0x30 + tick * 0x20]),
    f(0x129, [(gear << 4) | (sim.clutch ? 0x08 : 0), 0, 0, 0, 0, 0, 0, 0x20 + tick * 0x20]),
    f(0x12a, [0x10, sim.map === 1 ? 0x18 : 0x28, 0x10, 0, sim.map === 1 ? 0 : 0x20, 0x48, 0x02, 0x3f + tick * 0x20]),
    f(0x12d, [0, rear >> 8, rear & 0xff, 0, 0, 0, Math.min(255, Math.round(rear * 1.5)), 0x35 + tick * 0x20]),
    f(0x12e, [0, (rear * 0.7) >> 8, Math.round(rear * 0.7) & 0xff, 0, 0, 0, 0xc0, 0x2e + tick * 0x20]),
    f(0x12b, [front >> 8, front & 0xff, rear >> 8, rear & 0xff, 0, tilt >> 4, ((tilt & 0x0f) << 4) | (lean >> 8), lean & 0xff]),
    f(0x290, [sim.brake >> 8, sim.brake & 0xff, 0, sim.brake > 1000 || sim.rearBrake ? 0x0e : 0x02, 0, 0, 0, 0]),
    f(0x12f, [rearPress >> 8, rearPress & 0xff, 0, 0x20, 0, 0, 0, tick]),
    f(0x450, [0, 0x3e, 0x80 | (sim.tcButton ? 1 : 0), sim.map === 1 ? 0x02 : 0x01, 0x08, 0, 0x59, 0]),
    f(0x128, [0x13, 0x88, sim.throttle > 0 ? 0x02 : 0x03, 0, 0, 0, 0, 0x37 + tick * 0x20]),
    f(0x541, [sim.quickshifter === false ? 0x00 : 0x04, 0, 0x08, 0, 0x3b, 0x03, 0xbe, 0]),
    f(0x540, [0x00, fuel & 0xff, fuel >> 8, sim.standUp ? 0x11 : 0x10, 0, coolant >> 8, coolant & 0xff, 0]),
    f(0x2a0, [0x40, (sim.indicatorLeft ? 0x01 : 0) | (sim.indicatorRight ? 0x02 : 0), 0, sim.highBeam ? 0x80 : 0, 0, 0, 0, tick]),
    f(0x3c1, [0x17, 0x5e, sim.fuel, 0, 0x0c, 0x80, 0, 0]),
    f(0x55a, [odo >> 16, (odo >> 8) & 0xff, odo & 0xff, 0, 0, 0, 0, 0])
  ];
}
