import type { HybridObject } from 'react-native-nitro-modules'

/**
 * Represents a Bluetooth device discovered while scanning.
 */
export interface Device {
  /** MAC address on Android, peripheral UUID on iOS. */
  id: string
  /** Human-readable name, when advertised. */
  name?: string
  /** Received signal strength indicator (dBm). */
  rssi: number
}

export interface L2cap
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  // --- Scanning ---
  /** Begin scanning for BLE peripherals. */
  startScan(): void
  /** Stop the active BLE scan. */
  stopScan(): void
  /**
   * Subscribe to device-discovered events. Passing a new callback replaces the
   * previous one; pass a no-op to detach when your component unmounts to avoid
   * retaining JS closures from native.
   */
  onDeviceFound(callback: (device: Device) => void): void

  // --- Connection ---
  /**
   * Connect to a device and open an L2CAP CoC channel.
   *
   * @param address The device id returned from `onDeviceFound`.
   * @param psm     Protocol/Service Multiplexer of the remote channel.
   * @param secure  When `false`, opens an insecure channel and bypasses the
   *                pairing dialog. When `true`, requires LE Secure Connections.
   *
   * @rejects "Device not found" | "L2CAP Channel Refused" | "Bluetooth disabled"
   *          | descriptive native error string.
   */
  connect(address: string, psm: number, secure: boolean): Promise<void>
  /** Tear down the active L2CAP channel and disconnect the peripheral. */
  disconnect(): void
  /** `true` while an L2CAP channel is open. */
  readonly isConnected: boolean

  // --- Data Transfer ---
  /**
   * Send a chunk of bytes over the open channel.
   *
   * Uses an `ArrayBuffer` for zero-copy transfer — bytes are not
   * re-encoded to Base64.
   */
  sendData(data: ArrayBuffer): void
  /**
   * Subscribe to incoming L2CAP packets. Buffer is owned by Nitro and
   * forwarded by reference. Pass a no-op to detach on unmount.
   */
  onDataReceived(callback: (data: ArrayBuffer) => void): void
}
