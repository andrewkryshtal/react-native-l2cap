package com.margelo.nitro.l2cap

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.ArrayBuffer
import com.margelo.nitro.core.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "HybridL2cap"
private const val READ_BUFFER_SIZE = 4096

@SuppressLint("MissingPermission", "NewApi")
class HybridL2cap : HybridL2capSpec() {

  // --- Lifecycle / state ------------------------------------------------

  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val isScanning = AtomicBoolean(false)
  private val isConnectedFlag = AtomicBoolean(false)

  /// Callbacks. Replaced wholesale by the JS side. Marked @Volatile so the
  /// reader thread observes new pointers without locking.
  @Volatile private var onDeviceFoundCallback: ((Device) -> Unit)? = null
  @Volatile private var onDataReceivedCallback: ((ArrayBuffer) -> Unit)? = null

  private var socket: BluetoothSocket? = null
  private var readJob: Job? = null

  // --- Spec implementation ----------------------------------------------

  override val isConnected: Boolean
    get() = isConnectedFlag.get()

  override fun startScan() {
    val adapter = bluetoothAdapter()
      ?: run {
        Log.w(TAG, "startScan: no BluetoothAdapter")
        return
      }
    if (!adapter.isEnabled) {
      Log.w(TAG, "startScan: bluetooth is disabled")
      return
    }
    if (!hasScanPermission()) {
      Log.w(TAG, "startScan: missing BLUETOOTH_SCAN permission")
      return
    }
    val scanner: BluetoothLeScanner = adapter.bluetoothLeScanner
      ?: run {
        Log.w(TAG, "startScan: no BluetoothLeScanner")
        return
      }
    if (isScanning.compareAndSet(false, true)) {
      scanner.startScan(scanCallback)
    }
  }

  override fun stopScan() {
    if (!isScanning.compareAndSet(true, false)) return
    val scanner = bluetoothAdapter()?.bluetoothLeScanner ?: return
    if (!hasScanPermission()) return
    runCatching { scanner.stopScan(scanCallback) }
      .onFailure { Log.w(TAG, "stopScan failed", it) }
  }

  override fun onDeviceFound(callback: (device: Device) -> Unit) {
    onDeviceFoundCallback = callback
  }

  override fun connect(address: String, psm: Double, secure: Boolean): Promise<Unit> {
    val promise = Promise<Unit>()
    val psmInt = psm.toInt()

    if (isConnectedFlag.get()) {
      promise.reject(IllegalStateException("Already connected — call disconnect() first"))
      return promise
    }

    scope.launch {
      val adapter = bluetoothAdapter()
        ?: return@launch promise.reject(IllegalStateException("Bluetooth not supported"))

      if (!adapter.isEnabled) {
        return@launch promise.reject(IllegalStateException("Bluetooth disabled"))
      }
      if (!hasConnectPermission()) {
        return@launch promise.reject(SecurityException("Missing BLUETOOTH_CONNECT permission"))
      }
      if (!BluetoothAdapter.checkBluetoothAddress(address)) {
        return@launch promise.reject(IllegalArgumentException("Device not found: invalid address $address"))
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        return@launch promise.reject(
          UnsupportedOperationException("L2CAP CoC requires Android Q (API 29) or newer")
        )
      }

      val device: BluetoothDevice = try {
        adapter.getRemoteDevice(address)
      } catch (e: IllegalArgumentException) {
        return@launch promise.reject(IllegalArgumentException("Device not found: $address"))
      }

      // Stop scanning before initiating a socket connection; the radio can't
      // do both efficiently.
      stopScan()

      val newSocket: BluetoothSocket = try {
        if (secure) device.createL2capChannel(psmInt)
        else device.createInsecureL2capChannel(psmInt)
      } catch (e: Throwable) {
        return@launch promise.reject(IOException("L2CAP Channel Refused: ${e.message}", e))
      }

      try {
        // Blocking — we are already on Dispatchers.IO.
        newSocket.connect()
      } catch (e: IOException) {
        runCatching { newSocket.close() }
        return@launch promise.reject(IOException("L2CAP Channel Refused: ${e.message}", e))
      }

      socket = newSocket
      isConnectedFlag.set(true)
      startReadLoop(newSocket)
      promise.resolve(Unit)
    }

    return promise
  }

  override fun disconnect() {
    if (!isConnectedFlag.compareAndSet(true, false)) return
    val current = socket
    socket = null
    readJob?.cancel()
    readJob = null
    runCatching { current?.inputStream?.close() }
    runCatching { current?.outputStream?.close() }
    runCatching { current?.close() }
  }

  override fun sendData(data: ArrayBuffer) {
    // The incoming buffer may be non-owning and bound to the JS thread, so we
    // pull a stable ByteArray out *before* dispatching to IO.
    val bytes: ByteArray = data.toByteArray()
    val active = socket
    if (active == null || !isConnectedFlag.get()) {
      Log.w(TAG, "sendData called with no open channel")
      return
    }
    scope.launch {
      val output: OutputStream = try {
        active.outputStream
      } catch (e: IOException) {
        Log.w(TAG, "sendData: outputStream unavailable", e)
        return@launch
      }
      try {
        output.write(bytes)
        output.flush()
      } catch (e: IOException) {
        Log.w(TAG, "sendData: write failed", e)
        teardownFromError(e)
      }
    }
  }

  override fun onDataReceived(callback: (data: ArrayBuffer) -> Unit) {
    onDataReceivedCallback = callback
  }

  // --- Internals --------------------------------------------------------

  private fun startReadLoop(connectedSocket: BluetoothSocket) {
    readJob?.cancel()
    readJob = scope.launch {
      val input: InputStream = try {
        connectedSocket.inputStream
      } catch (e: IOException) {
        Log.w(TAG, "readLoop: failed to get inputStream", e)
        teardownFromError(e)
        return@launch
      }
      val buffer = ByteArray(READ_BUFFER_SIZE)
      while (isActive && isConnectedFlag.get()) {
        val read = try {
          input.read(buffer)
        } catch (e: IOException) {
          if (isActive) {
            Log.w(TAG, "readLoop: read failed", e)
            teardownFromError(e)
          }
          return@launch
        }
        if (read < 0) {
          // EOF — peer closed the channel.
          teardownFromError(IOException("Channel closed by remote"))
          return@launch
        }
        if (read == 0) continue

        val callback = onDataReceivedCallback ?: continue
        // Allocate a direct ByteBuffer so the data can travel to JS without
        // a copy at the JNI boundary; we copy once here so the JS side gets
        // its own owning buffer.
        val direct = ByteBuffer.allocateDirect(read)
        direct.put(buffer, 0, read)
        direct.rewind()
        // Switch back to Main so JS callbacks invoked from native delegates
        // don't fight with whatever thread `input.read` happened to be on.
        withContext(Dispatchers.Main) {
          callback(ArrayBuffer.wrap(direct))
        }
      }
    }
  }

  private fun teardownFromError(error: Throwable) {
    if (!isConnectedFlag.compareAndSet(true, false)) return
    Log.w(TAG, "tearing down L2CAP channel: ${error.message}")
    val current = socket
    socket = null
    runCatching { current?.inputStream?.close() }
    runCatching { current?.outputStream?.close() }
    runCatching { current?.close() }
  }

  // --- Scanning ---------------------------------------------------------

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val device = result.device ?: return
      val callback = onDeviceFoundCallback ?: return
      val name = if (hasConnectPermission()) device.name else null
      callback(Device(id = device.address, name = name, rssi = result.rssi.toDouble()))
    }

    override fun onScanFailed(errorCode: Int) {
      Log.w(TAG, "BLE scan failed with code $errorCode")
      isScanning.set(false)
    }
  }

  // --- Helpers ----------------------------------------------------------

  private fun applicationContext(): Context? = NitroModules.applicationContext

  private fun bluetoothAdapter(): BluetoothAdapter? {
    val context = applicationContext() ?: return null
    val manager = ContextCompat.getSystemService(context, BluetoothManager::class.java)
    return manager?.adapter
  }

  private fun hasScanPermission(): Boolean {
    val context = applicationContext() ?: return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.BLUETOOTH_SCAN
    ) == PackageManager.PERMISSION_GRANTED
  }

  private fun hasConnectPermission(): Boolean {
    val context = applicationContext() ?: return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.BLUETOOTH_CONNECT
    ) == PackageManager.PERMISSION_GRANTED
  }

  protected fun finalize() {
    // Best-effort cleanup so a leaked HybridObject doesn't keep the radio
    // and a worker thread alive.
    runCatching { disconnect() }
    runCatching { scope.cancel() }
  }
}
