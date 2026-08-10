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
  n2bDailyCreditCeiling: 19_000,
  /** No2Bounce submit batch size — large payloads (~1000+) trigger vendor 500s. */
  n2bSubmitBatchSize: Number(process.env.N2B_SUBMIT_BATCH_SIZE || 150),
  vendorMaxAttempts: Number(process.env.VENDOR_MAX_ATTEMPTS || 5),
  vendorRetryBaseMs: Number(process.env.VENDOR_RETRY_BASE_MS || 2_000),
  mvBalanceFractionCeiling: 0.5, // pause if projected usage > 50% of remaining MV credits
  uploadsBucket: 'verification-uploads',
  resultsBucket: 'verification-results',
  millionVerifierBulkUrl: 'https://bulkapi.millionverifier.com/bulkapi/v2',
  millionVerifierCreditsUrl: 'https://api.millionverifier.com/api/v3/credits',
  no2bounceBaseUrl: 'https://connect.no2bounce.com/v2',
};
