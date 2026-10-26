"""Record the reader for a fixed script and find which CAN byte follows a setting you change.
The reader allows one Bluetooth client: disconnect the dashboard (phone and browser) first. Listen-only: it only sends the
same 'start capture' command the dashboard sends.

  python scripts/record_qs.py [label]

Timeline (beeps tell you what to do):  15 s hands off  ->  4 windows of 15 s. Long beep = change the setting once in that
window (OFF, ON, OFF, ON). Short beeps = window over."""
import asyncio, struct, sys, time, csv, collections, winsound
from bleak import BleakScanner, BleakClient

SERVICE = '4b544d39-0000-4a10-8c00-ca0000000001'
FRAMES, CONTROL = '4b544d39-0001-4a10-8c00-ca0000000001', '4b544d39-0003-4a10-8c00-ca0000000001'
KNOWN = {0x120, 0x128, 0x129, 0x12A, 0x12D, 0x12E, 0x12F, 0x290, 0x450, 0x540, 0x55A}
BASE, WIN, WINDOWS = 15, 15, 4
label = sys.argv[1] if len(sys.argv) > 1 else 'quickshifter'
log = []  # (t, id, data)
t0 = None

def on_packet(_, data):
    if not data or data[0] != 1: return
    at = 1
    while at + 11 <= len(data):
        raw, _t, _c, dlc = struct.unpack_from('<IIHB', data, at)
        n = 0 if raw & 0x40000000 else min(8, dlc)
        log.append((time.monotonic() - t0, raw & 0x1fffffff, bytes(data[at + 11:at + 11 + n])))
        at += 11 + n

def beep(f, ms): winsound.Beep(f, ms)

async def main():
    global t0
    print('Looking for ADV390-CAN ...')
    dev = await BleakScanner.find_device_by_filter(lambda d, a: (d.name or '').startswith('ADV390') or SERVICE in (a.service_uuids or []), timeout=15)
    if not dev: sys.exit('Reader not found. Is it powered, and is the dashboard disconnected?')
    async with BleakClient(dev) as c:
        t0 = time.monotonic()
        await c.start_notify(FRAMES, on_packet)
        await c.write_gatt_char(CONTROL, bytes([1, 0x20, 0xA1, 0x07, 0x00]), response=True)  # start capture, 500 kbit/s
        print(f'Connected. Ignition ON, bike still. Recording {BASE} s baseline: DO NOT TOUCH ANYTHING.')
        beep(800, 500); await asyncio.sleep(BASE)
        marks = [BASE]
        for i in range(WINDOWS):
            print(f'Window {i + 1}/{WINDOWS}: change the setting NOW ({"OFF" if i % 2 == 0 else "ON"}), once, then wait.')
            beep(1200, 900); await asyncio.sleep(WIN); marks.append(BASE + WIN * (i + 1)); beep(500, 150)
        await c.stop_notify(FRAMES)
    path = f'captures/{time.strftime("%Y-%m-%d")}-{label}.csv'
    with open(path, 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['host_s', 'device_time_us', 'can_id', 'data_hex'])
        for t, i, d in log: w.writerow([f'{t:.3f}', 0, f'0x{i:03X}', ' '.join(f'{b:02X}' for b in d)])
    print(f'{len(log)} frames saved to {path}')
    analyse(marks)

def analyse(marks):
    seg = lambda t: sum(t >= m for m in marks)  # 0 baseline, 1..4 windows
    seen = collections.defaultdict(lambda: [set() for _ in range(WINDOWS + 1)])
    last = {}
    for t, i, d in log:
        s = seg(t)
        for k, b in enumerate(d): seen[(i, k)][s].add(b)
    out = []
    for (i, k), segs in seen.items():
        if not all(segs): continue
        base = segs[0]
        if len(base) != 1: continue  # must be steady while untouched
        finals = [min(s) if len(s) == 1 else None for s in segs]
        changed = [s != base for s in segs[1:]]
        if not any(changed): continue
        score = sum(len(s) == 1 for s in segs[1:]) * 2 + sum(changed)
        out.append((score, i, k, finals))
    print('\nCandidates (byte steady in baseline, different in the windows):')
    if not out: print('  none: the setting is probably not broadcast on this bus.'); return
    for score, i, k, finals in sorted(out, reverse=True)[:15]:
        seq = ' '.join('--' if v is None else f'{v:02X}' for v in finals)
        print(f'  0x{i:03X} D{k}  baseline,w1..w4 = {seq}   {"(known ID)" if i in KNOWN else ""}')
    print('\nA real on/off setting shows two alternating values: base, other, base, other, base (or the reverse).')

asyncio.run(main())
