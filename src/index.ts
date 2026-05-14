import { NitroModules } from 'react-native-nitro-modules'
import type { L2cap as L2capSpec } from './specs/l2cap.nitro'

export const L2cap =
  NitroModules.createHybridObject<L2capSpec>('L2cap')