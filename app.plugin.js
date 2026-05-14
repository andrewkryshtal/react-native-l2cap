/**
 * Expo Config Plugin for `react-native-l2cap`.
 *
 * Wires up the runtime permissions and `Info.plist` keys required by
 * CoreBluetooth and Android's L2CAP CoC APIs. Drop the package name into
 * the `plugins` array of `app.json` / `app.config.[tj]s` and prebuild:
 *
 *   {
 *     "plugins": [
 *       ["react-native-l2cap", {
 *         "iosUsageDescription": "We use Bluetooth to connect to nearby devices.",
 *         "neverForLocation": true
 *       }]
 *     ]
 *   }
 */

const {
  withInfoPlist,
  withAndroidManifest,
  AndroidConfig,
} = require('@expo/config-plugins')

const DEFAULT_IOS_USAGE =
  'This app uses Bluetooth to discover and connect to nearby L2CAP-capable devices.'

const ANDROID_PERMISSIONS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  // Legacy (only requested on < API 31, but harmless to declare):
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.ACCESS_FINE_LOCATION',
]

/**
 * @param {import('@expo/config-plugins').ConfigPlugin<{
 *   iosUsageDescription?: string
 *   iosPeripheralUsageDescription?: string
 *   neverForLocation?: boolean
 * } | void>} _config
 */
const withL2cap = (config, props) => {
  const options = props || {}
  const iosUsage = options.iosUsageDescription || DEFAULT_IOS_USAGE
  const peripheralUsage =
    options.iosPeripheralUsageDescription || iosUsage
  const neverForLocation = options.neverForLocation !== false

  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSBluetoothAlwaysUsageDescription =
      cfg.modResults.NSBluetoothAlwaysUsageDescription || iosUsage
    cfg.modResults.NSBluetoothPeripheralUsageDescription =
      cfg.modResults.NSBluetoothPeripheralUsageDescription || peripheralUsage
    return cfg
  })

  config = AndroidConfig.Permissions.withPermissions(config, ANDROID_PERMISSIONS)

  if (neverForLocation) {
    config = withAndroidManifest(config, (cfg) => {
      const manifest = cfg.modResults.manifest
      manifest['uses-permission'] = manifest['uses-permission'] || []
      for (const entry of manifest['uses-permission']) {
        if (
          entry?.$?.['android:name'] === 'android.permission.BLUETOOTH_SCAN'
        ) {
          entry.$['android:usesPermissionFlags'] = 'neverForLocation'
        }
      }
      return cfg
    })
  }

  return config
}

module.exports = withL2cap
