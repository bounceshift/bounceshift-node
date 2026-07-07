export { BounceShift, SDK_VERSION } from './client.js';
export type { BounceShiftOptions } from './client.js';
export { isSafeToSend } from './safe-to-send.js';
export { isSendable } from './sendable.js';
export {
  RECOMMENDATIONS,
  VALIDATION_STATUSES,
  type Recommendation,
  type ValidationResult,
  type ValidationStatus,
} from './types.js';
export {
  ApiError,
  AuthenticationError,
  BounceShiftError,
  ForbiddenError,
  InsufficientCreditsError,
  RateLimitError,
} from './errors.js';
export {
  deliverableEmail,
  type DeliverableEmailOptions,
  type OnInvalidHandler,
} from './middleware.js';
