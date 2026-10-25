#pragma once
#include <Arduino.h>
#include <esp_err.h>

struct Frame {
  uint64_t seq;
  uint64_t us;
  uint32_t id;
  uint16_t count; // Frames of this ID folded into this record (changes mode); 1 for raw.
  uint8_t dlc;
  bool extended;
  bool remote;
  uint8_t data[8];
};

namespace Capture {
enum class Mode : uint8_t { Changes = 0, Raw = 1 };

esp_err_t start(uint32_t bitrate); // Saves the bitrate on success.
esp_err_t stop();
void setMode(Mode mode);
Mode mode();

// Raw mode: frames after `cursor`, oldest first. `lost` counts ring entries overwritten before copy.
size_t copyRaw(uint64_t& cursor, Frame* out, size_t max, uint64_t& lost);
// Changes mode: latest frame of every ID that arrived since the previous call.
size_t copyChanges(Frame* out, size_t max);
// Raw cursor positioned at the newest frame, so a new client starts live.
uint64_t latestSequence();

String statusJson(uint32_t linkDropped, uint64_t rawSkipped);
}
