import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  L2cap,
  bufferToHex,
  bufferToString,
  stringToBuffer,
  type Device,
} from 'react-native-l2cap'

const MAX_LOG_LINES = 200

type LogLevel = 'info' | 'in' | 'out' | 'error'

type LogEntry = {
  id: string
  level: LogLevel
  text: string
  at: number
}

async function ensureAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0
  const required: string[] =
    apiLevel >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]

  const results = await PermissionsAndroid.requestMultiple(required as never)
  return required.every((p) => results[p as never] === PermissionsAndroid.RESULTS.GRANTED)
}

export default function App(): React.JSX.Element {
  const [scanning, setScanning] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [selected, setSelected] = useState<Device | null>(null)
  const [psm, setPsm] = useState('0x80')
  const [secure, setSecure] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [outgoing, setOutgoing] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([])

  const logIdRef = useRef(0)
  const appendLog = useCallback((level: LogLevel, text: string) => {
    // Mirror to console so logs are easy to capture from Metro / `adb logcat` /
    // Xcode and share verbatim.
    const line = `[L2cap ${prefix(level)}] ${text}`
    switch (level) {
      case 'error':
        console.error(line)
        break
      case 'in':
      case 'out':
        console.info(line)
        break
      default:
        console.log(line)
    }
    setLogs((prev) => {
      const next = [
        ...prev,
        { id: `${++logIdRef.current}`, level, text, at: Date.now() },
      ]
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
    })
  }, [])

  // --- Native subscriptions. Detach on unmount to release JS retainers.
  useEffect(() => {
    L2cap.onDeviceFound((device) => {
      setDevices((current) => {
        const idx = current.findIndex((d) => d.id === device.id)
        if (idx === -1) return [...current, device]
        const copy = current.slice()
        copy[idx] = device
        return copy
      })
    })
    L2cap.onDataReceived((data) => {
      const hex = bufferToHex(data)
      const ascii = bufferToString(data)
      appendLog('in', ascii ? `${hex}  «${ascii}»` : hex)
    })
    return () => {
      // Replace with no-ops so native side stops calling into a stale JS
      // closure that captures component state.
      L2cap.onDeviceFound(() => {})
      L2cap.onDataReceived(() => {})
      try {
        L2cap.stopScan()
      } catch {}
      try {
        L2cap.disconnect()
      } catch {}
    }
  }, [appendLog])

  const toggleScan = useCallback(async () => {
    if (scanning) {
      try {
        L2cap.stopScan()
      } catch (e) {
        appendLog('error', `stopScan: ${String((e as Error).message ?? e)}`)
      }
      setScanning(false)
      return
    }
    const granted = await ensureAndroidPermissions()
    if (!granted) {
      Alert.alert('Permission required', 'Bluetooth scan/connect permission was denied.')
      return
    }
    setDevices([])
    try {
      L2cap.startScan()
      setScanning(true)
      appendLog('info', 'Scan started')
    } catch (e) {
      appendLog('error', `startScan: ${String((e as Error).message ?? e)}`)
    }
  }, [scanning, appendLog])

  const onConnect = useCallback(async () => {
    if (!selected) {
      Alert.alert('Select a device', 'Tap a device in the list first.')
      return
    }
    const psmValue = Number(psm.startsWith('0x') ? parseInt(psm, 16) : psm)
    if (!Number.isInteger(psmValue) || psmValue <= 0) {
      Alert.alert('Invalid PSM', 'Enter a positive integer (decimal or 0x… hex).')
      return
    }
    try {
      setConnecting(true)
      try {
        L2cap.stopScan()
      } catch {}
      setScanning(false)
      appendLog('info', `Connecting to ${selected.id} psm=${psmValue} secure=${secure}`)
      await L2cap.connect(selected.id, psmValue, secure)
      setConnected(true)
      appendLog('info', 'L2CAP channel open')
    } catch (e) {
      appendLog('error', `connect: ${String((e as Error).message ?? e)}`)
    } finally {
      setConnecting(false)
    }
  }, [appendLog, psm, secure, selected])

  const onDisconnect = useCallback(() => {
    try {
      L2cap.disconnect()
      appendLog('info', 'Disconnected')
    } catch (e) {
      appendLog('error', `disconnect: ${String((e as Error).message ?? e)}`)
    } finally {
      setConnected(false)
    }
  }, [appendLog])

  const onSend = useCallback(() => {
    if (!outgoing) return
    const buffer = stringToBuffer(outgoing)
    try {
      L2cap.sendData(buffer)
      appendLog('out', `${bufferToHex(buffer)}  «${outgoing}»`)
      setOutgoing('')
    } catch (e) {
      appendLog('error', `sendData: ${String((e as Error).message ?? e)}`)
    }
  }, [appendLog, outgoing])

  const renderDevice = useCallback(
    ({ item }: { item: Device }) => {
      const isSelected = selected?.id === item.id
      return (
        <Pressable
          onPress={() => setSelected(item)}
          style={[styles.device, isSelected && styles.deviceSelected]}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {item.name ?? '(unnamed)'}
          </Text>
          <Text style={styles.deviceId} numberOfLines={1}>
            {item.id}
          </Text>
          <Text style={styles.deviceRssi}>{item.rssi.toFixed(0)} dBm</Text>
        </Pressable>
      )
    },
    [selected],
  )

  const orderedDevices = useMemo(
    () => devices.slice().sort((a, b) => b.rssi - a.rssi),
    [devices],
  )

  return (
    <View style={styles.root}>
      <Text style={styles.header}>react-native-l2cap</Text>

      <View style={styles.row}>
        <Button
          label={scanning ? 'Stop Scan' : 'Start Scan'}
          onPress={toggleScan}
          tone={scanning ? 'danger' : 'primary'}
        />
        <Text style={styles.statusText}>
          {connected ? '● connected' : connecting ? '● connecting…' : '○ idle'}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Devices ({orderedDevices.length})</Text>
      <FlatList
        style={styles.deviceList}
        data={orderedDevices}
        keyExtractor={(d) => d.id}
        renderItem={renderDevice}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {scanning ? 'Scanning…' : 'No devices yet. Hit Start Scan.'}
          </Text>
        }
      />

      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.psmInput]}
          value={psm}
          onChangeText={setPsm}
          placeholder="PSM (0x80)"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="default"
        />
        <Pressable onPress={() => setSecure((s) => !s)} style={styles.toggle}>
          <Text style={styles.toggleText}>{secure ? 'secure ✓' : 'insecure'}</Text>
        </Pressable>
        {connected ? (
          <Button label="Disconnect" onPress={onDisconnect} tone="danger" />
        ) : (
          <Button
            label={connecting ? '…' : 'Connect'}
            onPress={onConnect}
            disabled={!selected || connecting}
            tone="primary"
          />
        )}
      </View>

      <Text style={styles.sectionTitle}>Log</Text>
      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {logs.length === 0 ? (
          <Text style={styles.empty}>No traffic yet.</Text>
        ) : (
          logs.map((entry) => (
            <Text key={entry.id} style={[styles.logLine, logToneStyle(entry.level)]}>
              {`[${formatTime(entry.at)}] ${prefix(entry.level)} ${entry.text}`}
            </Text>
          ))
        )}
      </ScrollView>

      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.sendInput]}
          value={outgoing}
          onChangeText={setOutgoing}
          placeholder="Type a message and press Send"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          label="Send"
          onPress={onSend}
          disabled={!connected || outgoing.length === 0}
          tone="primary"
        />
      </View>
      {connecting && <ActivityIndicator style={styles.spinner} />}
    </View>
  )
}

function Button(props: {
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'primary' | 'danger'
}) {
  const { label, onPress, disabled, tone = 'primary' } = props
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        tone === 'danger' ? styles.buttonDanger : styles.buttonPrimary,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

function logToneStyle(level: LogLevel) {
  switch (level) {
    case 'in':
      return styles.logIn
    case 'out':
      return styles.logOut
    case 'error':
      return styles.logError
    default:
      return styles.logInfo
  }
}

function prefix(level: LogLevel): string {
  switch (level) {
    case 'in':
      return '« rx'
    case 'out':
      return '» tx'
    case 'error':
      return '!!'
    default:
      return '  '
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, paddingTop: 48, backgroundColor: '#101216' },
  header: { fontSize: 22, color: '#fff', fontWeight: '700', marginBottom: 12 },
  sectionTitle: {
    color: '#8e96a3',
    marginTop: 12,
    marginBottom: 6,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 4,
  },
  statusText: { color: '#cbd2dc', flex: 1, textAlign: 'right' },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  buttonPrimary: { backgroundColor: '#2f80ed' },
  buttonDanger: { backgroundColor: '#eb5757' },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#fff', fontWeight: '600' },
  deviceList: {
    maxHeight: 200,
    backgroundColor: '#161a21',
    borderRadius: 10,
  },
  device: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222831',
  },
  deviceSelected: { backgroundColor: '#1f2a3a' },
  deviceName: { color: '#fff', fontWeight: '600' },
  deviceId: { color: '#8e96a3', fontSize: 12, fontVariant: ['tabular-nums'] },
  deviceRssi: { color: '#cbd2dc', fontSize: 12, marginTop: 2 },
  empty: { color: '#5f6776', padding: 16, textAlign: 'center' },
  input: {
    flex: 1,
    backgroundColor: '#161a21',
    color: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  psmInput: { flex: 0, width: 110 },
  sendInput: { flex: 1 },
  toggle: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#1f242c',
  },
  toggleText: { color: '#cbd2dc', fontSize: 12 },
  log: {
    flex: 1,
    backgroundColor: '#0b0d11',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  logContent: { paddingBottom: 8 },
  logLine: {
    color: '#cbd2dc',
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    marginVertical: 1,
  },
  logIn: { color: '#a3e4d7' },
  logOut: { color: '#f9d29b' },
  logError: { color: '#ff6b6b' },
  logInfo: { color: '#8e96a3' },
  spinner: { position: 'absolute', right: 18, top: 56 },
})
