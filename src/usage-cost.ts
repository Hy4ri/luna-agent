// Cost provenance: a total is provider-reported only when every part of the sum is.
// A part without the flag has an unknown source (catalog rates, a CLI estimate, or an older record), never a bill.
import type { Usage } from "@earendil-works/pi-ai";

type Cost = Pick<Usage["cost"], "totalFromProvider">;

/** Combine an existing sum's flag with the next part's. Call after the first part has been copied into `total`. */
export function addCostProvenance(total: Cost, next: Cost | undefined): void {
  if (total.totalFromProvider === undefined && next?.totalFromProvider === undefined) return;
  total.totalFromProvider = total.totalFromProvider === true && next?.totalFromProvider === true;
}

/** Flag for a sum of parts: true only when there is at least one part and all are provider-reported. */
export function providerReported(parts: readonly (Cost | undefined)[]): boolean {
  return parts.length > 0 && parts.every(part => part?.totalFromProvider === true);
}

/** Wording for a cost that may be an estimate. */
export function costWording(reported: boolean): string {
  return reported ? "provider-reported cost" : "estimated cost (catalog rates, a CLI estimate, or mixed sources; not an invoice)";
}
