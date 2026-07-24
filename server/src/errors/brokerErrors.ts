/**
 * brokerErrors.ts
 *
 * Typed error classes for broker-layer failures.
 * marketDataService throws these; routes map them to distinct HTTP codes.
 * Adapters still throw generic Error — classification happens in the service.
 */

/** Safe context captured from a broker REST response for diagnostics. */
export interface BrokerErrorDetails {
  provider?: string;
  operation?: string;
  httpStatus?: number;
  brokerStatus?: string;
  brokerMessage?: string;
  request?: Record<string, unknown>;
  responseBody?: unknown;
}

/** A structured error returned by the Fyers REST API. */
export class FyersApiError extends Error {
  readonly code = "FYERS_API_ERROR" as const;
  readonly details: BrokerErrorDetails;

  constructor(details: BrokerErrorDetails, message?: string) {
    const brokerMessage =
      details.brokerMessage?.trim() ||
      (typeof details.responseBody === "string" ? details.responseBody.trim() : "") ||
      "Fyers REST request failed";
    super(message ?? `Fyers ${details.operation ?? "REST"} request failed: ${brokerMessage}`);
    this.name = "FyersApiError";
    this.details = details;
  }
}

/** No valid session exists — broker was never connected or credentials are absent. */
export class AuthenticationError extends Error {
  readonly code = "AUTHENTICATION_ERROR" as const;
  constructor(message = "No valid broker session. Please connect your broker account.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** A session previously existed but the token has expired (24-hour TTL). */
export class SessionExpiredError extends Error {
  readonly code = "SESSION_EXPIRED" as const;
  readonly details?: BrokerErrorDetails;
  constructor(
    message = "Broker session has expired. Please reconnect your broker account.",
    details?: BrokerErrorDetails
  ) {
    super(message);
    this.name = "SessionExpiredError";
    this.details = details;
  }
}

/**
 * The broker's API rejected the request due to rate limiting.
 * retryAfterMs is a hint; callers may use it for back-off UI feedback.
 */
export class RateLimitError extends Error {
  readonly code = "RATE_LIMIT_ERROR" as const;
  readonly retryAfterMs: number;
  readonly details?: BrokerErrorDetails;
  constructor(
    message = "Broker API rate limit exceeded. Please try again shortly.",
    retryAfterMs = 60_000,
    details?: BrokerErrorDetails
  ) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

/** The broker's servers are unreachable (network error, downtime, DNS failure). */
export class BrokerUnavailableError extends Error {
  readonly code = "BROKER_UNAVAILABLE" as const;
  readonly details?: BrokerErrorDetails;
  constructor(
    message = "Broker service is unreachable. Please try again later.",
    details?: BrokerErrorDetails
  ) {
    super(message);
    this.name = "BrokerUnavailableError";
    this.details = details;
  }
}
