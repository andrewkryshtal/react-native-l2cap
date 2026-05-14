import { NitroModules } from 'react-native-nitro-modules'
import type { L2cap as L2capSpec, Device } from './specs/l2cap.nitro'

export type { Device, L2capSpec }
export {
  stringToBuffer,
  bufferToString,
  bufferToHex,
  hexToBuffer,
} from './encoding'

export const L2cap = NitroModules.createHybridObject<L2capSpec>('L2cap')
