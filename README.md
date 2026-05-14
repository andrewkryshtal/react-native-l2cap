# react-native-l2cap

> A React Native [Nitro](https://nitro.margelo.com) module for **BLE L2CAP Connection-Oriented Channels**. Scan, connect, and stream raw bytes — zero-copy — between phones and any L2CAP-speaking peripheral.

[![Version](https://img.shields.io/npm/v/react-native-l2cap.svg)](https://www.npmjs.com/package/react-native-l2cap)
[![Downloads](https://img.shields.io/npm/dm/react-native-l2cap.svg)](https://www.npmjs.com/package/react-native-l2cap)
[![License](https://img.shields.io/npm/l/react-native-l2cap.svg)](./LICENSE)

```ts
import { L2cap, stringToBuffer, bufferToString } from 'react-native-l2cap'

L2cap.onDeviceFound((d) => console.log(`📡 ${d.name ?? d.id}  ${d.rssi} dBm`))
L2cap.onDataReceived((buf) => console.log('rx:', bufferToString(buf)))

L2cap.startScan()
await L2cap.connect(deviceId, 0x80, /* secure */ false)
L2cap.sendData(stringToBuffer('hello world'))
```

---

## Why?

The standard React Native BLE story — `react-native-ble-plx`, `react-native-ble-manager` — gives you **GATT**. GATT is great for tiny notifications and 20-byte characteristics, but it's a terrible transport for anything that looks like a stream: large file transfers, audio, telemetry bursts, custom binary protocols.

**L2CAP CoC** (Connection-Oriented Channel) is the BLE-level equivalent of a TCP socket. You get:

- Bidirectional, byte-oriented framing
- Hundreds of kbit/s of usable throughput on modern hardware
- No GATT MTU dance, no notification subscription per-byte
- No pairing dialog if you don't want one

This library wraps **CoreBluetooth** on iOS and **`BluetoothSocket` + `BluetoothLeScanner`** on Android behind a single Nitro spec, so JS sees the same surface on both platforms.

## Features

- 🛰  **BLE scan** with rich device metadata (id, name, RSSI)
- 🔌  **L2CAP CoC connect/disconnect** with `Promise`-based errors
- 🔓  **Secure & insecure channels** — bypass the pairing dialog when the peer allows it
- 🚀  **Zero-copy `ArrayBuffer` I/O** — no Base64 stringification at the bridge
- 🧰  **Built-in encoding helpers** — UTF-8, hex, and back
- 📦  **Expo Config Plugin** for one-line permissions setup
- 🏎  Built on [Nitro Modules](https://nitro.margelo.com) — synchronous JSI calls, no event-emitter bridges

## Requirements

| | Minimum |
|---|---|
| **React Native** | 0.76 (new arch). 0.84 recommended. |
| **Node** | 22.11 |
| **iOS** | 13.0 (CBL2CAPChannel was added in iOS 11, but Nitro requires 13) |
| **Android** | API 29 / Android 10 (L2CAP CoC was added in API 29) |
| **Peer dep** | `react-native-nitro-modules` |

## Install

```sh
npm install react-native-l2cap react-native-nitro-modules
```

```sh
# iOS — refresh the Pods after install:
cd ios && pod install
```

The package is **autolinked** through Nitro's autolinking step — no manual `Podfile` or `MainApplication.kt` edits required.

## Platform setup

### iOS

Add two usage descriptions to your app's `Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>We use Bluetooth to talk to nearby L2CAP-capable devices.</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>We use Bluetooth to talk to nearby L2CAP-capable devices.</string>
```

> ⚠️  L2CAP CoC works on **physical devices only** — the iOS Simulator has no Bluetooth radio.

### Android

The library's `AndroidManifest.xml` already declares the right permissions and merges them into your app — you don't need to copy them. You **do** still need to request the runtime permissions yourself:

```ts
import { PermissionsAndroid, Platform } from 'react-native'

async function requestBlePermissions() {
  if (Platform.OS !== 'android') return true
  const api = typeof Platform.Version === 'number' ? Platform.Version : 0
  const perms =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  const result = await PermissionsAndroid.requestMultiple(perms)
  return perms.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED)
}
```

`BLUETOOTH_SCAN` is declared with `android:usesPermissionFlags="neverForLocation"`, so users are not prompted for Location on Android 12+.

### Expo

The package ships a config plugin. Just add it to `app.json` / `app.config.[tj]s`:

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-l2cap",
        {
          "iosUsageDescription": "We use Bluetooth to connect to your tracker.",
          "neverForLocation": true
        }
      ]
    ]
  }
}
```

Then prebuild:

```sh
npx expo prebuild
```

| Option | Default | What it does |
|---|---|---|
| `iosUsageDescription` | generic copy | `NSBluetoothAlwaysUsageDescription` value |
| `iosPeripheralUsageDescription` | falls back to `iosUsageDescription` | `NSBluetoothPeripheralUsageDescription` value |
| `neverForLocation` | `true` | Adds `android:usesPermissionFlags="neverForLocation"` to `BLUETOOTH_SCAN` |

## API

All members live on the singleton `L2cap` exported from the package root.

### `startScan(): void`

Begin a BLE scan. Discovered peripherals are reported through `onDeviceFound`.

> Stop scanning before connecting — Apple recommends this and the radio handles connections more reliably.

### `stopScan(): void`

Stop the active scan. Safe to call when no scan is in progress.

### `onDeviceFound(callback: (device: Device) => void): void`

Subscribe to discovery events. Each subsequent call **replaces** the previous callback — there is no listener list to manage. **Detach on unmount by passing a no-op**, otherwise native code keeps a reference to the React closure:

```ts
useEffect(() => {
  L2cap.onDeviceFound(handleDevice)
  return () => L2cap.onDeviceFound(() => {})
}, [])
```

`Device` shape:

```ts
type Device = {
  id: string      // MAC address on Android, UUID on iOS
  name?: string   // human-readable name when advertised
  rssi: number    // signal strength, dBm (negative is normal)
}
```

### `connect(address, psm, secure): Promise<void>`

Opens an L2CAP CoC channel.

| Parameter | Type | Meaning |
|---|---|---|
| `address` | `string` | The `id` from a `Device` (MAC on Android, UUID on iOS). |
| `psm` | `number` | The remote channel's Protocol/Service Multiplexer. |
| `secure` | `boolean` | `false` → insecure channel, **no pairing dialog**. `true` → encrypted channel (Android: `createL2capChannel`; iOS: relies on the peer being configured for encryption). |

Rejections come back as `Error` with one of:

- `"Device not found"`
- `"L2CAP Channel Refused: <native message>"`
- `"Bluetooth is not powered on"` / `"Bluetooth disabled"`
- `"Missing BLUETOOTH_CONNECT permission"`
- `"L2CAP CoC requires Android Q (API 29) or newer"`

### `disconnect(): void`

Tears down the open channel and disconnects the peripheral. No-op when nothing is connected.

### `isConnected: boolean`

A getter that reflects whether a channel is currently open. Useful as a guard before `sendData`.

### `sendData(data: ArrayBuffer): void`

Writes the buffer to the remote peer.

- **Zero-copy** at the JS↔native boundary.
- Backpressure is handled internally: on iOS, writes that don't fit the output stream are re-posted on the manager queue; on Android, writes are serialized on a dedicated IO coroutine.
- Safe to call from any JS context. If the channel is closed at the moment of the call, the bytes are silently dropped and a warning is logged natively.

### `onDataReceived(callback: (data: ArrayBuffer) => void): void`

Subscribe to incoming bytes. Same single-listener / detach-on-unmount semantics as `onDeviceFound`. The `data` buffer is **owned by Nitro** — copy it (e.g. via `bufferToString` or `new Uint8Array(data).slice()`) if you need to hold onto it past the callback.

## Encoding helpers

Convenience pure functions that ship alongside the module. No `TextEncoder` dependency — they work the same on every JS engine.

```ts
import {
  stringToBuffer,
  bufferToString,
  bufferToHex,
  hexToBuffer,
} from 'react-native-l2cap'
```

| Function | Description |
|---|---|
| `stringToBuffer(text)` | UTF-8 encode a JS string into a fresh `ArrayBuffer`. |
| `bufferToString(buf)` | UTF-8 decode an `ArrayBuffer` to a string. Invalid bytes → `U+FFFD`. |
| `bufferToHex(buf, sep = ' ')` | Format as hex: `"de ad be ef"` or compact `"deadbeef"` with `sep = ''`. |
| `hexToBuffer(hex)` | Parse a hex string back into an `ArrayBuffer`. Tolerates whitespace, `:`, `-`, `_` separators. Throws on bad input. |

## Complete example

A condensed test bench — see [`example/App.tsx`](./example/App.tsx) for the full version with a UI.

```tsx
import { useEffect, useState } from 'react'
import { Button, FlatList, Text, TextInput, View } from 'react-native'
import {
  L2cap,
  bufferToHex,
  bufferToString,
  stringToBuffer,
  type Device,
} from 'react-native-l2cap'

export default function App() {
  const [devices, setDevices] = useState<Device[]>([])
  const [selected, setSelected] = useState<Device | null>(null)
  const [outgoing, setOutgoing] = useState('')

  useEffect(() => {
    L2cap.onDeviceFound((d) =>
      setDevices((all) => (all.find((x) => x.id === d.id) ? all : [...all, d])),
    )
    L2cap.onDataReceived((buf) =>
      console.log('rx:', bufferToHex(buf), '«', bufferToString(buf), '»'),
    )
    return () => {
      L2cap.onDeviceFound(() => {})
      L2cap.onDataReceived(() => {})
      L2cap.stopScan()
      L2cap.disconnect()
    }
  }, [])

  return (
    <View style={{ padding: 24 }}>
      <Button title="Scan" onPress={() => L2cap.startScan()} />
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => (
          <Text onPress={() => setSelected(item)}>
            {item.name ?? item.id} — {item.rssi} dBm
          </Text>
        )}
      />
      <Button
        title="Connect"
        disabled={!selected}
        onPress={() => selected && L2cap.connect(selected.id, 0x80, false)}
      />
      <TextInput value={outgoing} onChangeText={setOutgoing} />
      <Button
        title="Send"
        onPress={() => L2cap.sendData(stringToBuffer(outgoing))}
      />
    </View>
  )
}
```

## Error handling

Wrap connect in `try / catch` and inspect the `Error.message` — every native rejection produces a descriptive string. Other methods (`startScan`, `stopScan`, `sendData`, `disconnect`) **don't throw** for transient runtime conditions; they log a native warning instead, so your render path never crashes because Bluetooth flipped off.

```ts
try {
  await L2cap.connect(deviceId, 0x80, false)
} catch (e) {
  if (/Device not found/.test((e as Error).message)) {
    // prompt user to rescan
  } else if (/Refused/.test((e as Error).message)) {
    // peer rejected the channel — wrong PSM, encryption mismatch, etc.
  }
}
```

## Caveats & gotchas

- **iOS Simulator** has no Bluetooth radio — test on hardware.
- **Android < API 29 / iOS < 11** do not expose L2CAP CoC APIs and will fail at `connect()`.
- The `secure` flag is meaningful on **Android** (selects `createL2capChannel` vs `createInsecureL2capChannel`). On **iOS**, channel security is a property of the *peer's* configuration; the flag is accepted for API parity but doesn't change CoreBluetooth's behaviour.
- Subscriber callbacks are **single-slot**. If multiple parts of your app need device-found events, multiplex them in a single subscriber at the boundary.
- Each `onDataReceived` chunk is **non-owning** in the callback scope — if you need to retain the bytes (e.g. enqueue for later processing), copy with `bufferToString`, `bufferToHex`, or `new Uint8Array(buf).slice()`.

## Running the example

```sh
git clone https://github.com/andrewkryshtal/react-native-l2cap.git
cd react-native-l2cap
npm install
cd example && npm install

# iOS:
cd ios && bundle exec pod install
cd .. && npm run ios

# Android (with a real device plugged in):
npm run android
```

You'll get the dark-mode test bench from the screenshot above: a scanner, a PSM input, hex/utf-8 traffic logs, and a send field.

## Contributing

PRs welcome. Open an issue first for anything sizable so we can discuss the shape. The TypeScript spec is the source of truth — when changing it, regenerate native scaffolding with:

```sh
npm run codegen
```

## License

[MIT](./LICENSE) © andrewkryshtal
