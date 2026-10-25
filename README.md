# Adventure 390 CAN workspace

Receive-only Classical CAN reader for an **ESP32-C3 Super Mini + SN65HVD230 (WCMCU-230) module** on a **2026 KTM Adventure 390 Gen 2**, with a Bluetooth Low Energy link to a browser dashboard.

The bike's bus runs at **500 kbit/s** and engine speed decodes at **0x120** (confirmed on this bike). The other built-in signals use the KTM message layout decoded on the 690 Enduro R and 1290 Super Duke ([blalor/ktm-can](https://github.com/blalor/ktm-can)) and still need checking on the 390. Wheel speed and lean angle need calibration. CAN FD is not supported. Passive capture cannot see data that needs diagnostic requests or sits behind a gateway.

## What is included

- **Firmware:** ESP32 TWAI fixed to listen-only, with no transmit API, no diagnostic requests and no transmit queue. Wi-Fi and the web server are gone; the reader is a BLE peripheral named **ADV390-CAN**.
- **Two streaming modes:**
  - *Latest per ID, 25×/s* is the default. It sends the newest frame of each ID that changed, with a count of how many arrived. Bluetooth load stays the same however busy the bus is.
  - *Every frame* sends each frame in order. Use it for CSV logging and for hunting fast-changing bits.
- **Dashboard** (`web/`, an installable offline web app) with four views:
  - **Ride:** gear, speed, RPM bar, coolant, throttle, lean, brake pressure, and clutch, side stand, kill switch and ride mode states.
  - **Bus:** a live table of every ID with changed bytes marked, bitrate and mode control, and CSV export.
  - **Find an ID:** record still, record while operating a control, and get the ranked bytes and bits that responded.
  - **Signals:** the built-in KTM map with live values and status, speed and lean calibration, and your own saved signals, including single-bit flags.
- **Demo:** generated traffic at `?demo=1`, clearly labelled. IDs 0x2A0 and 0x3C1 in the demo are invented.

See **[docs/DECODING.md](docs/DECODING.md)** for how to decode the signals that are not in the built-in map yet.

## Receive-only wiring

Connect and verify with the motorcycle powered off. Identify module pins by their functions, since board labels vary. The SN65HVD230 is a transceiver, and the ESP32-C3 supplies the CAN controller; an MCP2515 or SPI connection is not required.

| ESP32-C3 / connection | SN65HVD230 module | Purpose |
| --- | --- | --- |
| 3V3 | VCC / 3V3 | 3.3 V supply |
| GND | GND | Common signal ground |
| GPIO5 | R / RXD / CRX | Receiver output into ESP32 |
| **3V3** | **D / TXD / CTX** | Holds the transmitter recessive; do not connect this pin to an ESP32 GPIO |
| Verified bike CAN H | CANH | CAN high |
| Verified bike CAN L | CANL | CAN low |
| Verified bike signal ground | GND | Common reference |
| **GPIO4: leave unconnected** | None | Internal TWAI TX routing only |

```text
ESP32-C3                       SN65HVD230                 Bike
3V3 -------------------------- VCC
  +--------------------------- D / TXD  (fixed HIGH)
GND -------------------------- GND ---------------------- signal GND
GPIO5 <----------------------- R / RXD
GPIO4 (unconnected)             CANH --------------------- verified CAN H
                               CANL --------------------- verified CAN L
```

This physical transmit lockout is intentional. Espressif documents a listen-only dominant-bit erratum and a driver workaround. Holding transceiver D high keeps controller TX events off the bus, including during firmware faults or a future software change. Do not leave D floating. The module must use the actual **SN65HVD230**, not a different chip with different voltage requirements.

If RS is exposed, use the module's verified normal high-speed configuration (RS low); do not use standby as a substitute for the D-high connection. Verify any onboard RS bias with the module schematic. Standby receiver timing is different.

Some SN65HVD230 breakout boards include a **120 Ω termination resistor**. Do not add another termination across an already correctly terminated motorcycle bus. Check the module and disable its termination if necessary. With all power removed and the appropriate service procedure followed, a conventional bus with two 120 Ω terminators measures approximately 60 Ω between H and L; actual vehicle topology must be checked rather than assumed. Keep the tap short and use a twisted pair for H/L.

For initial work, power the ESP32 from USB/a USB power bank. **Do not connect bike battery voltage to 3V3, GPIO, or the module.** Permanent bike power requires a suitably protected, fused automotive supply. The bare development boards are not weatherproof or automotive-qualified.

The bike-side connector pin numbers are deliberately not supplied: obtain the exact model/market service diagram or verify the adapter pinout. A generic automotive OBD pinout must not be assumed for a motorcycle connector.

## Build and flash

PlatformIO, pinned `espressif32@6.12.0` (Arduino ESP32 2.0.17) and `NimBLE-Arduino@1.4.3`, `esp32-c3-devkitm-1` profile, 4 MB flash, DIO, native USB CDC. No credentials or per-user settings are needed.

```powershell
# With PlatformIO Core installed for this user:
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run --target upload --upload-port COM3
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" device monitor --port COM3 --baud 115200
```

Replace `COM3` with the actual port (`pio device list`). If native USB does not enumerate, hold **BOOT**, tap **RESET**, release BOOT and retry. The serial monitor prints a status line every 10 seconds; type `i` for one immediately.

`artifacts/adventure390-can-ble.factory.bin` is a combined image (bootloader, partitions, boot data, app) for offset **0x0**:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" "$env:USERPROFILE\.platformio\packages\tool-esptoolpy\esptool.py" --chip esp32c3 --port COM3 --baud 460800 write_flash 0x0 artifacts/adventure390-can-ble.factory.bin
```

Flashing it replaces the saved bitrate. The previous Wi-Fi firmware and sources are kept in `_backup_wifi_version/`.

## Open the dashboard

Web Bluetooth needs Chrome or Edge (Android, Windows, macOS, Linux) and a secure page: **https://** or **localhost**. iPhone Safari has no Web Bluetooth; use the Bluefy browser there.

- **Laptop:** `npm run preview`, then open http://127.0.0.1:3900 and press **Connect**. Node.js 20+; no npm install needed.
- **Phone on the bike:** host the `web/` folder on any static https host (GitHub Pages, Netlify, Vercel, or your own). Open it once online and add it to the home screen; the service worker then lets it open offline. The page talks to the reader directly over Bluetooth. Nothing goes through the host after loading.
- **Demo:** add `?demo=1` to either address.

The phone keeps its screen awake while connected (Screen Wake Lock), and reconnects by itself if the reader drops out of range or reboots.

## Bluetooth protocol

Service `4b544d39-0000-4a10-8c00-ca0000000001`:

| Characteristic | UUID suffix | Use |
| --- | --- | --- |
| Frames | `…0001…` | Notify. Byte 0 = `0x01`, then records: `u32 id` (bit 31 extended, bit 30 remote), `u32 µs since boot (low 32 bits)`, `u16 frames represented`, `u8 dlc`, `dlc` data bytes. Little-endian. |
| Status | `…0002…` | Read. JSON: running, bitrate, mode, received, ids, driverMissed, driverOverruns, busErrors, linkDropped, rawSkipped, error, freeHeap, bootId. |
| Control | `…0003…` | Write. `01 + u32 bitrate` start, `02` stop, `03 00` latest-per-ID mode, `03 01` every-frame mode. |

Records pack into the negotiated MTU (247 requested; at the 23-byte minimum each notification still carries one full 8-byte frame). The connection asks for a 7.5–15 ms interval. There is no pairing: anyone in range can connect and start or stop capture, but nothing can transmit onto the bike's bus.

### Is Bluetooth faster than Wi-Fi?

BLE has **lower** raw bandwidth than Wi-Fi. What it gains here is less work for the ESP32: no TCP/IP, no HTTP, no JSON for every frame, a much smaller radio stack (flash use fell from 62.7 % to 37.3 %), lower power, and no router or hotspot to join. Update latency is lower too, because frames are pushed every 40 ms instead of the browser polling over HTTP. In *Every frame* mode a busy bus can exceed what a given phone accepts; the **Losses** figure on the Bus view counts what was skipped, and *Latest per ID* is the right mode for riding.

## Capture limits and interpretation

- The device keeps the latest **1,024 frames** for raw streaming, the latest frame of up to **128 IDs** for the dashboard stream, and a 256-message driver queue. Nothing is saved to flash.
- Timestamps are microseconds since boot, taken when software dequeues the frame. They are not wire timestamps.
- **Losses** on the Bus view add up: CAN driver misses/overruns, Bluetooth notifications the stack could not queue, and raw frames overwritten before they were sent. Hover it for the breakdown. Bus errors show in the status line; they usually mean a wrong bitrate or wiring.
- In *Latest per ID* mode the CSV holds sampled frames, and the file name says so. Use *Every frame* for complete logs.
- A reader reboot clears the browser capture so two boots are not mixed.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "ADV390-CAN" not in the chooser | Reader powered? Within a few metres? Another phone or laptop still connected? (one client at a time) |
| Connect works, no frames | R/RXD → GPIO5, common ground, CAN H/L the right way round, 500 kbit/s, ignition on |
| Bus errors rise | Wrong bitrate, wiring, grounding or extra termination; disconnect and verify |
| Losses rise in Every frame mode | Expected on a busy bus with some phones; switch back to Latest per ID for the dashboard |
| A built-in value looks wrong | It is a KTM-family mapping; check it on the Bus view and with Find an ID, then add a corrected signal |
| Speed reads high or low | Calibrate on the Signals view at a steady speed |
| Page opens but Connect says no Bluetooth | Use Chrome/Edge over https or localhost; Bluefy on iPhone |
| Bench transmitter retries forever | A listen-only reader does not ACK; add a normal CAN node to the test bus |

## References

- [blalor/ktm-can](https://github.com/blalor/ktm-can): KTM message layout for 0x120, 0x129, 0x12A, 0x12B, 0x290, 0x450, 0x540 (2020 690 Enduro R; original 1290 Super Duke work by Dan Plastina on ADVrider).
- [Espressif ESP32-C3 TWAI driver](https://docs.espressif.com/projects/esp-idf/en/v4.4.8/esp32c3/api-reference/peripherals/twai.html) and [listen-only erratum](https://docs.espressif.com/projects/esp-idf/en/v5.1/esp32c3/api-reference/kconfig.html#config-twai-errata-fix-listen-only-dom).
- [Texas Instruments SN65HVD23x datasheet](https://www.ti.com/lit/ds/symlink/sn65hvd230.pdf).
- [NimBLE-Arduino](https://github.com/h2zero/NimBLE-Arduino) and [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).
