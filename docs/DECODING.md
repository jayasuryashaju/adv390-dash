# Decoding the rest of the bus

This is how to turn an unknown CAN ID on the 390 Adventure into a named signal. Do every step with the bike on its stand and the engine off unless a step says otherwise. For anything that needs riding, have a second person hold the phone, or log to CSV and look later.

## What is already mapped

| Signal | ID | Status |
| --- | --- | --- |
| Engine speed | 0x120 D0–D1 | Confirmed on your bike |
| Gear, clutch lever | 0x129 D0 high nibble, D0 bit 0x08 | Confirmed on your bike |
| Front brake pressure | 0x290 D0–D1 | Confirmed on your bike |
| Brake light (front or rear) | 0x290 D3: 02 off, 0E on | Confirmed on your bike |
| Rear brake | 0x12F D0–D1 rises 50–90 above its resting level (~304; drifts) with the pedal, unchanged by the front | From your captures |
| Coolant | 0x540 D5–D6 ÷ 10 °C | From your capture (96.2 °C just after engine off); check against the dash |
| Throttle grip | 0x120 D2: 0 closed – 253 open | Confirmed on your bike |
| Throttle closed switch | 0x128 D2: 03 closed, 02 open | Confirmed on your bike |
| Start button | 0x120 D3 bit 0x10: set while pressed | Confirmed on your bike (D3 = 18 with RUN) |
| Kill switch | 0x120 D3 bit 0x08: set = RUN | Confirmed on your bike (690 used bit 0x10) |
| Side stand | 0x540 D3 bit 0x01: set = up | Confirmed on your bike (690 used D4) |
| Ride mode | 0x120 D4: 0, 2, 1 (also 0x541 D2 08/48/28) | From your capture; names assumed Street / Rain / Offroad |
| Traction control | 0x12A D1: 28 on, 18 off (also 0x450 D4 bit 0x08, 0x12A D4 bit 0x20); Offroad ride mode turns it off | Confirmed on your bike |
| ABS mode | 0x450 D3: 01 / 02 (also 0x12A D6 02/04, 0x12A D4 bit 0x08) | From your capture; assumed 01 Road, 02 Offroad |
| Rear wheel speed | 0x12D D1–D2 (D2 seen up to 82 hand-spinning; cuts to 0 when the wheel stops) | From your capture; unit guessed 0.1 km/h, calibrate against the dash |
| Vehicle speed, smoothed | 0x12E D1–D2 ≈ 0.7 × 0x12D, fades out after the wheel stops | From your capture |
| Front wheel speed, tilt, lean | 0x12B | **Not sent on your bike**; front wheel still to be found |
| Traction control button | 0x450 D2 bit 0x01 | KTM family: check |
| Slow RPM | 0x540 D1–D2 | KTM family: check |

These came from a 690 Enduro R and a 1290 Super Duke. Your RPM matching at 0x120 suggests the 390 Adventure uses the same layout, but the Gen 2 bike has different electronics, so each one needs a quick check (see "Check the built-in map" below).

## What your bike actually sends

Captured 2026-10-25, ignition on, engine just switched off (`captures/2026-10-25-ignition-on-engine-off-warm.csv`), about 1,060 frames/s:

| ID | Rate | Notes |
| --- | --- | --- |
| 0x120, 0x129, 0x290, 0x540 | 50 / 50 / 100 / 10 Hz | Mapped (see above). D7 on most IDs is an alive counter |
| 0x121, 0x128, 0x12A, 0x12D, 0x12E | 50–100 Hz | Static with the engine off: capture again riding |
| 0x12F | 100 Hz | D1 bit 0x20 flips in irregular bursts: a switch or status bit, still unidentified (checked against the rear brake on 2026-10-25 without a clear match) |
| 0x176, 0x177 | 100 Hz | D0/D4 (0x176) and D4 (0x177) jitter at rest, D6 low nibble counts 0–F, D7 looks like a checksum: **IMU or ABS data, best candidates for lean and wheel speed** |
| 0x450 | 20 Hz | D2 = 0x80, not the 690's TC bit |
| 0x541 | 50 Hz | D6 counts up by exactly 1 per second: a running timer, not a sensor |
| 0x553, 0x55A | 1 Hz | Slow and static: odometer, trip or service data candidates. 0x55A D1–D2 = 0x53B6 = 21,430 |
| 0x551, 0x5A0, 0x5A2, 0x5B0, 0x6B9 | 10–50 Hz | Static with the engine off |
| 0x6A6, 0x6A7, 0x6A8 | 40 Hz | Multi-frame content (D0 = 0x0F/0x30 framing): likely the dash or diagnostic transport, not live sensor data |

To find speed: record "still" on the stand, then "with control" while turning the rear wheel in gear on the stand (engine running, second person). Check 0x12F, 0x176 and 0x177 first.

## Power while starting

The CAN bus keeps running while the starter cranks (about 1,060 frames/s straight through a start, `captures/2026-10-25-engine-start-usb-power.csv`). The bike's **USB-C socket does switch off while cranking**, so a reader powered from it reboots on every start and drops Bluetooth for a few seconds. Power the reader from a power bank, or a supply that rides through cranking.

## What is not mapped yet

| Signal | Kind | Method |
| --- | --- | --- |
| Left / right indicator, hazards | Switch | **Not on this bus** (tested 2026-10-25, `captures/2026-10-25-indicators-hazard.csv`). Needs a wire tap: optocoupler to a spare GPIO |
| High / low beam | Switch | **Not on this bus** (tested 2026-10-25, `captures/2026-10-25-high-low-beam.csv`). Same wire-tap option |
| Horn | Switch | Find an ID, toggle |
| Front brake light switch | Switch | Find an ID, toggle (0x290 is pressure, not the switch) |
| ABS mode (road / offroad / off), cornering ABS | Setting | Find an ID while changing it in the dash menu |
| Ride mode name (Street / Rain / Offroad) | Setting | Find an ID; the 690's single bit may not cover three modes |
| Handlebar menu buttons | Switch | Find an ID, one button at a time |
| ABS / traction control intervention | Event | Logging, below |
| Fuel level | Slow value | Logging, below (the dashboard's trips do not need it) |
| Ambient air temperature | Slow value | Logging, below |
| Battery voltage | Slow value | Logging, below |
| Fuel flow | 0x540 D1 (D2 assumed high byte): fuel per second; 0 off, 27 just after start, 19–22 idling | From your capture; scale set by a brim-to-brim fill-up (Signals → Fuel) |
| Engine run timer | 0x541 D4 counts seconds since start (D5 resets at start) | From your capture |
| Odometer | 0x55A D0–D2 ÷ 10 km | Confirmed on your bike (21430 = dash 2,143 km) |
| Trip | Counter | Logging, below |

Some of these may not be on the bus you are tapping. The dash may read fuel or ambient temperature from its own sensor, or the data may sit behind a gateway. If a careful search finds nothing, that is a real answer.

## Method 1: Find an ID (switches and settings)

1. Connect, open **Bus**, set **Send from device** to **Every frame**. The default mode samples every 40 ms and can hide a short tap.
2. Ignition on. Turn on everything you will not be testing that should stay on, and leave it alone.
3. Open **Find an ID**, pick the control.
4. **Record still**: do nothing for 5 seconds.
5. **Record with control**: work it several times in 8 seconds. For held controls (high beam), switch it on *before* you press record and leave it on.
6. Read the list. The best candidate is usually a single bit that flipped as many times as you pressed the control, and was steady when still.
7. Repeat the action and watch the **Live** column. The right row says on and off in step with your hand.
8. Press **Save**. The signal appears on the Signals view, and its ID gets a label on the Bus view.

When the result is noisy, look for what is fooling it:

- **Rolling counters** change in every frame, so they also change while still and are ignored. On KTM IDs, D7 often counts 0x20, 0x40, 0x60… as an alive counter.
- **Indicators** flash, so their bit flips roughly twice per second whether you press once or three times. That is the right answer.
- **A bit that changes once** is often a second effect, such as a dash lamp or the ECU reacting. Repeat the test; a real switch follows you every time.
- **Engine running** adds idle jitter, which is fine. But the radiator fan or charging changes can turn up as false positives, so test with the engine off when the control allows.

## Method 2: Log and compare (slow values, counters, events)

The hunter compares two short recordings, so it cannot see a value that changes over minutes. For those:

1. Set **Every frame**. Clear the capture. Record for the whole session, then **Export CSV**.
2. Make the value change in a known direction during the log:
   - **Fuel level**: log before and after filling up. Look for a byte that is steady for long stretches, then steps in the direction of the fill. It may be in percent, litres × 10, or raw sender resistance (the opposite direction).
   - **Ambient temperature**: start the bike cold, then park in the sun or a warm garage. Car-style encodings are °C + 40, or °C × 2 + 40 in one byte; compare against the dash reading.
   - **Battery voltage**: engine off (about 12.4–12.8 V), then running (about 13.8–14.4 V). Expect a byte that jumps by about 15 on a 0.1 V scale, or a 16-bit value in millivolts.
   - **Odometer and trip**: ride a known distance. Look for a 2–4-byte big-endian value that only ever increases, by an amount proportional to the distance. Odometers often update once every 100 m or every 1 km.
   - **ABS or traction control intervention**: on a loose surface, safely, with a second person. Log, note the time of each intervention, then look for bits that flip only at those times.
3. Open the CSV (Excel, LibreOffice, or the Python below). For each ID and byte, plot or scan the value against `device_time_us`.
4. When you have a candidate, enter it with **Add signal**: ID, first byte, length, byte order (KTM uses big-endian), scale and offset so that `value = raw × scale + offset`.

This prints, for every ID and byte, how often it changed and its range: the first pass to separate counters, constants and real signals.

```python
import csv, collections
seen = collections.defaultdict(list)
for row in csv.DictReader(open('adv390-can.csv')):
    data = [int(b, 16) for b in row['data_hex'].split()]
    for i, b in enumerate(data):
        seen[(row['can_id'], i)].append(b)
for (cid, i), vals in sorted(seen.items()):
    changes = sum(a != b for a, b in zip(vals, vals[1:]))
    if 0 < changes < len(vals) // 4:  # skips constants and every-frame counters
        print(f'{cid} D{i}: {changes:5} changes, range {min(vals):02X}-{max(vals):02X}, first {vals[0]:02X} last {vals[-1]:02X}')
```

## Check the built-in map

Each step takes a minute. Watch the **Live** column on Signals.

| Signal | Test | Expected |
| --- | --- | --- |
| Gear | Ignition on, engine off, roll the bike while selecting each gear | N, 1–6 matching the dash. If it reads wrong, check 0x540 "Gear (slow)" too |
| Clutch | Pull and release the lever | 1 / 0 |
| Side stand | Raise and lower it | 1 = up |
| Kill switch | Flip it | 1 = run |
| Coolant | Cold start, then warm up | Starts near air temperature, ends near the dash reading |
| Throttle | Engine off, ignition on, twist the grip | 0 → about 100 (ride-by-wire reports the commanded value) |
| Ride mode | Change mode in the menu | Active (0x120) and requested (0x12A) bits change; may need a closed throttle |
| Front brake | Squeeze the lever | Rises with lever force |
| Wheel speed | On the stand in first gear, or riding | Rear moves on the stand, front only when riding |
| Lean | Lean the bike on the stand | Raw value moves smoothly, sign flips left to right |

If a signal fails, open **Bus**, filter to its ID and do the test again. You will usually see the right byte change nearby, maybe in a different byte or nibble. Add the corrected version as your own signal. If the whole ID is missing, the 390 does not send it on this bus; use Find an ID.

## Calibrating wheel speed and lean

The raw wheel speed unit is unknown. On the Signals view, ride at a steady speed and enter what the speedometer says. The scale becomes `dash ÷ raw front wheel`. Speedometers read a few percent high, so for true speed calibrate against GPS instead.

For lean, hold the bike upright and press **Set upright as zero**. Then lean it to a known angle against a phone level, enter that angle, and press **Calibrate lean**. The raw signal is a signed 12-bit value from the IMU.

## Patterns that recur on KTM IDs

- Big-endian 16-bit values (`D0 × 256 + D1`).
- Flags as single bits, often several in one byte. A bit mask with length 1 reads them (mask 0x10 reads bit 4 as 0/1).
- Nibbles: gear in the high nibble, other states in the low.
- 12-bit signed pairs packed into three bytes (0x12B tilt and lean).
- Temperatures in tenths of a degree (0x540), or with a +40 offset on other makes.
- An alive counter in D7 that steps by 0x20.

When you confirm or correct a mapping, update `KTM_MAP` and `decodeKtm` in `web/core.mjs` so it becomes part of the dashboard, and change its status to `confirmed`.
