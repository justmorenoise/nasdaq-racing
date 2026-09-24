import { computeField, type FieldInput, type FieldOutput } from "./terrainField";

/** Computes the terrain heightfield off the main thread. */
self.onmessage = (e: MessageEvent<FieldInput>) => {
  const out: FieldOutput = computeField(e.data);
  const transfer: Transferable[] = [out.hgt.buffer, out.dist.buffer, out.fixed.buffer];
  if (out.seaDist) transfer.push(out.seaDist.buffer);
  (self as unknown as Worker).postMessage(out, transfer);
};
