"""Find which CAN bytes follow a lean (roll) movement. Listen-only; the reader allows one Bluetooth client, so disconnect the
dashboard first.

  python scripts/hunt_axis.py [label]        record with spoken cues, save captures/<date>-<label>.csv, print candidates
  python scripts/hunt_axis.py --file x.csv   analyse a saved recording with the same timeline
  python scripts/hunt_axis.py --selftest     check the analysis on synthetic data
"""
import asyncio, csv, statistics, struct, subprocess, sys, time

SERVICE = '4b544d39-0000-4a10-8c00-ca0000000001'
FRAMES, STATUS, CONTROL = ('4b544d39-000%d-4a10-8c00-ca0000000001' % n for n in (1, 2, 3))
KNOWN = {0x120, 0x128, 0x129, 0x12A, 0x12D, 0x12E, 0x12F, 0x290, 0x450, 0x540, 0x541, 0x55A}
# (phase, seconds, spoken cue)
TIMELINE = [('upright', 8, 'Hold the bike upright and still'), ('left', 8, 'Lean left and hold'), ('upright', 6, 'Upright'),
            ('right', 8, 'Lean right and hold'), ('upright', 6, 'Upright'), ('left', 8, 'Lean left and hold'),
            ('upright', 6, 'Upright'), ('right', 8, 'Lean right and hold'), ('upright', 6, 'Upright and still')]
SETTLE = 2.5  # ignore the first seconds of each phase while you are still moving


def speak(text):
    script = f"Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{text}')"
    subprocess.Popen(['powershell', '-NoProfile', '-Command', script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def schedule():
    t, out = 0.0, []
    for name, secs, cue in TIMELINE:
        out.append((name, t, t + secs, cue))
        t += secs
    return out


def fields(d):
    """Every plausible encoding of a value inside an 8-byte payload: (name, value)."""
    for k in range(len(d)):
        yield f'D{k} u8', d[k]
    for k in range(len(d) - 1):
        a, b = d[k], d[k + 1]
        yield f'D{k}-D{k+1} u16 BE', (a << 8) | b
        yield f'D{k}-D{k+1} s16 BE', struct.unpack('>h', bytes([a, b]))[0]
        yield f'D{k}-D{k+1} u16 LE', (b << 8) | a
        yield f'D{k}-D{k+1} s16 LE', struct.unpack('<h', bytes([a, b]))[0]
        for name, v in (('12-bit hi', (a << 4) | (b >> 4)), ('12-bit lo', ((a & 15) << 8) | b),
                        ('12-bit LE lo', a | ((b & 15) << 8)), ('12-bit LE hi', (a >> 4) | (b << 4))):
            yield f'D{k}-D{k+1} {name}', v - 4096 if v & 0x800 else v


def analyse(log, show=14):
    """log: [(t, id, bytes)]. Returns candidate rows, best first."""
    sched = schedule()
    samples = {}  # (id, field) -> {phase_index: [values]}
    for t, cid, d in log:
        for i, (name, a, b, _) in enumerate(sched):
            if a + SETTLE <= t < b:
                for fname, v in fields(d):
                    samples.setdefault((cid, fname), {}).setdefault(i, []).append(v)
                break
    idx = {n: [i for i, s in enumerate(sched) if s[0] == n] for n in ('upright', 'left', 'right')}
    rows = []
    for (cid, fname), per in samples.items():
        if any(len(per.get(i, [])) < 5 for n in idx for i in idx[n]):
            continue
        mean = lambda ids: statistics.fmean(v for i in ids for v in per[i])
        up, left, right = mean(idx['upright']), mean(idx['left']), mean(idx['right'])
        noise = statistics.fmean(statistics.pstdev(per[i]) for i in per) + 0.5
        dl, dr = left - up, right - up
        if dl * dr >= 0:
            continue  # must go opposite ways
        l1, l2 = (statistics.fmean(per[i]) for i in idx['left'])
        r1, r2 = (statistics.fmean(per[i]) for i in idx['right'])
        ups = [statistics.fmean(per[i]) for i in idx['upright']]
        spread = max(abs(l1 - l2), abs(r1 - r2), max(ups) - min(ups)) + noise
        score = min(abs(dl), abs(dr)) / spread
        if score > 3:
            rows.append((score, cid, fname, up, left, right))
    rows.sort(reverse=True)
    return rows[:show]


def report(rows):
    print('\nCandidates: moves opposite ways for left and right, returns when upright, repeats agree.')
    if not rows:
        print('  none found. Is the ignition on? Some bikes only send IMU data above a minimum speed.')
        return
    print(f'  {"score":>6}  {"ID":6} {"field":24} {"upright":>9} {"left":>9} {"right":>9}')
    for score, cid, fname, up, left, right in rows:
        print(f'  {score:6.1f}  0x{cid:03X}{"*" if cid in KNOWN else " "} {fname:24} {up:9.1f} {left:9.1f} {right:9.1f}')
    print('  * = ID we already decode for something else')


def load_csv(path):
    out = []
    for r in csv.reader(open(path, newline='')):
        if r and r[0] != 'host_s':
            out.append((float(r[0]), int(r[2], 16), bytes.fromhex(r[3].replace(' ', ''))))
    return out


async def record(label):
    from bleak import BleakScanner, BleakClient
    log, t0 = [], None

    def on_packet(_, data):
        if not data or data[0] != 1:
            return
        at = 1
        while at + 11 <= len(data):
            raw, _t, _c, dlc = struct.unpack_from('<IIHB', data, at)
            n = 0 if raw & 0x40000000 else min(8, dlc)
            log.append((time.monotonic() - t0, raw & 0x1fffffff, bytes(data[at + 11:at + 11 + n])))
            at += 11 + n

    print('Looking for ADV390-CAN ...')
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: (d.name or '').startswith('ADV390') or SERVICE in (a.service_uuids or []), timeout=15)
    if not dev:
        sys.exit('Reader not found. Is it powered, and is the dashboard disconnected?')
    async with BleakClient(dev) as c:
        running = b'"running":true' in bytes(await c.read_gatt_char(STATUS)).replace(b' ', b'')
        try:
            await c.write_gatt_char(CONTROL, bytes([3, 0]), response=False)  # latest-per-ID mode: no packet loss
        except Exception as e:
            print('mode command skipped:', e)
        if not running:
            try:
                await c.write_gatt_char(CONTROL, bytes([1, 0x20, 0xA1, 0x07, 0x00]), response=False)  # start, 500 kbit/s
            except Exception as e:
                print('start command skipped:', e)
        await asyncio.sleep(0.5)
        t0 = time.monotonic()
        await c.start_notify(FRAMES, on_packet)
        for name, a, b, cue in schedule():
            print(f'{a:5.0f}s  {cue}')
            speak(cue)
            await asyncio.sleep(max(0, b - (time.monotonic() - t0)))
        await c.stop_notify(FRAMES)
    path = f'captures/{time.strftime("%Y-%m-%d")}-{label}.csv'
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['host_s', 'device_time_us', 'can_id', 'data_hex'])
        for t, i, d in log:
            w.writerow([f'{t:.3f}', 0, f'0x{i:03X}', ' '.join(f'{x:02X}' for x in d)])
    print(f'{len(log)} frames saved to {path}')
    return log


def selftest():
    import random
    random.seed(1)
    log = []
    sched = schedule()
    for step in range(int(sched[-1][2] * 25) - 1):
        t = step / 25
        phase = next(n for n, a, b, _ in sched if a <= t < b)
        lean = {'upright': 0, 'left': -25, 'right': 25}[phase] * 10 + random.randint(-3, 3)  # tenths of a degree
        log.append((t, 0x7F0, struct.pack('>hBBBBBB', lean, 0, 0, 0, random.randint(0, 255), 0, 0)))
        log.append((t, 0x7F1, bytes([random.randint(0, 255)] * 8)))
        log.append((t, 0x120, bytes([0, 0, 0, 8, 0, 0, 0, 0])))
    rows = analyse(log)
    report(rows)
    assert rows and rows[0][1] == 0x7F0 and 'D0-D1 s16 BE' in rows[0][2], 'self-test failed'
    print('self-test ok')


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    elif '--file' in sys.argv:
        report(analyse(load_csv(sys.argv[sys.argv.index('--file') + 1])))
    else:
        report(analyse(asyncio.run(record(sys.argv[1] if len(sys.argv) > 1 else 'lean'))))
