#!/usr/bin/env node
/** Run the Rust schema freshness checker from Cargo locally or a copied binary in Docker. */
import { spawnSync } from "node:child_process";

const binary = process.env.DOCKERMAP_CONTRACT_SCHEMA_GENERATOR;
const command = binary ?? "cargo";
const args = binary
  ? ["--check"]
  : ["run", "-p", "dockermap-core", "--bin", "generate-contract-schemas", "--manifest-path", "crates/Cargo.toml", "--", "--check"];
const result = spawnSync(command, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
