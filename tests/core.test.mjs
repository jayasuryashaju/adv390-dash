import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureStore, decodeSignal, validateSignal, toCsv, frameKey, parseFramePacket, encodeFramePacket, createClock,
  commands, decodeKtm, IdHunter, demoFrames, signed12, DEFAULT_CALIBRATION, RearBrake, Trip } from '../web/core.mjs';

const frame = (id, hexBytes, extra = {}) => ({ id, extended: false, remote: false, dlc: 8, us: 1000, count: 1,
  data: hexBytes.split(',').map(b => parseInt(b, 16)), ...extra });
const rowsOf = (...frames) => { const s = new CaptureStore(); s.ingest(frames); return s.rows; };
const base = { name: 'x', id: 0x120, extended: false, signed: false, start: 0, length: 2, endian: 'big', scale: 1, offset: 0, unit: '' };

test('decodes big/little endian, signed, scaled values', () => {
  const f = frame(0x120, '01,02,FF,FE,00,00,00,00');
  assert.equal(decodeSignal(f, base), 0x0102);
  assert.equal(decodeSignal(f, { ...base, endian: 'little' }), 0x0201);
  assert.equal(decodeSignal(f, { ...base, start: 2, signed: true }), -2);
  assert.equal(decodeSignal(f, { ...base, scale: 0.5, offset: -1 }), 0x0102 * 0.5 - 1);
  assert.equal(decodeSignal({ ...f, id: 0x121 }, base), null);
});

test('bit-mask signals read a shifted flag from one byte', () => {
  const f = frame(0x2a0, '00,02,00,80,00,00,00,00');
  assert.equal(decodeSignal(f, { ...base, id: 0x2a0, start: 1, length: 1, mask: 0x02 }), 1);
  assert.equal(decodeSignal(f, { ...base, id: 0x2a0, start: 1, length: 1, mask: 0x01 }), 0);
  assert.equal(decodeSignal(f, { ...base, id: 0x2a0, start: 3, length: 1, mask: 0xc0 }), 2);
  assert.throws(() => validateSignal({ ...base, mask: 0x01 }), /single byte/);
});

test('rejects invalid mappings', () => {
  assert.throws(() => validateSignal({ ...base, id: 0x800 }), /outside/);
  assert.throws(() => validateSignal({ ...base, start: 7, length: 2 }), /within payload/);
  assert.throws(() => validateSignal({ ...base, name: '' }), /name/);
});

test('BLE frame packets round-trip, including extended and remote frames', () => {
  const frames = [
    { id: 0x120, extended: false, remote: false, dlc: 8, us: 123456, count: 3, data: [1, 2, 3, 4, 5, 6, 7, 8] },
    { id: 0x18ff0100, extended: true, remote: false, dlc: 2, us: 123999, count: 1, data: [0xaa, 0xbb] },
    { id: 0x7df, extended: false, remote: true, dlc: 8, us: 124000, count: 1, data: [] }
  ];
  assert.deepEqual(parseFramePacket(encodeFramePacket(frames)), frames);
  assert.throws(() => parseFramePacket(new Uint8Array([0x01, 0x20, 0x01, 0, 0, 0, 0, 0, 0, 1, 0, 8, 1])), /Truncated/);
  assert.throws(() => parseFramePacket(new Uint8Array([0x09])), /Unknown/);
});

test('device clock unwraps 32-bit microsecond rollover', () => {
  const clock = createClock();
  assert.equal(clock.unwrap(0xfffffff0), 0xfffffff0);
  assert.equal(clock.unwrap(0x10), 0x100000010);
  assert.equal(clock.unwrap(0x20), 0x100000020);
});

test('control commands encode bitrate little-endian', () => {
  assert.deepEqual([...commands.start(500000)], [0x01, 0x20, 0xa1, 0x07, 0x00]);
  assert.deepEqual([...commands.stop()], [0x02]);
  assert.deepEqual([...commands.mode(true)], [0x03, 0x01]);
});

test('capture store counts folded frames and derives the per-frame interval', () => {
  const store = new CaptureStore(3, 2);
  store.ingest([frame(1, '00', { us: 0 }), frame(1, '01', { us: 40000, count: 4 })]);
  const row = store.rows.get('S:D:1');
  assert.equal(row.count, 5);
  assert.equal(row.interval, 10);
  assert.deepEqual(row.changed, [true]);
  store.ingest([frame(2, '00'), frame(3, '00')]);
  assert.equal(store.evicted, 1);
  assert.equal(store.idEvictions, 1);
  assert.equal(frameKey({ id: 1, extended: true, remote: true }), 'E:R:1');
});

test('CSV includes frames represented per record', () => {
  const csv = toCsv([{ seq: 1, us: 2, id: 0x120, extended: false, remote: false, dlc: 2, count: 4, data: [0x0a, 0xff] }]);
  assert.match(csv, /0x120,standard,data,2,4,0A FF$/);
});

// Vectors from blalor/ktm-can tests (2020 KTM 690 Enduro R).
test('KTM map: 0x540 rpm (690 vector); side stand D3 bit 0x01 and coolant D5–D6 (390 captures)', () => {
  assert.equal(decodeKtm(rowsOf(frame(0x540, '00,00,00,01,89,03,C2,00'))).coolant, 96.2);
  assert.equal(decodeKtm(rowsOf(frame(0x541, '04,00,08,00,3b,03,be,95'))).quickshifter, true);   // owner capture 2026-10-26
  assert.equal(decodeKtm(rowsOf(frame(0x541, '00,00,08,00,3b,03,be,95'))).quickshifter, false);
  assert.equal(decodeKtm(rowsOf(frame(0x540, '00,00,00,11,00,02,25,00'))).standUp, true);   // stand up
  assert.equal(decodeKtm(rowsOf(frame(0x540, '00,00,00,10,00,02,25,00'))).standUp, false);  // stand down
});

test('390 controls: throttle 0–253, kill switch 0x08 = RUN, closed-throttle switch', () => {
  assert.equal(decodeKtm(rowsOf(frame(0x120, '00,00,FD,00,00,00,00,30'))).throttle, 100);
  assert.equal(decodeKtm(rowsOf(frame(0x120, '00,00,00,08,00,00,00,30'))).killRun, true);
  assert.equal(decodeKtm(rowsOf(frame(0x120, '00,00,00,00,00,00,00,30'))).killRun, false);
  assert.equal(decodeKtm(rowsOf(frame(0x120, '00,00,00,18,00,00,00,30'))).startButton, true);   // owner capture: 08 -> 18 -> 08
  assert.equal(decodeKtm(rowsOf(frame(0x120, '00,00,00,08,00,00,00,30'))).startButton, false);
  assert.equal(decodeKtm(rowsOf(frame(0x128, '13,88,03,00,00,00,00,37'))).throttleClosed, true);
  assert.equal(decodeKtm(rowsOf(frame(0x128, '13,88,02,00,00,00,00,37'))).throttleClosed, false);
});

test('KTM map: 0x12B wheels, tilt and lean', () => {
  const tel = decodeKtm(rowsOf(frame(0x12b, '00,00,02,16,00,02,8F,FD')), { ...DEFAULT_CALIBRATION, speedScale: 1, leanScale: 1 });
  assert.equal(tel.frontWheel, 0);
  assert.equal(tel.rearWheel, 534);
  assert.equal(tel.tilt, 40);
  assert.equal(tel.leanRaw, -3);
  assert.equal(signed12(0xfff), -1);
});

test('KTM map: 0x120 and 0x129 take priority, values go stale', () => {
  const rows = rowsOf(frame(0x120, '1F,40,80,08,01,00,00,30'), frame(0x129, '38,00,00,00,00,00,00,20'), frame(0x540, '02,06,65,00,01,00,01,DD'));
  const tel = decodeKtm(rows);
  assert.equal(tel.rpm, 8000);
  assert.equal(tel.throttle, 51);
  assert.equal(tel.killRun, true);
  assert.equal(tel.rideMode, 'Offroad');
  assert.equal(tel.gear, '3');
  assert.equal(tel.clutch, true);
  assert.deepEqual(decodeKtm(rows, DEFAULT_CALIBRATION, 1000 + 3e6), {});
});

test('front brake: rest noise reads 0, full squeeze reads 100 %', () => {
  assert.equal(decodeKtm(rowsOf(frame(0x290, '00,30,00,02,00,00,00,DC'))).frontBrakePct, 0);
  assert.equal(decodeKtm(rowsOf(frame(0x290, '59,D8,00,02,00,00,00,DC'))).frontBrakePct, 100);
  assert.equal(decodeKtm(rowsOf(frame(0x290, '22,2E,00,02,00,00,00,DC'))).frontBrakePct, 50); // 8,750 of 17,500
  assert.equal(decodeKtm(rowsOf(frame(0x290, '2C,EC,00,02,00,00,00,DC')), { ...DEFAULT_CALIBRATION, brakeMax: 11500 }).frontBrakePct, 100);
});

test('brake light is either brake (0x290 D3)', () => {
  assert.equal(decodeKtm(rowsOf(frame(0x290, '00,00,00,02,00,00,00,3D'))).brakeLight, false);
  assert.equal(decodeKtm(rowsOf(frame(0x290, '2C,EC,00,0E,00,00,00,DC'))).brakeLight, true);
});

test('rear brake: brake light on with no front pressure is rear only', () => {
  const rear = new RearBrake();
  rear.observe([frame(0x290, '00,10,00,02,00,00,00,00')]);
  assert.deepEqual(rear.read(), { rearBrake: false, rearBrakePct: 0 });   // released
  rear.observe([frame(0x290, '1F,40,00,0E,00,00,00,00')]);
  assert.equal(rear.read().rearBrake, false);                              // front lever held (rear cannot be told)
  rear.observe([frame(0x290, '00,10,00,0E,00,00,00,00')]);
  assert.deepEqual(rear.read(), { rearBrake: true, rearBrakePct: 100 });  // light on, only noise on the front sensor
});

test('lean from 0x12F D0-D1 (owner capture 2026-10-26: tilted by hand on the side stand)', () => {
  const cal = { ...DEFAULT_CALIBRATION, leanScale: 1, leanZero: 0 };
  assert.equal(decodeKtm(rowsOf(frame(0x12f, '08,D0,00,20,00,00,00,70')), cal).leanRaw, 141);   // right
  assert.equal(decodeKtm(rowsOf(frame(0x12f, 'FA,10,00,20,00,00,00,56')), cal).leanRaw, -95);   // left
  assert.equal(decodeKtm(rowsOf(frame(0x12f, '00,A0,00,20,00,00,00,91')), cal).leanRaw, 10);    // upright, noise
  assert.equal(decodeKtm(rowsOf(frame(0x12f, '08,D0,00,20,00,00,00,70')), { ...cal, leanZero: 1, leanScale: 0.1 }).lean, 14);
});

test('odometer: 0x55A D0–D2 ÷ 10 km (owner dash 2,143 km)', () => {
  assert.equal(decodeKtm(rowsOf(frame(0x55a, '00,53,B6,00,00,00,00,00'))).odometer, 2143);
});

test('rear wheel speed from 0x12D D1–D2 (owner hand-spin capture), smoothed copy in 0x12E', () => {
  const tel = decodeKtm(rowsOf(frame(0x12d, '00,00,52,00,00,00,80,30'), frame(0x12e, '00,00,3B,00,00,00,C0,2E')));
  assert.equal(tel.rearWheelRaw, 82);
  assert.ok(Math.abs(tel.speed - 8.2) < 1e-9);
  assert.equal(tel.speedFilteredRaw, 59);
  assert.equal(decodeKtm(rowsOf(frame(0x12d, '00,00,52,00,00,00,80,30')), { ...DEFAULT_CALIBRATION, speedScale: 0.25 }).speed, 20.5);
});

test('ride mode 0x120 D4 and traction control 0x12A D1 (owner capture)', () => {
  const mode = d4 => decodeKtm(rowsOf(frame(0x120, `00,00,00,08,${d4},00,00,30`))).rideMode;
  assert.deepEqual([mode('00'), mode('02'), mode('01')], ['Street', 'Rain', 'Offroad']);
  assert.equal(decodeKtm(rowsOf(frame(0x12a, '10,28,10,00,20,48,02,3F'))).traction, 'On');
  assert.equal(decodeKtm(rowsOf(frame(0x12a, '10,18,10,00,00,48,02,3F'))).traction, 'Off');
  assert.equal(decodeKtm(rowsOf(frame(0x450, '00,3E,80,01,08,00,59,00'))).absMode, 'Road');
  assert.equal(decodeKtm(rowsOf(frame(0x450, '00,3E,80,02,08,00,59,00'))).absMode, 'Offroad');
});

test('fuel rate from 0x540 D1 and instant economy', () => {
  const tel = decodeKtm(rowsOf(frame(0x540, '00,15,00,11,00,02,25,00'), frame(0x12d, '00,01,F4,00,00,00,80,30')), { ...DEFAULT_CALIBRATION, fuelScale: 0.02 });
  assert.equal(tel.fuelRaw, 21);
  assert.ok(Math.abs(tel.fuelRate - 0.42) < 1e-9);
  assert.ok(Math.abs(tel.instantEconomy - 50 / 0.42) < 1e-9);  // 50 km/h at 0.42 L/h
  assert.equal(decodeKtm(rowsOf(frame(0x540, '00,15,00,11,00,02,25,00'))).instantEconomy, null); // stationary
});

test('trip: odometer distance, fuel integrated at 10 Hz, economy over measured km only', () => {
  const trip = new Trip();
  const fuel = us => ({ ...frame(0x540, '00,28,00,11,00,02,25,00'), us });  // raw 40 -> 0.8 L/h at 0.02
  const odo = (tenths, us) => ({ ...frame(0x55a, `00,${(tenths >> 8).toString(16)},${(tenths & 0xff).toString(16)},00,00,00,00,00`), us });
  for (let i = 0; i <= 3600; i++) {                                     // one hour at 10 Hz… compressed: 360 s
    const us = i * 100000;
    trip.observe([fuel(us)], 0.02);
    if (i % 10 === 0) trip.observe([odo(21430 + Math.floor(i / 100), us + 1)], 0.02);  // 0.1 km every 10 s
  }
  const s = trip.stats();
  assert.ok(Math.abs(s.distance - 3.6) < 1e-6);
  assert.ok(Math.abs(s.fuelL - 0.8 * 360 / 3600) < 1e-6);
  assert.ok(Math.abs(s.economy - 3.6 / 0.08) < 1e-3);
  assert.ok(Math.abs(s.rate - 0.8) < 1e-6);
  trip.observe([odo(21530, 400e6)], 0.02);                               // jump to 2,153.0 km while disconnected
  assert.ok(Math.abs(trip.stats().distance - 10) < 1e-6);
  assert.ok(Math.abs(trip.stats().economy - 3.6 / 0.08) < 1e-3);           // not counted in economy
  const restored = new Trip(JSON.parse(JSON.stringify(trip)));
  assert.equal(restored.stats().distance, trip.stats().distance);
  restored.reset();
  assert.deepEqual([restored.stats().distance, restored.fuelL], [0, 0]);
});

test('ID hunter ranks a toggling bit above background noise', () => {
  const hunter = new IdHunter();
  const sim = { rpm: 3000, throttle: 10, gear: 'N', clutch: false, speed: 0, lean: 0, tilt: 0, coolant: 80, brake: 0, killRun: true,
    map: 0, standUp: true, tcButton: false, indicatorLeft: false, indicatorRight: false, highBeam: false, fuel: 0x80 };
  hunter.begin('baseline');
  for (let i = 0; i < 100; i++) hunter.observe(demoFrames({ ...sim, rpm: 3000 + (i % 7) * 13 }, i * 40000));
  hunter.begin('action');
  for (let i = 0; i < 160; i++) hunter.observe(demoFrames({ ...sim, rpm: 3000 + (i % 7) * 13, indicatorLeft: Math.floor(i / 16) % 2 === 1 }, 4e6 + i * 40000));
  hunter.end();
  const [best] = hunter.results();
  assert.equal(best.id, 0x2a0);
  assert.equal(best.byte, 1);
  assert.equal(best.mask, 0x01);
  assert.equal(best.kind, 'switch');
});

test('ID hunter finds a control held for the whole action recording', () => {
  const hunter = new IdHunter();
  const sim = { rpm: 1400, throttle: 0, gear: 'N', clutch: false, speed: 0, lean: 0, tilt: 0, coolant: 80, brake: 0, killRun: true,
    map: 0, standUp: true, tcButton: false, indicatorLeft: false, indicatorRight: false, highBeam: false, fuel: 0x80 };
  hunter.begin('baseline');
  for (let i = 0; i < 50; i++) hunter.observe(demoFrames(sim, i * 40000));
  hunter.begin('action');
  for (let i = 0; i < 50; i++) hunter.observe(demoFrames({ ...sim, highBeam: true }, 2e6 + i * 40000));
  const held = hunter.results().find(c => c.kind === 'held');
  assert.equal(held.id, 0x2a0);
  assert.equal(held.byte, 3);
  assert.equal(held.mask, 0x80);
});
