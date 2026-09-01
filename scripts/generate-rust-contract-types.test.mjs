import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const generator = resolve(root, "scripts/generate-rust-contract-types.mjs");
const sourceSchemas = resolve(root, "packages/contracts/generated/rust");

test("a deliberate Rust ContainerRecord field change makes generated TypeScript stale", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "dockermap-rust-ts-drift-"));
  try {
    const schemas = resolve(directory, "schemas");
    const output = resolve(directory, "rustModels.ts");
    await cp(sourceSchemas, schemas, { recursive: true });

    // This simulates the schema that Schemars emits after adding
    // `#[serde(rename = "contractDrift")] pub contract_drift: bool` to
    // Rust's public ContainerRecord. It exercises the real declaration
    // generator, rather than casting a fixture to a handwritten type.
    for (const file of ["docker-snapshot", "containers-response"]) {
      const path = resolve(schemas, `${file}.schema.json`);
      const schema = JSON.parse(await readFile(path, "utf8"));
      const record = schema.$defs?.ContainerRecord;
      if (record) {
        record.properties.contractDrift = { type: "boolean" };
        record.required = [...record.required, "contractDrift"];
        await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`);
      }
    }
    const detailPath = resolve(schemas, "container-detail-response.schema.json");
    const detail = JSON.parse(await readFile(detailPath, "utf8"));
    detail.properties.contractDrift = { type: "boolean" };
    detail.required = [...detail.required, "contractDrift"];
    await writeFile(detailPath, `${JSON.stringify(detail, null, 2)}\n`);

    const result = spawnSync(process.execPath, [generator], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DOCKERMAP_RUST_SCHEMA_DIRECTORY: schemas, DOCKERMAP_RUST_MODELS_OUTPUT: output }
    });
    assert.equal(result.status, 0, result.stderr);
    const declarations = await readFile(output, "utf8");
    assert.match(declarations, /contractDrift: boolean/);

    const stale = spawnSync(process.execPath, [generator, "--check"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DOCKERMAP_RUST_SCHEMA_DIRECTORY: schemas, DOCKERMAP_RUST_MODELS_OUTPUT: resolve(root, "packages/contracts/src/rustModels.ts") }
    });
    assert.notEqual(stale.status, 0, "a Rust model field drift must fail the generated declaration freshness check");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a transparent detail alias when its Rust wrapper schema drifts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "dockermap-transparent-wrapper-drift-"));
  try {
    const schemas = resolve(directory, "schemas");
    await cp(sourceSchemas, schemas, { recursive: true });
    const path = resolve(schemas, "container-detail-response.schema.json");
    const schema = JSON.parse(await readFile(path, "utf8"));
    schema.properties.wrapperOnly = { type: "string" };
    schema.required = [...schema.required, "wrapperOnly"];
    await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`);
    const result = spawnSync(process.execPath, [generator], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DOCKERMAP_RUST_SCHEMA_DIRECTORY: schemas, DOCKERMAP_RUST_MODELS_OUTPUT: resolve(directory, "rustModels.ts") }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /transparent ContainerDetailResponse schema differs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
