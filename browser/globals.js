// Globals the shared server code expects (Node's Buffer and process), installed before anything else runs.
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
globalThis.process = globalThis.process || { env: { NODE_ENV: 'test-import' }, on() {}, pid: 1 };
globalThis.PPS_LOCAL = true;
