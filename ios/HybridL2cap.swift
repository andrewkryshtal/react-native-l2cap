//
//  HybridL2cap.swift
//  L2cap
//
//  L2CAP CoC implementation backed by CoreBluetooth.
//

import CoreBluetooth
import Foundation
import NitroModules

private let LOG_TAG = "HybridL2cap"

/// Wraps a CoreBluetooth peripheral and its open L2CAP channel.
/// Holding this off the main thread is fine; the inner objects are accessed
/// from the dispatch queue we created the central manager on.
private final class Connection {
  let peripheral: CBPeripheral
  var channel: CBL2CAPChannel?
  var inputDelegate: StreamPump?

  init(peripheral: CBPeripheral) {
    self.peripheral = peripheral
  }
}

/// `StreamDelegate` that pumps bytes out of an `InputStream` into a callback
/// as zero-copy `ArrayBuffer` chunks.
private final class StreamPump: NSObject, StreamDelegate {
  private static let bufferSize = 4096
  private var onData: ((ArrayBuffer) -> Void)?

  func setOnData(_ callback: ((ArrayBuffer) -> Void)?) {
    self.onData = callback
  }

  func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
    guard let input = aStream as? InputStream else { return }
    switch eventCode {
    case .hasBytesAvailable:
      drain(input)
    case .errorOccurred:
      NSLog("[\(LOG_TAG)] InputStream error: \(input.streamError?.localizedDescription ?? "unknown")")
    default:
      break
    }
  }

  private func drain(_ input: InputStream) {
    var scratch = [UInt8](repeating: 0, count: StreamPump.bufferSize)
    while input.hasBytesAvailable {
      let read = scratch.withUnsafeMutableBufferPointer { ptr -> Int in
        guard let base = ptr.baseAddress else { return 0 }
        return input.read(base, maxLength: ptr.count)
      }
      if read <= 0 { return }
      let buffer = scratch.withUnsafeBufferPointer { ptr -> ArrayBuffer in
        ArrayBuffer.copy(of: ptr.baseAddress!, size: read)
      }
      onData?(buffer)
    }
  }
}

final class HybridL2cap: HybridL2capSpec {

  // MARK: - State

  private let queue = DispatchQueue(label: "com.margelo.l2cap.central", qos: .userInitiated)
  private lazy var manager: CBCentralManager = {
    let delegate = ManagerDelegate(owner: self)
    self.managerDelegate = delegate
    return CBCentralManager(delegate: delegate, queue: queue)
  }()
  private var managerDelegate: ManagerDelegate?

  /// Pending peripherals discovered while scanning. Indexed by UUID string.
  private var discovered: [String: CBPeripheral] = [:]

  private var connection: Connection?

  /// Pending `connect(...)` invocation. Resolved on `didOpenL2CAPChannel`
  /// or rejected on any failure.
  private var connectPromise: Promise<Void>?
  private var requestedPsm: CBL2CAPPSM?

  private var onDeviceFoundCallback: ((Device) -> Void)?
  private var onDataReceivedCallback: ((ArrayBuffer) -> Void)?

  override init() {
    super.init()
    // Force lazy init so the delegate is wired up early; CoreBluetooth will
    // post `centralManagerDidUpdateState` once the radio is ready.
    _ = manager
  }

  // MARK: - HybridL2capSpec

  var isConnected: Bool {
    queue.sync { connection?.channel != nil }
  }

  func startScan() throws {
    queue.async { [weak self] in
      guard let self = self else { return }
      guard self.manager.state == .poweredOn else {
        NSLog("[\(LOG_TAG)] startScan ignored: bluetooth state = \(self.manager.state.rawValue)")
        return
      }
      self.discovered.removeAll(keepingCapacity: true)
      self.manager.scanForPeripherals(
        withServices: nil,
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
      )
    }
  }

  func stopScan() throws {
    queue.async { [weak self] in
      self?.manager.stopScan()
    }
  }

  func onDeviceFound(callback: @escaping (Device) -> Void) throws {
    queue.async { [weak self] in
      self?.onDeviceFoundCallback = callback
    }
  }

  func connect(address: String, psm: Double, secure: Bool) throws -> Promise<Void> {
    let promise = Promise<Void>()
    let psmValue = CBL2CAPPSM(psm)

    queue.async { [weak self] in
      guard let self = self else {
        promise.reject(withError: RuntimeError.error(withMessage: "HybridL2cap deallocated"))
        return
      }

      if self.connectPromise != nil {
        promise.reject(withError: RuntimeError.error(withMessage: "Another connect() is already in flight"))
        return
      }
      if self.connection != nil {
        promise.reject(withError: RuntimeError.error(withMessage: "Already connected — call disconnect() first"))
        return
      }
      guard self.manager.state == .poweredOn else {
        promise.reject(withError: RuntimeError.error(withMessage: "Bluetooth is not powered on"))
        return
      }

      // Stop scanning before connecting — Apple recommends this.
      self.manager.stopScan()

      // Resolve the peripheral by UUID. We may have discovered it during a
      // scan, or it may already be known to the system.
      let peripheral: CBPeripheral
      if let cached = self.discovered[address] {
        peripheral = cached
      } else if
        let uuid = UUID(uuidString: address),
        let known = self.manager.retrievePeripherals(withIdentifiers: [uuid]).first
      {
        peripheral = known
      } else {
        promise.reject(withError: RuntimeError.error(withMessage: "Device not found"))
        return
      }

      peripheral.delegate = self.managerDelegate
      self.connectPromise = promise
      self.requestedPsm = psmValue
      self.connection = Connection(peripheral: peripheral)

      // `secure == false` -> rely on the channel being opened without
      // requiring pairing. CoreBluetooth has no explicit insecure flag; the
      // remote peer must publish the channel without encryption requirements.
      // We surface the parameter so callers can opt in to encryption-aware
      // flows in the future if needed.
      _ = secure

      self.manager.connect(peripheral, options: nil)
    }

    return promise
  }

  func disconnect() throws {
    queue.async { [weak self] in
      self?.teardown(reason: nil)
    }
  }

  func sendData(data: ArrayBuffer) throws {
    // Capture an owning copy *before* dispatching — the foreign buffer is
    // only safe to read on the calling thread.
    let copy = ArrayBuffer.copy(of: data)
    queue.async { [weak self] in
      guard
        let self = self,
        let channel = self.connection?.channel,
        let output = channel.outputStream
      else {
        NSLog("[\(LOG_TAG)] sendData called with no open channel")
        return
      }

      let size = copy.size
      let bytes = copy.data.assumingMemoryBound(to: UInt8.self)
      var written = 0
      while written < size {
        guard output.hasSpaceAvailable else {
          // OutputStream will fire `.hasSpaceAvailable` again. For simplicity
          // we drop the unwritten remainder onto the queue's next tick.
          let remaining = size - written
          let tailPtr = bytes.advanced(by: written)
          let tail = ArrayBuffer.copy(of: tailPtr, size: remaining)
          self.queue.asyncAfter(deadline: .now() + .milliseconds(8)) { [weak self] in
            try? self?.sendData(data: tail)
          }
          return
        }
        let n = output.write(bytes.advanced(by: written), maxLength: size - written)
        if n <= 0 {
          NSLog("[\(LOG_TAG)] OutputStream.write returned \(n); aborting send")
          return
        }
        written += n
      }
    }
  }

  func onDataReceived(callback: @escaping (ArrayBuffer) -> Void) throws {
    queue.async { [weak self] in
      self?.onDataReceivedCallback = callback
      self?.connection?.inputDelegate?.setOnData(callback)
    }
  }

  // MARK: - Internal callbacks (called from `ManagerDelegate`)

  fileprivate func didDiscover(peripheral: CBPeripheral, rssi: NSNumber) {
    let id = peripheral.identifier.uuidString
    discovered[id] = peripheral
    let device = Device(id: id, name: peripheral.name, rssi: rssi.doubleValue)
    onDeviceFoundCallback?(device)
  }

  fileprivate func didConnect(peripheral: CBPeripheral) {
    guard let psm = requestedPsm else { return }
    peripheral.openL2CAPChannel(psm)
  }

  fileprivate func didFailToConnect(peripheral: CBPeripheral, error: Error?) {
    let message = error?.localizedDescription ?? "Peripheral connection failed"
    rejectAndClear(with: message)
  }

  fileprivate func didDisconnect(peripheral: CBPeripheral, error: Error?) {
    if connectPromise != nil {
      rejectAndClear(with: error?.localizedDescription ?? "Peripheral disconnected")
    } else {
      teardown(reason: error?.localizedDescription)
    }
  }

  fileprivate func didOpen(channel: CBL2CAPChannel?, error: Error?) {
    if let error = error {
      rejectAndClear(with: "L2CAP Channel Refused: \(error.localizedDescription)")
      return
    }
    guard let channel = channel, let connection = connection else {
      rejectAndClear(with: "L2CAP Channel Refused")
      return
    }

    connection.channel = channel

    let pump = StreamPump()
    pump.setOnData(onDataReceivedCallback)
    connection.inputDelegate = pump

    if let input = channel.inputStream {
      input.delegate = pump
      input.schedule(in: .main, forMode: .common)
      input.open()
    }
    if let output = channel.outputStream {
      output.schedule(in: .main, forMode: .common)
      output.open()
    }

    let pending = connectPromise
    connectPromise = nil
    requestedPsm = nil
    pending?.resolve(withResult: ())
  }

  // MARK: - Helpers

  private func rejectAndClear(with message: String) {
    let pending = connectPromise
    connectPromise = nil
    requestedPsm = nil
    teardown(reason: message)
    pending?.reject(withError: RuntimeError.error(withMessage: message))
  }

  private func teardown(reason: String?) {
    guard let connection = connection else { return }
    if let reason = reason {
      NSLog("[\(LOG_TAG)] tearing down channel: \(reason)")
    }
    if let channel = connection.channel {
      channel.inputStream?.close()
      channel.outputStream?.close()
      channel.inputStream?.remove(from: .main, forMode: .common)
      channel.outputStream?.remove(from: .main, forMode: .common)
    }
    manager.cancelPeripheralConnection(connection.peripheral)
    connection.peripheral.delegate = nil
    self.connection = nil
  }
}

// MARK: - CBCentralManagerDelegate / CBPeripheralDelegate

private final class ManagerDelegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  weak var owner: HybridL2cap?
  init(owner: HybridL2cap) { self.owner = owner }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    NSLog("[\(LOG_TAG)] central state -> \(central.state.rawValue)")
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    owner?.didDiscover(peripheral: peripheral, rssi: RSSI)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    owner?.didConnect(peripheral: peripheral)
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    owner?.didFailToConnect(peripheral: peripheral, error: error)
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    owner?.didDisconnect(peripheral: peripheral, error: error)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didOpen channel: CBL2CAPChannel?,
    error: Error?
  ) {
    owner?.didOpen(channel: channel, error: error)
  }
}
