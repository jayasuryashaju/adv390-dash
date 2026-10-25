#pragma once
#include <driver/gpio.h>

namespace Config {
// D/TXD on the transceiver is tied to 3.3 V, NOT this GPIO. See README.
constexpr gpio_num_t CAN_TX = GPIO_NUM_4;
constexpr gpio_num_t CAN_RX = GPIO_NUM_5;
constexpr uint32_t DEFAULT_BITRATE = 500000; // Confirmed on the owner's bike (RPM decodes at 0x120).

constexpr size_t RING_SIZE = 1024;   // Every received frame, for raw streaming.
constexpr size_t MAX_IDS = 128;      // Latest frame per identifier, for "changes" streaming.

// Bluetooth Low Energy. The ESP32-C3 has no Bluetooth Classic, so this is BLE GATT.
constexpr char BLE_NAME[] = "ADV390-CAN";
constexpr char SERVICE_UUID[] = "4b544d39-0000-4a10-8c00-ca0000000001";
constexpr char FRAMES_UUID[]  = "4b544d39-0001-4a10-8c00-ca0000000001"; // notify: packed frames
constexpr char STATUS_UUID[]  = "4b544d39-0002-4a10-8c00-ca0000000001"; // read: JSON status
constexpr char CONTROL_UUID[] = "4b544d39-0003-4a10-8c00-ca0000000001"; // write: commands
constexpr uint32_t CHANGES_PERIOD_MS = 40; // 25 dashboard updates per second.
}
