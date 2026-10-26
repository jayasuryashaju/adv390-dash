"""Record the reader for a fixed time with no prompts, and save a CSV. Listen-only; disconnect the dashboard first.

  python scripts/record_plain.py <label> [seconds]      (default 25 s)
"""
import asyncio, csv, struct, sys, time

SERVICE = '4b544d39-0000-4a10-8c00-ca0000000001'
FRAMES, STATUS, CONTROL = ('4b544d39-000%d-4a10-8c00-ca0000000001' % n for n in (1, 2, 3))


async def main(label, seconds):
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

    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: (d.name or '').startswith('ADV390') or SERVICE in (a.service_uuids or []), timeout=15)
    if not dev:
        sys.exit('Reader not found. Is it powered, and is the dashboard disconnected?')
    async with BleakClient(dev) as c:
        running = b'"running":true' in bytes(await c.read_gatt_char(STATUS)).replace(b' ', b'')
        try:
            await c.write_gatt_char(CONTROL, bytes([3, 0]), response=False)  # latest-per-ID mode
        except Exception as e:
            print('mode command skipped:', e)
        if not running:
            try:
                await c.write_gatt_char(CONTROL, bytes([1, 0x20, 0xA1, 0x07, 0x00]), response=False)
            except Exception as e:
                print('start command skipped:', e)
        await asyncio.sleep(0.5)
        t0 = time.monotonic()
        await c.start_notify(FRAMES, on_packet)
        print(f'Recording {seconds} s ...')
        await asyncio.sleep(seconds)
        await c.stop_notify(FRAMES)
    path = f'captures/{time.strftime("%Y-%m-%d")}-{label}.csv'
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['host_s', 'device_time_us', 'can_id', 'data_hex'])
        for t, i, d in log:
            w.writerow([f'{t:.3f}', 0, f'0x{i:03X}', ' '.join(f'{x:02X}' for x in d)])
    print(f'{len(log)} frames saved to {path}')


asyncio.run(main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 25))
