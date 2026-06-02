import os from "node:os";
import path from "node:path";

export type HotelPersistenceProvider =
  | "postgres"
  | "google_sheets"
  | "file-volume"
  | "file-local"
  | "file-tmp";

export interface HotelPersistenceConfig {
  provider: HotelPersistenceProvider;
  configuredProvider?: string;
  conversationStoreProvider: HotelPersistenceProvider;
  configuredConversationStoreProvider?: string;
  databaseUrlConfigured: boolean;
  durableFileBaseDir?: string;
  isProduction: boolean;
}

const PRODUCTION_DATA_DIR = "/data";
const TMP_STORE_DIR = "hotel-canino-demo";

function normalizeProvider(value: string | undefined): HotelPersistenceProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "postgres") {
    return "postgres";
  }

  if (normalized === "google_sheets" || normalized === "google-sheets" || normalized === "sheets") {
    return "google_sheets";
  }

  if (normalized === "file" || normalized === "file-volume" || normalized === "volume") {
    return "file-volume";
  }

  if (normalized === "local" || normalized === "file-local") {
    return "file-local";
  }

  if (normalized === "tmp" || normalized === "file-tmp") {
    return "file-tmp";
  }

  return undefined;
}

export function readHotelPersistenceConfig(
  env: NodeJS.ProcessEnv = process.env,
): HotelPersistenceConfig {
  const configuredProvider = env.HOTEL_PERSISTENCE_PROVIDER?.trim();
  const explicitProvider = normalizeProvider(configuredProvider);
  const configuredConversationStoreProvider = env.HOTEL_CONVERSATIONS_STORE_PROVIDER?.trim();
  const explicitConversationStoreProvider = normalizeProvider(configuredConversationStoreProvider);
  const isProduction = env.NODE_ENV === "production";
  const isVercelPreview = env.VERCEL_ENV === "preview";
  const isVercelRuntime = Boolean(env.VERCEL);
  const databaseUrlConfigured = Boolean(env.DATABASE_URL?.trim());
  const explicitDurableFileBaseDir = Boolean(
    env.HOTEL_FILE_STORE_DIR?.trim() || env.HOTEL_STORE_DIR?.trim(),
  );
  const durableFileBaseDir =
    env.HOTEL_FILE_STORE_DIR?.trim() ||
    env.HOTEL_STORE_DIR?.trim() ||
    (isProduction && !isVercelPreview ? PRODUCTION_DATA_DIR : undefined);

  const provider =
    explicitProvider ??
      (databaseUrlConfigured && isProduction
        ? "postgres"
        : isVercelRuntime && !explicitDurableFileBaseDir
          ? "file-tmp"
        : isVercelPreview
          ? "file-tmp"
          : isProduction
            ? "file-volume"
            : "file-local");

  return {
    provider,
    configuredProvider,
    conversationStoreProvider: explicitConversationStoreProvider ?? provider,
    configuredConversationStoreProvider,
    databaseUrlConfigured,
    durableFileBaseDir,
    isProduction,
  };
}

function resolveTmpStorePath(fileName: string): string {
  return path.join(os.tmpdir(), TMP_STORE_DIR, fileName);
}

function isRootDataPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized === PRODUCTION_DATA_DIR || normalized.startsWith(`${PRODUCTION_DATA_DIR}/`);
}

export function resolveJsonStorePath(input: {
  fileName: string;
  pathEnv?: string;
  dirEnv?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  const isVercelPreview = env.VERCEL_ENV === "preview";
  const explicitPath = input.pathEnv ? env[input.pathEnv]?.trim() : undefined;
  if (explicitPath) {
    if (isVercelPreview && isRootDataPath(explicitPath)) {
      return resolveTmpStorePath(path.basename(explicitPath));
    }

    return explicitPath;
  }

  const explicitDir = input.dirEnv ? env[input.dirEnv]?.trim() : undefined;
  if (explicitDir) {
    if (isVercelPreview && isRootDataPath(explicitDir)) {
      return resolveTmpStorePath(input.fileName);
    }

    return path.join(explicitDir, input.fileName);
  }

  const sharedFilePath = env.HOTEL_FILE_STORE_PATH?.trim();
  if (sharedFilePath && input.fileName === "hotel-demo-state.json") {
    return sharedFilePath;
  }

  const config = readHotelPersistenceConfig(env);
  if (config.provider === "file-tmp" || (isVercelPreview && config.provider !== "postgres")) {
    return resolveTmpStorePath(input.fileName);
  }

  if (config.provider === "file-volume" || config.isProduction) {
    return path.join(config.durableFileBaseDir ?? PRODUCTION_DATA_DIR, input.fileName);
  }

  if (env.VERCEL) {
    return resolveTmpStorePath(input.fileName);
  }

  return path.join(".demo-state", input.fileName);
}
