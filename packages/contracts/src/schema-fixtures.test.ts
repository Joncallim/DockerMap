import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const fixtures = [
  ["docker-snapshot", ["mock-snapshot.json"]],
  ["graph-response", ["graph-response.json"]],
  ["runtime-map", ["runtime-map.json", "runtime-map-expanded.json", "runtime-map-daemon-emitted.json"]],
  ["compose-scan", ["compose-scan.json"]],
  ["compose-graph", ["compose-graph.json"]],
  ["compose-edit-plan", ["compose-edit-plan.json"]],
  ["logs-response", ["logs-response.json"]],
  ["health-response", ["health-response.json"]]
] as const;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readSchema(path: string): Promise<AnySchema> {
  return await readJson(path) as AnySchema;
}

describe("Rust-owned daemon schema baseline", () => {
  it.each(fixtures)("validates %s fixtures against the committed generated schema", async (schemaName, fixtureNames) => {
    const schemaPath = `${repoRoot}packages/contracts/generated/rust/${schemaName}.schema.json`;
    const schema = await readSchema(schemaPath);
    const validator = new Ajv2020({ allErrors: true, formats: { uint64: true } }).compile(schema);

    for (const fixtureName of fixtureNames) {
      const fixture = await readJson(`${repoRoot}tests/fixtures/contracts/${fixtureName}`);
      expect(validator(fixture), `${fixtureName}: ${JSON.stringify(validator.errors)}`).toBe(true);
    }
  });

  it("rejects a fixture that drifts from the Rust-owned serialization shape", async () => {
    const schema = await readSchema(`${repoRoot}packages/contracts/generated/rust/docker-snapshot.schema.json`);
    const validator = new Ajv2020({ allErrors: true, formats: { uint64: true } }).compile(schema);
    const fixture = await readJson(`${repoRoot}tests/fixtures/contracts/mock-snapshot.json`) as {
      lastUpdated: unknown;
    };

    fixture.lastUpdated = "not-a-timestamp";

    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.some((error) => error.instancePath === "/lastUpdated")).toBe(true);
  });

  it("rejects integers above the browser-safe JSON range", async () => {
    const schema = await readSchema(`${repoRoot}packages/contracts/generated/rust/docker-snapshot.schema.json`);
    const validator = new Ajv2020({ allErrors: true, formats: { uint64: true } }).compile(schema);
    const fixture = await readJson(`${repoRoot}tests/fixtures/contracts/mock-snapshot.json`) as {
      lastUpdated: unknown;
    };

    fixture.lastUpdated = Number.MAX_SAFE_INTEGER + 1;

    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.some((error) => error.instancePath === "/lastUpdated")).toBe(true);
  });

  it("rejects an undeclared response field instead of letting fixtures redefine the contract", async () => {
    const schema = await readSchema(`${repoRoot}packages/contracts/generated/rust/health-response.schema.json`);
    const validator = new Ajv2020({ allErrors: true, formats: { uint64: true } }).compile(schema);
    const fixture = await readJson(`${repoRoot}tests/fixtures/contracts/health-response.json`) as Record<string, unknown>;

    fixture.unreviewed = true;

    expect(validator(fixture)).toBe(false);
    expect(validator.errors?.some((error) => error.keyword === "additionalProperties")).toBe(true);
  });
});
