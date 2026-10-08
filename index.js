// Pi supplies this SDK through its extension loader; do not install a second copy.
import * as sdk from '@earendil-works/pi-coding-agent';
import { registerSubagents } from './extension.mjs';

export default function (pi) {
  registerSubagents(pi, sdk);
}
