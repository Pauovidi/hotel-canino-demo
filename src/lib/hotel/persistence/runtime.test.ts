import { describe, expect, it } from "vitest";
import { readHotelPersistenceConfig, resolveJsonStorePath } from "./runtime";

describe("production persistence runtime", () => {
  it("selects postgres in production when DATABASE_URL is configured", () => {
    const config = readHotelPersistenceConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://example",
    } as NodeJS.ProcessEnv);

    expect(config.provider).toBe("postgres");
    expect(config.databaseUrlConfigured).toBe(true);
  });

  it("falls back to /data file-volume in production instead of /tmp", () => {
    const filePath = resolveJsonStorePath({
      fileName: "hotel-store.json",
      env: {
        NODE_ENV: "production",
        HOTEL_PERSISTENCE_PROVIDER: "file-volume",
      } as NodeJS.ProcessEnv,
    });

    const normalized = filePath.replaceAll("\\", "/");
    expect(normalized).toBe("/data/hotel-store.json");
    expect(normalized).not.toContain("/tmp");
  });

  it("uses tmp storage for Vercel Preview instead of trying to create /data", () => {
    const config = readHotelPersistenceConfig({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
    } as NodeJS.ProcessEnv);
    const filePath = resolveJsonStorePath({
      fileName: "hotel-conversations.json",
      env: {
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
      } as NodeJS.ProcessEnv,
    });

    const normalized = filePath.replaceAll("\\", "/");
    expect(config.provider).toBe("file-tmp");
    expect(normalized).toContain("/hotel-canino-demo/hotel-conversations.json");
    expect(normalized).not.toBe("/data/hotel-conversations.json");
  });

  it("uses tmp storage on Vercel production when no durable store is configured", () => {
    const config = readHotelPersistenceConfig({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
    } as NodeJS.ProcessEnv);
    const filePath = resolveJsonStorePath({
      fileName: "hotel-canino-domain.json",
      env: {
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "production",
      } as NodeJS.ProcessEnv,
    });

    const normalized = filePath.replaceAll("\\", "/");
    expect(config.provider).toBe("file-tmp");
    expect(normalized).toContain("/hotel-canino-demo/hotel-canino-domain.json");
    expect(normalized).not.toBe("/data/hotel-canino-domain.json");
  });

  it("can select a durable Google Sheets conversation store on Vercel production", () => {
    const config = readHotelPersistenceConfig({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      HOTEL_CONVERSATIONS_STORE_PROVIDER: "google_sheets",
    } as NodeJS.ProcessEnv);

    expect(config.provider).toBe("file-tmp");
    expect(config.conversationStoreProvider).toBe("google_sheets");
  });

  it("redirects /data file overrides to tmp on Vercel Preview", () => {
    const byDir = resolveJsonStorePath({
      fileName: "hotel-conversations.json",
      dirEnv: "HOTEL_CONVERSATIONS_STORE_DIR",
      env: {
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        HOTEL_CONVERSATIONS_STORE_DIR: "/data",
      } as NodeJS.ProcessEnv,
    }).replaceAll("\\", "/");
    const byPath = resolveJsonStorePath({
      fileName: "hotel-conversations.json",
      pathEnv: "HOTEL_CONVERSATIONS_STORE_PATH",
      env: {
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        HOTEL_CONVERSATIONS_STORE_PATH: "/data/conversations.json",
      } as NodeJS.ProcessEnv,
    }).replaceAll("\\", "/");

    expect(byDir).toContain("/hotel-canino-demo/hotel-conversations.json");
    expect(byPath).toContain("/hotel-canino-demo/conversations.json");
    expect(byDir).not.toContain("/data/");
    expect(byPath).not.toContain("/data/");
  });

  it("honors explicit durable file paths", () => {
    const filePath = resolveJsonStorePath({
      fileName: "hotel-store.json",
      pathEnv: "HOTEL_DEMO_STORE_PATH",
      env: {
        NODE_ENV: "production",
        HOTEL_DEMO_STORE_PATH: "/data/hotel-store.json",
      } as NodeJS.ProcessEnv,
    });

    expect(filePath).toBe("/data/hotel-store.json");
  });
});
