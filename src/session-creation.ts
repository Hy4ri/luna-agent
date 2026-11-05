import { createHash } from "node:crypto";
import { defineDocFamily } from "@earendil-works/pi-durable";

export type SessionCreationData = {
  sessionId: number;
  payloadHash: string;
  createdAt: number;
};

export const SessionCreationDoc = defineDocFamily<
  SessionCreationData,
  { sessionId: number; payloadHash: string }
>({
  checkpointWhen: () => false,
  kind: "luna.session-creation",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    sessionId: seed.sessionId,
    payloadHash: seed.payloadHash,
    createdAt: Date.now(),
  }),
});

export function sessionPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? {}, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
}
