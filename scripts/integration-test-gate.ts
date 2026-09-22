import process from "node:process";

export type IntegrationTestMode = "run" | "local-skip" | "ci-missing-database-url";
export type Environment = Record<string, string | undefined>;

function isTrue(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

export function isCiEnvironment(env: Environment = process.env): boolean {
  return isTrue(env.CI) || isTrue(env.GITHUB_ACTIONS);
}

export function hasDatabaseUrl(env: Environment = process.env): boolean {
  return Boolean(env.DATABASE_URL?.trim());
}

export function integrationTestMode(env: Environment = process.env): IntegrationTestMode {
  if (hasDatabaseUrl(env)) return "run";
  return isCiEnvironment(env) ? "ci-missing-database-url" : "local-skip";
}
