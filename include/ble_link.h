#pragma once

namespace BleLink {
void begin();
void update(); // Call from loop(): runs commands and streams frames to the connected client.
bool connected();
}
