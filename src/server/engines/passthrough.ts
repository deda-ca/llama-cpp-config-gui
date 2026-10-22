/**
 * Passthrough driver for kinds without a dedicated driver (docs/llm-engines.md
 * §2.1: "Unknown/custom kinds get a passthrough driver").
 *
 * Launches the instance's binary from the definition's build folder with the
 * instance's params, streams raw logs, and reports process status. No version
 * probe, no device listing, no metrics, no log classification — everything a
 * real driver would specialize.
 */

import type { LlamaConfig } from '../types.js';
import { splitArgs } from './args.js';
import type { EngineDriver } from './driver.js';

export const passthroughDriver: EngineDriver = {
  kind: 'custom',
  // The instance's `binary` field is the executable name, verbatim.
  binaryName: (spec) => spec.binary,
  buildArgs: (spec) => (spec.extraArgs.trim() ? splitArgs(spec.extraArgs) : []),
};
