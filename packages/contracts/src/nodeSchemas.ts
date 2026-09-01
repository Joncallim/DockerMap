/**
 * Canonical JSON Schema declarations for bytes created by the Node API.
 *
 * Rust-owned payloads deliberately do not appear here. They are emitted and
 * validated from `generated/rust/`; the Node API may proxy them, but must not
 * claim a second schema authority for their success shapes.
 */
export const NODE_ENVELOPE_SCHEMAS = {
  ApiError: {
    type: "object",
    additionalProperties: false,
    required: ["code", "message"],
    properties: {
      code: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      // Error details are deliberately opt-in/redacted by the API policy and
      // may have route-specific structure. The envelope owns their presence,
      // not an invented universal shape.
      details: {}
    }
  },
  AuthWhoami: {
    type: "object",
    additionalProperties: false,
    required: ["authenticated", "required", "user", "name", "email", "groups"],
    properties: {
      authenticated: { type: "boolean" },
      required: { type: "boolean" },
      user: { type: "string", nullable: true },
      name: { type: "string", nullable: true },
      email: { type: "string", nullable: true },
      groups: { type: "array", items: { type: "string" } }
    }
  },
  Diagnostics: {
    type: "object",
    additionalProperties: false,
    required: ["generatedAt", "entries"],
    properties: {
      generatedAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "source", "severity", "message", "file", "service"],
          properties: {
            id: { type: "string", nullable: true },
            source: { enum: ["compose", "runtime", "api"] },
            severity: { enum: ["info", "warning", "error", "blocked"] },
            message: { type: "string" },
            file: { type: "string", nullable: true },
            service: { type: "string", nullable: true }
          }
        }
      }
    }
  },
  Status: {
    type: "object",
    additionalProperties: false,
    required: [
      "service", "status", "mode", "sourceCoherent", "snapshotSource", "dockerReachable",
      "containers", "containersRunning", "networks", "volumes", "images", "healthy", "attention", "offline", "version"
    ],
    properties: {
      service: { enum: ["dockermap"] },
      status: { enum: ["ok", "degraded", "offline"] },
      mode: { enum: ["docker", "mock", "mixed"] },
      sourceCoherent: { type: "boolean" },
      snapshotSource: { enum: ["docker", "mock"] },
      dockerReachable: { type: "boolean" },
      containers: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      containersRunning: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      networks: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      volumes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      images: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      healthy: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      attention: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      offline: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      version: { type: "string", minLength: 1 }
    }
  },
  Version: {
    type: "object",
    additionalProperties: false,
    required: ["service", "apiVersion", "version"],
    properties: {
      service: { enum: ["dockermap"] },
      apiVersion: { enum: ["v1"] },
      version: { type: "string", minLength: 1 }
    }
  },
  RootHealth: {
    type: "object",
    additionalProperties: false,
    required: ["status", "daemon"],
    properties: {
      status: { enum: ["ok"] },
      // The daemon value remains Rust-owned; this Node envelope intentionally
      // makes no duplicate claim about its fields.
      daemon: { type: "object" }
    }
  },
  ApiHealth: {
    type: "object",
    additionalProperties: false,
    required: ["node", "daemon", "dockerReachable"],
    properties: {
      node: {
        type: "object",
        additionalProperties: false,
        required: ["status", "port"],
        properties: {
          status: { enum: ["ok"] },
          port: { type: "integer", minimum: 1, maximum: 65535 }
        }
      },
      // See RootHealth: this is a delegation boundary, not a copied Rust
      // schema embedded in Node.
      daemon: { type: "object" },
      dockerReachable: { type: "boolean" }
    }
  }
} as const;

export type NodeEnvelopeSchemaId = keyof typeof NODE_ENVELOPE_SCHEMAS;
