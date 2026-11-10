import { createHash } from "node:crypto";
import type { NodeRow } from "./types.js";

export function validationClaimDigest(summary: string): string {
  return createHash("sha256").update("v1\n" + summary.replace(/\r\n?/g, "\n").trim(), "utf8").digest("hex");
}

export function validationScopeDigest(scope: unknown): string | null {
  if (!scope || typeof scope !== "object") return null;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return createHash("sha256").update("scope-v1\n" + JSON.stringify(canonical(scope)), "utf8").digest("hex");
}

export function validationState(node: NodeRow): "current" | "stale" | "unknown" {
  if (!node.validation_claim_digest || !node.validation_scope_digest) return "unknown";
  let scope: unknown;
  try { scope = node.status_scope ? JSON.parse(node.status_scope) : null; } catch { return "unknown"; }
  return node.validation_claim_digest === validationClaimDigest(node.summary) && node.validation_scope_digest === validationScopeDigest(scope) ? "current" : "stale";
}
