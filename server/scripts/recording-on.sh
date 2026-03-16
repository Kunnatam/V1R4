#!/usr/bin/env bash
# scripts/recording-on.sh - Enable recording mode (route V1R4 audio through BlackHole)
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
SWIFT_SRC=$(mktemp /tmp/create_multi_output.XXXXX.swift)

echo "=== V1R4 Recording Mode: ON ==="

# Check if BlackHole is installed
if ! SwitchAudioSource -a 2>/dev/null | grep -q "BlackHole 2ch"; then
    echo "ERROR: BlackHole 2ch not found. Install with: brew install blackhole-2ch"
    exit 1
fi

# Check if V1R4 Recording device already exists
if SwitchAudioSource -a 2>/dev/null | grep -q "V1R4 Recording"; then
    echo "Multi-output device 'V1R4 Recording' already exists"
else
    echo "Creating multi-output device..."
    cat > "$SWIFT_SRC" << 'SWIFT'
import CoreAudio
import Foundation
func getAllDevices() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices)
    return devices
}
func getDeviceName(deviceID: AudioDeviceID) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: CFString? = nil
    var size = UInt32(MemoryLayout<CFString?>.size)
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &name)
    return status == noErr ? (name as String?) : nil
}
func getDeviceUID(deviceID: AudioDeviceID) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var uid: CFString? = nil
    var size = UInt32(MemoryLayout<CFString?>.size)
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid)
    return status == noErr ? (uid as String?) : nil
}
let devices = getAllDevices()
var speakersUID: String?
var blackholeUID: String?
for device in devices {
    if let name = getDeviceName(deviceID: device), let uid = getDeviceUID(deviceID: device) {
        if name.contains("MacBook Pro Speakers") || name.contains("Built-in Output") { speakersUID = uid }
        else if name.contains("BlackHole 2ch") { blackholeUID = uid }
    }
}
guard let spkUID = speakersUID, let bhUID = blackholeUID else { print("ERROR: Could not find required devices"); exit(1) }
let desc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "V1R4 Recording",
    kAudioAggregateDeviceUIDKey: "com.v1r4.multi-output",
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: spkUID], [kAudioSubDeviceUIDKey: bhUID]],
    kAudioAggregateDeviceMasterSubDeviceKey: spkUID,
    kAudioAggregateDeviceIsStackedKey: 1 as UInt32
]
var aggregateID: AudioDeviceID = 0
let status = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &aggregateID)
if status == noErr { print("Created multi-output device 'V1R4 Recording'") }
else { print("ERROR: Failed to create device (OSStatus: \(status))"); exit(1) }
SWIFT
    swiftc -framework CoreAudio -framework Foundation "$SWIFT_SRC" -o "${SWIFT_SRC%.swift}" 2>/dev/null
    "${SWIFT_SRC%.swift}"
    rm -f "$SWIFT_SRC" "${SWIFT_SRC%.swift}"
fi

# Set V1R4 Recording as default output
SwitchAudioSource -s "V1R4 Recording" -t output
echo "Default output: V1R4 Recording"

# Ensure mic stays as input
SwitchAudioSource -s "MacBook Pro Microphone" -t input
echo "Default input: MacBook Pro Microphone"

# Restart TTS server to pick up new device
echo "Restarting TTS server..."
"$PROJECT_PATH/scripts/stop.sh"
sleep 2
"$PROJECT_PATH/scripts/start.sh"

echo ""
echo "=== Recording mode active ==="
echo "In your recording app, select 'BlackHole 2ch' as input source."
echo "To disable: $PROJECT_PATH/scripts/recording-off.sh"
