#include <Arduino.h>
#include <Preferences.h>
#include <driver/twai.h>
#include <esp_timer.h>
#include "config.h"
#include "capture.h"
#include "ble_link.h"

namespace {
struct IdSlot {
  Frame frame;
  uint16_t pending; // Frames since the last copyChanges().
  bool used;
};

Preferences preferences;
SemaphoreHandle_t captureMutex;
Frame ring[Config::RING_SIZE]{};
IdSlot slots[Config::MAX_IDS]{};
size_t slotCount = 0;
uint32_t slotOverflow = 0; // Frames whose ID did not fit in the table.
uint64_t sequence = 0;
uint64_t lastFrameUs = 0;
uint32_t bitrate = Config::DEFAULT_BITRATE;
uint32_t savedMissed = 0, savedOverruns = 0, savedErrors = 0;
bool installed = false, running = false;
esp_err_t lastError = ESP_OK;
Capture::Mode currentMode = Capture::Mode::Changes;
String bootId;

String number(uint64_t value) {
  char out[24];
  snprintf(out, sizeof(out), "%llu", static_cast<unsigned long long>(value));
  return String(out);
}

bool validBitrate(uint32_t value) {
  return value == 125000 || value == 250000 || value == 500000 || value == 1000000;
}

twai_timing_config_t timingFor(uint32_t value) {
  switch (value) {
    case 125000: { twai_timing_config_t t = TWAI_TIMING_CONFIG_125KBITS(); return t; }
    case 250000: { twai_timing_config_t t = TWAI_TIMING_CONFIG_250KBITS(); return t; }
    case 1000000: { twai_timing_config_t t = TWAI_TIMING_CONFIG_1MBITS(); return t; }
    default: { twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS(); return t; }
  }
}

// Caller owns captureMutex. Driver operations and reception cannot overlap.
esp_err_t stopLocked() {
  if (!installed) return ESP_OK;
  twai_status_info_t status{};
  twai_get_status_info(&status);
  if (running) {
    esp_err_t result = twai_stop();
    if (result != ESP_OK) return result;
    running = false;
  }
  esp_err_t result = twai_driver_uninstall();
  if (result == ESP_OK) {
    installed = false;
    savedMissed += status.rx_missed_count;
    savedOverruns += status.rx_overrun_count;
    savedErrors += status.bus_error_count;
  }
  return result;
}

esp_err_t startLocked(uint32_t rate) {
  esp_err_t result = stopLocked();
  if (result != ESP_OK) return result;
  twai_general_config_t general = TWAI_GENERAL_CONFIG_DEFAULT(Config::CAN_TX, Config::CAN_RX, TWAI_MODE_LISTEN_ONLY);
  general.tx_queue_len = 0; // No transmission queue and no transmit API anywhere.
  general.rx_queue_len = 256;
  general.alerts_enabled = TWAI_ALERT_NONE;
  auto timing = timingFor(rate);
  twai_filter_config_t filter = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  result = twai_driver_install(&general, &timing, &filter);
  if (result != ESP_OK) return result;
  installed = true;
  bitrate = rate;
  result = twai_start();
  if (result == ESP_OK) running = true;
  else { twai_driver_uninstall(); installed = false; }
  return result;
}

// Caller owns captureMutex.
void remember(const Frame& frame) {
  for (size_t i = 0; i < slotCount; ++i) {
    IdSlot& slot = slots[i];
    if (slot.frame.id == frame.id && slot.frame.extended == frame.extended && slot.frame.remote == frame.remote) {
      slot.frame = frame;
      if (slot.pending < UINT16_MAX) ++slot.pending;
      return;
    }
  }
  if (slotCount == Config::MAX_IDS) { ++slotOverflow; return; }
  slots[slotCount++] = {frame, 1, true};
}

void receiveTask(void*) {
  for (;;) {
    xSemaphoreTake(captureMutex, portMAX_DELAY);
    if (running) {
      twai_message_t message{};
      // Bounded batches prevent a saturated CAN bus starving the BLE task.
      for (size_t n = 0; n < 64; ++n) {
        if (twai_receive(&message, 0) != ESP_OK) break;
        Frame frame{};
        frame.seq = ++sequence;
        frame.us = esp_timer_get_time(); // Software dequeue time, not wire timestamp.
        frame.id = message.identifier;
        frame.count = 1;
        frame.dlc = min(static_cast<uint8_t>(8), message.data_length_code);
        frame.extended = message.extd;
        frame.remote = message.rtr;
        if (!frame.remote) memcpy(frame.data, message.data, frame.dlc);
        ring[(frame.seq - 1) % Config::RING_SIZE] = frame;
        remember(frame);
        lastFrameUs = frame.us;
      }
    }
    xSemaphoreGive(captureMutex);
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

void report() {
  Serial.printf("\nADV390 CAN | listen-only GPIO%d | %lu bit/s | %s | %llu frames | %u IDs | BLE %s\n",
                Config::CAN_RX, (unsigned long)bitrate, running ? "running" : "stopped",
                static_cast<unsigned long long>(sequence), (unsigned)slotCount,
                BleLink::connected() ? "connected" : "advertising");
}
}

namespace Capture {
esp_err_t start(uint32_t rate) {
  if (!validBitrate(rate)) return ESP_ERR_INVALID_ARG;
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  lastError = startLocked(rate);
  const esp_err_t result = lastError;
  xSemaphoreGive(captureMutex);
  if (result == ESP_OK) preferences.putUInt("bitrate", rate);
  return result;
}

esp_err_t stop() {
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  lastError = stopLocked();
  const esp_err_t result = lastError;
  xSemaphoreGive(captureMutex);
  return result;
}

void setMode(Mode mode) { currentMode = mode; }
Mode mode() { return currentMode; }

uint64_t latestSequence() {
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  const uint64_t latest = sequence;
  xSemaphoreGive(captureMutex);
  return latest;
}

size_t copyRaw(uint64_t& cursor, Frame* out, size_t max, uint64_t& lost) {
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  const uint64_t latest = sequence;
  const uint64_t earliest = latest >= Config::RING_SIZE ? latest - Config::RING_SIZE + 1 : 1;
  if (cursor > latest) cursor = latest;
  lost = cursor + 1 < earliest ? earliest - cursor - 1 : 0;
  uint64_t seq = cursor + 1 < earliest ? earliest : cursor + 1;
  size_t count = 0;
  for (; seq <= latest && count < max; ++seq) out[count++] = ring[(seq - 1) % Config::RING_SIZE];
  if (count) cursor = out[count - 1].seq;
  else if (lost) cursor = latest;
  xSemaphoreGive(captureMutex);
  return count;
}

size_t copyChanges(Frame* out, size_t max) {
  size_t count = 0;
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  for (size_t i = 0; i < slotCount && count < max; ++i) {
    IdSlot& slot = slots[i];
    if (!slot.pending) continue;
    out[count] = slot.frame;
    out[count++].count = slot.pending;
    slot.pending = 0;
  }
  xSemaphoreGive(captureMutex);
  return count;
}

String statusJson(uint32_t linkDropped, uint64_t rawSkipped) {
  twai_status_info_t driver{};
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  if (installed) twai_get_status_info(&driver);
  String body = "{\"bootId\":\"" + bootId + "\"";
  body += ",\"running\":" + String(running ? "true" : "false");
  body += ",\"bitrate\":" + String(bitrate);
  body += ",\"mode\":\"" + String(currentMode == Mode::Raw ? "raw" : "changes") + "\"";
  body += ",\"received\":" + number(sequence);
  body += ",\"lastFrameUs\":" + number(lastFrameUs);
  body += ",\"uptimeUs\":" + number(esp_timer_get_time());
  body += ",\"ids\":" + String(slotCount) + ",\"idOverflow\":" + String(slotOverflow);
  body += ",\"driverMissed\":" + String(savedMissed + driver.rx_missed_count);
  body += ",\"driverOverruns\":" + String(savedOverruns + driver.rx_overrun_count);
  body += ",\"busErrors\":" + String(savedErrors + driver.bus_error_count);
  body += ",\"linkDropped\":" + String(linkDropped) + ",\"rawSkipped\":" + number(rawSkipped);
  body += ",\"error\":\"" + String(lastError == ESP_OK ? "" : esp_err_to_name(lastError)) + "\"";
  xSemaphoreGive(captureMutex);
  body += ",\"freeHeap\":" + String(ESP.getFreeHeap()) + "}";
  return body;
}
}

void setup() {
  Serial.begin(115200); // Never wait for USB: standalone power must work.
  captureMutex = xSemaphoreCreateMutex();
  if (!captureMutex) { Serial.println("Capture mutex allocation failed"); return; }
  char randomValue[17];
  snprintf(randomValue, sizeof(randomValue), "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
  bootId = randomValue;
  preferences.begin("can-reader", false);
  uint32_t saved = preferences.getUInt("bitrate", Config::DEFAULT_BITRATE);
  if (!validBitrate(saved)) saved = Config::DEFAULT_BITRATE;
  Capture::start(saved);
  if (xTaskCreate(receiveTask, "can-rx", 4096, nullptr, 2, nullptr) != pdPASS) {
    Capture::stop(); lastError = ESP_ERR_NO_MEM;
  }
  BleLink::begin();
  report();
}

void loop() {
  static uint32_t lastReportAt = 0;
  if (!captureMutex) { delay(1000); return; }
  BleLink::update();
  while (Serial.available()) {
    const int c = Serial.read();
    if (c == 'i' || c == 'I') { report(); lastReportAt = millis(); }
  }
  if (Serial && millis() - lastReportAt >= 10000) { report(); lastReportAt = millis(); }
  delay(2);
}
