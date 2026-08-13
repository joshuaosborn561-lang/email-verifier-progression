function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolvePublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: resolvePublicUrl(),
  supabaseUrl: process.env.SUPABASE_URL || 'https://azpapwtnrbzywlnxxecz.supabase.co',
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get millionVerifierApiKey() {
    return required('MILLIONVERIFIER_API_KEY');
  },
  get no2bounceApiToken() {
    return required('NO2BOUNCE_API_TOKEN');
  },
  /**
   * Optional soft ceilings. Default 0 = disabled (always run the full waterfall).
   * Set N2B_DAILY_CREDIT_CEILING / MV_BALANCE_FRACTION_CEILING env vars to re-enable pauses.
   */
  n2bDailyCreditCeiling: Number(process.env.N2B_DAILY_CREDIT_CEILING || 0),
  /** No2Bounce submit batch size — large payloads (~1000+) trigger vendor 500s. */
  n2bSubmitBatchSize: Number(process.env.N2B_SUBMIT_BATCH_SIZE || 150),
  vendorMaxAttempts: Number(process.env.VENDOR_MAX_ATTEMPTS || 5),
  vendorRetryBaseMs: Number(process.env.VENDOR_RETRY_BASE_MS || 2_000),
  mvBalanceFractionCeiling: Number(process.env.MV_BALANCE_FRACTION_CEILING || 0),
  /** Max time for a MillionVerifier job to reach finished (default 45m). */
  mvStageTimeoutMs: Number(process.env.MV_STAGE_TIMEOUT_MS || 45 * 60 * 1000),
  /** Fail if percent/verified make no progress for this long (default 12m). */
  mvStallTimeoutMs: Number(process.env.MV_STALL_TIMEOUT_MS || 12 * 60 * 1000),
  /** Max time for a No2Bounce cohort batch poll (default 45m). */
  n2bStageTimeoutMs: Number(process.env.N2B_STAGE_TIMEOUT_MS || 45 * 60 * 1000),
  uploadsBucket: 'verification-uploads',
  resultsBucket: 'verification-results',
  millionVerifierBulkUrl: 'https://bulkapi.millionverifier.com/bulkapi/v2',
  millionVerifierCreditsUrl: 'https://api.millionverifier.com/api/v3/credits',
  no2bounceBaseUrl: 'https://connect.no2bounce.com/v2',
};
