/**
 * Research Desk evaluation contract draft, 2026-09-30.
 * Internal application boundary only. NOT an OpenAI or TypeSafe wire schema.
 * Documentation artifact: not imported by the current Electron app.
 * Runtime validation, policy enforcement and adapters remain to be implemented.
 */

export type EvaluationProvider = "openai_decisions" | "typesafe_jev";
export type Relevance = "high" | "partial" | "low" | "unknown";
export type Evidence = "supported" | "contradicted" | "insufficient" | "mixed";
export type TransferPolicy = "local_only" | "ai_allowed";

export interface RequiredCondition {
  id: string;
  /** Explicit user condition; never an unconfirmed model inference. */
  text: string;
}

export interface SearchIntent {
  query: string;
  requiredConditions: readonly RequiredCondition[];
  preferences: readonly string[];
}

/** Local storage only; do not serialize this object into a provider request. */
export interface LocalSource {
  sourceId: string;
  revision: number;
  title: string;
  kind: "file" | "url" | "paste";
  localPath?: string;
  publicUrl?: string;
  transferPolicy: TransferPolicy;
  policyRevision: number;
  deleted: boolean;
}

export type SourceLocation =
  | { kind: "page"; page: number }
  | { kind: "lines"; start: number; end: number }
  | { kind: "paragraph"; index: number }
  | { kind: "unknown" };

/** Maps to actual stored text and extractor-provided location. */
export interface RetrievedPassage {
  chunkId: string;
  sourceId: string;
  sourceRevision: number;
  text: string;
  contentHash: string;
  location: SourceLocation;
  baseRank: number;
  retrievedAt: string;
  origin: "local_extraction" | "public_page_extraction";
  /** Search summaries do not qualify as raw retrieved passages. */
  contextTruncated: boolean;
}

/**
 * Main process constructs this AFTER checking current source/policy revisions.
 * A literal type is not proof of permission: enforcement must be in code.
 * Exclude localPath, credentials, whole-document text and unrelated metadata.
 */
export interface ApprovedEvaluationUnit {
  unitId: string;
  sourceId: string;
  sourceRevision: number;
  chunkId: string;
  sourceTitle: string;
  excerpt: string;
  excerptHash: string;
  publicUrl?: string;
  transferPolicy: "ai_allowed";
  policyRevision: number;
  baseRank: number;
  contextTruncated: boolean;
}

/** Internal request; adapters translate it using verified official contracts. */
export interface EvaluationRequest {
  contractVersion: "1";
  requestId: string;
  corpusRevision: number;
  rubricVersion: string;
  intent: SearchIntent;
  units: readonly ApprovedEvaluationUnit[];
}

export interface UsageReceipt {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costKind: "provider_reported" | "estimate" | "unknown";
}

/**
 * Records actual capability evidence; no speculative endpoint or model ID.
 * Kept separate from a key-configured flag.
 */
export interface ProviderReadiness {
  provider: EvaluationProvider;
  status: "unverified" | "unsupported" | "ready";
  officialContractUrl: string | null;
  verifiedAt: string | null;
  accountAccessVerified: boolean;
  model: string | null;
  probabilitySemanticsUrl: string | null;
}

export interface ConditionJudgment {
  conditionId: string;
  evidence: Evidence;
}

export interface UnitJudgment {
  unitId: string;
  status: "evaluated";
  relevance: Relevance;
  conditions: readonly ConditionJudgment[];
  /**
   * The app attaches source/chunk/location via unitId.
   * No generated quote, page number or free-form citation is trusted here.
   * Legacy probabilities may be retained separately as provider diagnostics.
   */
}

export interface UnitFailure {
  unitId: string;
  status: "unavailable";
  reason:
    | "missing_answer"
    | "invalid_answer"
    | "refused"
    | "context_limit"
    | "service_error";
}

export interface EvaluationReceipt {
  requestId: string;
  provider: EvaluationProvider;
  model: string | null;
  elapsedMs: number;
  usage: UsageReceipt;
  units: readonly (UnitJudgment | UnitFailure)[];
}

/** Never collapse service failure into a model's unknown/insufficient answer. */
export type EvaluationResult =
  | { status: "complete" | "partial"; receipt: EvaluationReceipt }
  | {
      status: "unavailable";
      reason:
        | "contract_unverified"
        | "access_unverified"
        | "not_configured"
        | "authentication"
        | "rate_limited"
        | "network"
        | "invalid_response";
      requestId: string;
      /** Timeout with uncertain processing can have unknown billing. */
      billingState: "not_sent" | "unknown" | "provider_reported";
    }
  | {
      status: "cancelled";
      requestId: string;
      billingState: "not_sent" | "unknown" | "provider_reported";
    };

/**
 * Conceptual adapter boundary. Signal is supplied by the main process.
 * An adapter MUST validate labels and one-to-one unit/condition ID mappings,
 * reject unexpected IDs, and report missing answers explicitly.
 */
export interface EvaluationAdapter {
  readonly provider: EvaluationProvider;
  readiness(): ProviderReadiness;
  evaluate(
    request: EvaluationRequest,
    signal: AbortSignal
  ): Promise<EvaluationResult>;
}

export interface DisplayedPassage {
  passage: RetrievedPassage;
  evaluation:
    | { status: "evaluated"; relevance: Relevance; conditions: readonly ConditionJudgment[] }
    | { status: "not_evaluated"; reason: "local_only" | "no_excerpt" | "service_unavailable" };
  /** Computed locally from original source metadata, never model generated. */
  sourceLocation: SourceLocation;
}
