#!/bin/sh
# Run after `npx cap add ios`: Bluetooth permission text, all orientations, no status bar.
set -e
PLIST=ios/App/App/Info.plist
B=/usr/libexec/PlistBuddy
$B -c "Add :NSBluetoothAlwaysUsageDescription string 'Connects to your ADV390-CAN reader to show live bike data.'" $PLIST
$B -c "Add :NSBluetoothPeripheralUsageDescription string 'Connects to your ADV390-CAN reader to show live bike data.'" $PLIST
$B -c "Add :UIStatusBarHidden bool true" $PLIST || true
$B -c "Add :UIViewControllerBasedStatusBarAppearance bool false" $PLIST || true
$B -c "Set :CFBundleDisplayName 'ADV390 Dash'" $PLIST || true
