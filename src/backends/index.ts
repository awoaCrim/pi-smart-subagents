/**
 * The extension owns one child runtime: Pi's RPC process.
 *
 * Keep construction behind this small seam so the runner remains easy to
 * inject in focused tests without exposing a selectable vendor runtime.
 */

import type { BackendAdapter } from "../backend.js";
import { PiBackend } from "./pi.js";

const piBackend = new PiBackend();

export function resolveBackend(): BackendAdapter {
  return piBackend;
}

export { PiBackend } from "./pi.js";
