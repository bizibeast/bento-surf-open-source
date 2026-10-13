export type SetupField = {
  name: string;
  defaultValue: string;
  group: string;
  feature: string;
  purpose: string;
  secret: boolean;
  required: boolean;
};

const requiredNames = new Set([
  "VITE_APP_URL",
  "VITE_PUBLIC_URL",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "WORKSPACE_COOKIE_SIGNING_KEY",
]);

const generatedNames = new Set([
  "VITE_SUPABASE_PROJECT_ID",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "DATABASE_URL",
  "MIGRATION_CONFIRMATION",
  "PRODUCTION_SUPABASE_PROJECT_ID",
]);

const groupDetails: Record<string, { feature: string; purpose: string }> = {
  "Core instance": {
    feature: "Instance",
    purpose: "Sets the identity and public addresses of this installation.",
  },
  Supabase: {
    feature: "Accounts and data",
    purpose: "Connects sign-in, creator profiles, and application data to your Supabase project.",
  },
  "Application security": {
    feature: "Security",
    purpose: "Protects cookies, stored provider connections, and referral attribution.",
  },
  "WebMCP Origin Trial": {
    feature: "Browser tools",
    purpose: "Enables browser WebMCP on the origins registered for the trial.",
  },
  "Dodo Payments platform billing": {
    feature: "Platform billing",
    purpose: "Enables subscription billing for creator plans and add-ons.",
  },
  "Creator commerce": {
    feature: "Store payments",
    purpose: "Selects the payment provider for products sold by creators.",
  },
  "Stripe Connect": {
    feature: "Stripe payments",
    purpose: "Connects creator stores to Stripe and verifies its webhooks.",
  },
  "PayPal Commerce Platform": {
    feature: "PayPal payments",
    purpose: "Connects creator stores to PayPal and verifies payments.",
  },
  "Razorpay Route": {
    feature: "Razorpay payments",
    purpose: "Connects creator stores to Razorpay and verifies payments.",
  },
  Polar: { feature: "Polar payments", purpose: "Connects creator stores to Polar through OAuth." },
  "AI and public-media processing": {
    feature: "AI and media",
    purpose: "Powers AI text, discovery, previews, and media resolution.",
  },
  "Custom domains and maps": {
    feature: "Domains and maps",
    purpose: "Enables custom domains and location-based features.",
  },
  "Instagram and Facebook applications": {
    feature: "Meta integrations",
    purpose: "Enables Instagram and Facebook connections, webhooks, and auto DMs.",
  },
  "Social scheduler OAuth applications": {
    feature: "Social publishing",
    purpose: "Allows creators to connect and publish to social accounts.",
  },
  "Creator calendar and call recordings": {
    feature: "Calendar",
    purpose: "Connects booking calendars and Fathom recordings.",
  },
  "Product analytics and feedback": {
    feature: "Analytics and feedback",
    purpose: "Enables usage analytics, reporting, and feedback widgets.",
  },
  "Email delivery": {
    feature: "Email",
    purpose: "Sends account and creator emails through Resend.",
  },
  "Deployment health authorization": {
    feature: "Health checks",
    purpose: "Protects deployment health information.",
  },
  "Workspaces, Content and optional knowledge/Telegram providers": {
    feature: "Content and workspaces",
    purpose: "Powers workspaces, the Content Agent, knowledge sources, and Telegram.",
  },
};

const exactPurposes: Record<string, string> = {
  VITE_APP_URL:
    "The origin used for sign-in redirects, OAuth callbacks, and app links. Use the address visitors use to open this instance.",
  VITE_PUBLIC_URL:
    "The public profile origin used in creator links and previews. It can match the app URL for a single-origin install.",
  SUPABASE_PROJECT_ID:
    "Identifies the Supabase project so the migration script can verify its target.",
  SUPABASE_URL: "The project API URL used by the server for accounts and data.",
  SUPABASE_PUBLISHABLE_KEY:
    "The public Supabase key used for browser sign-in and permitted database requests. This key is safe to include in the client bundle.",
  SUPABASE_SERVICE_ROLE_KEY:
    "Gives the server privileged Supabase access for protected application operations. Keep it server-side and never use it as the publishable key.",
  SUPABASE_DB_URL:
    "The database connection string used to apply the supplied Supabase migrations before people sign in.",
  WORKSPACE_COOKIE_SIGNING_KEY:
    "Signs workspace selection cookies. Generate a unique random value of at least 32 bytes for this installation.",
  OPENROUTER_API_KEY: "Lets the Content Agent and Brain use OpenRouter models when configured.",
  GROQ_API_KEY: "Provides an AI model fallback for text workflows.",
  RESEND_API_KEY:
    "Authorizes Resend to send account and creator emails when email delivery is enabled.",
  CONTENT_CONNECTION_ENCRYPTION_KEY:
    "Encrypts knowledge-source credentials stored for Content integrations.",
  PAYMENT_CONNECTION_ENCRYPTION_KEY:
    "Encrypts creator payment-provider credentials stored by the app.",
  SOCIAL_CONNECTION_ENCRYPTION_KEY:
    "Encrypts connected social-account tokens used for publishing and insights.",
  BOOKING_CONNECTION_ENCRYPTION_KEY: "Encrypts calendar and call-recording connection tokens.",
  REFERRAL_HASH_SECRET: "Signs and hashes referral attribution so referral data cannot be forged.",
  HEALTH_CHECK_TOKEN: "Authorizes access to the protected deployment health endpoint.",
  EMAIL_DELIVERY_MODE:
    "Keep disabled until the Resend credentials and sender are ready, then enable provider delivery.",
  COMMERCE_PAYMENT_PROVIDER: "Keep disabled until a creator payment provider is configured.",
};

function groupFromComment(comment: string): string | null {
  const header = comment.replace(/^#\s*/, "");
  if (header.startsWith("Application security")) return "Application security";
  if (header.startsWith("WebMCP Origin Trial") || header.startsWith("A split-origin install"))
    return "WebMCP Origin Trial";
  if (header.startsWith("Creator commerce")) return "Creator commerce";
  if (header.startsWith("Email delivery")) return "Email delivery";
  if (header in groupDetails) return header;
  return null;
}

function fieldPurpose(name: string, feature: string, groupPurpose: string): string {
  if (exactPurposes[name]) return exactPurposes[name];
  const detail = name
    .replace(/^VITE_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
  if (
    name.endsWith("_WEBHOOK_SECRET") ||
    name.endsWith("_WEBHOOK_KEY") ||
    name.endsWith("_WEBHOOK_VERIFY_TOKEN")
  )
    return `Verifies incoming ${feature.toLowerCase()} webhooks so the app accepts events from the provider.`;
  if (name.endsWith("_CLIENT_SECRET") || name.endsWith("_APP_SECRET"))
    return `Authenticates this instance's ${feature.toLowerCase()} app during account connection and token exchange.`;
  if (name.endsWith("_CLIENT_ID") || name.endsWith("_APP_ID") || name.endsWith("_CLIENT_KEY"))
    return `Identifies this instance's ${feature.toLowerCase()} app when creators connect their accounts.`;
  if (name.endsWith("_REDIRECT_URI"))
    return `The callback URL registered with the provider for ${feature.toLowerCase()} account connection.`;
  if (name.endsWith("_ENCRYPTION_KEY"))
    return `Encrypts saved ${feature.toLowerCase()} connection credentials.`;
  if (name.includes("PRODUCT_ID") || name.includes("ADDON_ID"))
    return `Maps the ${detail} to a product configured in the billing provider.`;
  if (name.endsWith("_API_KEY") || name.endsWith("_API_TOKEN"))
    return `Authorizes this instance to call the ${feature.toLowerCase()} provider API. ${groupPurpose}`;
  if (name.endsWith("_URL") || name.endsWith("_HOST"))
    return `Sets the ${detail} address used by ${feature.toLowerCase()}. ${groupPurpose}`;
  return `Sets ${detail} for ${feature.toLowerCase()}. ${groupPurpose}`;
}

export function parseSetupFields(template: string): SetupField[] {
  let group = "Core instance";
  const fields: SetupField[] = [];
  for (const line of template.split(/\r?\n/)) {
    if (line.startsWith("#")) {
      group = groupFromComment(line) ?? group;
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || generatedNames.has(match[1])) continue;
    const [name, defaultValue] = [match[1], match[2]];
    const { feature, purpose } = groupDetails[group];
    fields.push({
      name,
      defaultValue,
      group,
      feature,
      purpose: fieldPurpose(name, feature, purpose),
      secret:
        !name.startsWith("VITE_") &&
        /(?:KEY|SECRET|TOKEN|PASSWORD|DB_URL|DATABASE_URL|PRIVATE_KEY|WEBHOOK_ID)$/.test(name),
      required: requiredNames.has(name),
    });
  }
  return fields;
}

export function validateSetup(values: Record<string, string>): string[] {
  const missing = [...requiredNames].filter((name) => !values[name]?.trim());
  const errors = missing.map((name) => `${name} is required.`);
  for (const name of ["VITE_APP_URL", "VITE_PUBLIC_URL", "SUPABASE_URL"]) {
    const value = values[name]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        errors.push(`${name} must be an HTTP(S) origin without a path or credentials.`);
    } catch {
      errors.push(`${name} must be a valid HTTP(S) origin.`);
    }
  }
  if (
    values.WORKSPACE_COOKIE_SIGNING_KEY &&
    new TextEncoder().encode(values.WORKSPACE_COOKIE_SIGNING_KEY).length < 32
  )
    errors.push("WORKSPACE_COOKIE_SIGNING_KEY must be at least 32 bytes.");
  if (values.SUPABASE_DB_URL && !/^postgres(?:ql)?:\/\//.test(values.SUPABASE_DB_URL.trim()))
    errors.push("SUPABASE_DB_URL must be a PostgreSQL connection URL.");
  if (values.SUPABASE_PROJECT_ID && !/^[a-z0-9-]+$/i.test(values.SUPABASE_PROJECT_ID.trim()))
    errors.push("SUPABASE_PROJECT_ID must contain only letters, numbers, or hyphens.");
  if (values.SUPABASE_URL && values.SUPABASE_PROJECT_ID) {
    try {
      const hostname = new URL(values.SUPABASE_URL.trim()).hostname.toLowerCase();
      if (
        hostname.endsWith(".supabase.co") &&
        hostname.slice(0, -".supabase.co".length) !==
          values.SUPABASE_PROJECT_ID.trim().toLowerCase()
      )
        errors.push("SUPABASE_PROJECT_ID must match the project in SUPABASE_URL.");
    } catch {
      // The URL validation above supplies the useful error.
    }
  }
  return errors;
}

function envValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value);
}

export function buildSetupEnv(template: string, values: Record<string, string>): string {
  const merged = { ...values };
  merged.VITE_SUPABASE_URL = values.SUPABASE_URL?.trim() ?? "";
  merged.VITE_SUPABASE_PUBLISHABLE_KEY = values.SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  merged.VITE_SUPABASE_PROJECT_ID = values.SUPABASE_PROJECT_ID?.trim() ?? "";
  merged.DATABASE_URL = values.SUPABASE_DB_URL?.trim() ?? "";
  merged.MIGRATION_CONFIRMATION = values.SUPABASE_PROJECT_ID?.trim()
    ? `MIGRATE:${values.SUPABASE_PROJECT_ID.trim()}`
    : "";
  merged.PRODUCTION_SUPABASE_PROJECT_ID = values.SUPABASE_PROJECT_ID?.trim() ?? "";
  return template.replace(
    /^([A-Z][A-Z0-9_]*)=(.*)$/gm,
    (_line, name: string, defaultValue: string) =>
      `${name}=${envValue(merged[name] ?? defaultValue)}`,
  );
}
