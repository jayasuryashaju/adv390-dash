#include <NimBLEDevice.h>
#include "config.h"
#include "capture.h"
#include "ble_link.h"

// Frames notification layout (little endian), see README "Bluetooth protocol":
//   [0] packet type 0x01, then records of
//   u32 id | 0x80000000 extended | 0x40000000 remote
//   u32 device time, microseconds since boot (low 32 bits)
//   u16 frames of this ID represented by the record (1 in raw mode)
//   u8  dlc, then dlc payload bytes (none for remote frames)
namespace {
constexpr uint8_t PACKET_FRAMES = 0x01;
constexpr size_t RECORD_HEADER = 11;
constexpr uint8_t CMD_START = 0x01, CMD_STOP = 0x02, CMD_MODE = 0x03;

NimBLEServer* server = nullptr;
NimBLECharacteristic* framesChar = nullptr;
NimBLECharacteristic* statusChar = nullptr;
volatile bool clientConnected = false;
volatile bool freshClient = false;
volatile uint16_t payloadLimit = 20; // ATT MTU - 3; Web Bluetooth usually negotiates far more.
volatile uint32_t linkDropped = 0;  // Notifications the BLE stack could not queue.
uint64_t rawSkipped = 0;            // Raw frames overwritten in the ring before BLE sent them.

// Commands arrive on the NimBLE host task and are executed from loop().
volatile uint8_t pendingCommand = 0;
volatile uint32_t pendingArgument = 0;

uint8_t packet[256];
size_t packetLength = 1;
Frame scratch[Config::MAX_IDS];
uint64_t rawCursor = 0;
uint32_t lastChangesAt = 0, lastStatusAt = 0;

void flush() {
  if (packetLength <= 1) return;
  packet[0] = PACKET_FRAMES;
  framesChar->setValue(packet, packetLength);
  framesChar->notify();
  packetLength = 1;
}

void put32(uint32_t value) {
  for (int i = 0; i < 4; ++i) packet[packetLength++] = value >> (8 * i);
}

void append(const Frame& frame) {
  const uint8_t dlc = frame.remote ? 0 : frame.dlc;
  const size_t limit = min<size_t>(payloadLimit, sizeof(packet));
  if (packetLength + RECORD_HEADER + dlc > limit) flush();
  put32(frame.id | (frame.extended ? 0x80000000u : 0) | (frame.remote ? 0x40000000u : 0));
  put32(static_cast<uint32_t>(frame.us));
  packet[packetLength++] = frame.count & 0xff;
  packet[packetLength++] = frame.count >> 8;
  packet[packetLength++] = frame.dlc;
  memcpy(packet + packetLength, frame.data, dlc);
  packetLength += dlc;
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, ble_gap_conn_desc* desc) override {
    clientConnected = true;
    freshClient = true;
    // 7.5–15 ms interval: several notifications per interval keeps latency low.
    s->updateConnParams(desc->conn_handle, 6, 12, 0, 400);
  }
  void onDisconnect(NimBLEServer*, ble_gap_conn_desc*) override {
    clientConnected = false;
    payloadLimit = 20;
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    payloadLimit = mtu > 3 ? mtu - 3 : 20;
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    const NimBLEAttValue value = c->getValue();
    const uint8_t* d = value.data();
    if (value.length() == 5 && d[0] == CMD_START) {
      pendingArgument = d[1] | d[2] << 8 | d[3] << 16 | static_cast<uint32_t>(d[4]) << 24;
      pendingCommand = CMD_START;
    } else if (value.length() == 1 && d[0] == CMD_STOP) {
      pendingCommand = CMD_STOP;
    } else if (value.length() == 2 && d[0] == CMD_MODE && d[1] <= 1) {
      pendingArgument = d[1];
      pendingCommand = CMD_MODE;
    }
  }
};

class FramesCallbacks : public NimBLECharacteristicCallbacks {
  void onStatus(NimBLECharacteristic*, Status status, int) override {
    if (status == Status::ERROR_GATT) ++linkDropped;
  }
};

void runCommand() {
  const uint8_t command = pendingCommand;
  if (!command) return;
  pendingCommand = 0;
  if (command == CMD_START) Capture::start(pendingArgument);
  else if (command == CMD_STOP) Capture::stop();
  else if (command == CMD_MODE) {
    Capture::setMode(pendingArgument ? Capture::Mode::Raw : Capture::Mode::Changes);
    rawCursor = Capture::latestSequence();
  }
  lastStatusAt = 0; // Publish the new state immediately.
}
}

namespace BleLink {
bool connected() { return clientConnected; }

void begin() {
  NimBLEDevice::init(Config::BLE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  NimBLEDevice::setMTU(247);
  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService* service = server->createService(Config::SERVICE_UUID);
  framesChar = service->createCharacteristic(Config::FRAMES_UUID, NIMBLE_PROPERTY::NOTIFY);
  framesChar->setCallbacks(new FramesCallbacks());
  statusChar = service->createCharacteristic(Config::STATUS_UUID, NIMBLE_PROPERTY::READ);
  service->createCharacteristic(Config::CONTROL_UUID, NIMBLE_PROPERTY::WRITE)->setCallbacks(new ControlCallbacks());
  service->start();
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(Config::SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
}

void update() {
  runCommand();
  const uint32_t now = millis();
  if (!clientConnected) return;
  if (now - lastStatusAt >= 250) {
    statusChar->setValue(Capture::statusJson(linkDropped, rawSkipped));
    lastStatusAt = now;
  }
  if (freshClient) {
    freshClient = false;
    rawCursor = Capture::latestSequence();
    Capture::copyChanges(scratch, Config::MAX_IDS); // Discard counts from before the client arrived.
  }
  if (!framesChar->getSubscribedCount()) return;

  if (Capture::mode() == Capture::Mode::Raw) {
    // Bounded per call so commands and status stay responsive on a busy bus.
    uint64_t lost = 0;
    const size_t count = Capture::copyRaw(rawCursor, scratch, 48, lost);
    rawSkipped += lost;
    for (size_t i = 0; i < count; ++i) append(scratch[i]);
    flush();
  } else if (now - lastChangesAt >= Config::CHANGES_PERIOD_MS) {
    lastChangesAt = now;
    const size_t count = Capture::copyChanges(scratch, Config::MAX_IDS);
    for (size_t i = 0; i < count; ++i) append(scratch[i]);
    flush();
  }
}
}
