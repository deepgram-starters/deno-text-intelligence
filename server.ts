/**
 * Deno Text Intelligence Starter - Backend Server
 *
 * This is a simple Deno HTTP server that provides a text intelligence API endpoint
 * powered by Deepgram's Text Intelligence service. It's designed to be easily
 * modified and extended for your own projects.
 *
 * Key Features:
 * - API endpoint: POST /api/text-intelligence
 * - Accepts text or URL in JSON body
 * - Supports multiple intelligence features: summarization, topics, sentiment, intents
 * - JWT session auth for API protection
 * - Native TypeScript support
 * - No external web framework needed
 */

import { DeepgramClient } from "@deepgram/sdk";
import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";
import * as jose from "jose";

// Load environment variables
await load({ export: true });

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  port: number;
  host: string;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8081"),
  host: Deno.env.get("HOST") || "0.0.0.0",
};

// ============================================================================
// SESSION AUTH - JWT tokens for API protection
// ============================================================================

const SESSION_SECRET = Deno.env.get("SESSION_SECRET") || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
const SESSION_SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

const JWT_EXPIRY = "1h";

let indexHtmlTemplate: string | null = null;
try {
  indexHtmlTemplate = await Deno.readTextFile(
    new URL("./frontend/dist/index.html", import.meta.url).pathname
  );
} catch {
  // No built frontend (dev mode)
}

/**
 * Creates a signed JWT session token
 */
async function createSessionToken(): Promise<string> {
  return await new jose.SignJWT({ iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(JWT_EXPIRY)
    .sign(SESSION_SECRET_KEY);
}

/**
 * Verifies a JWT session token
 */
async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jose.jwtVerify(token, SESSION_SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// API KEY LOADING - Load Deepgram API key from environment
// ============================================================================

/**
 * Loads the Deepgram API key from environment variables
 */
function loadApiKey(): string {
  const apiKey = Deno.env.get("DEEPGRAM_API_KEY");

  if (!apiKey) {
    console.error("\n❌ ERROR: Deepgram API key not found!\n");
    console.error("Please set your API key using one of these methods:\n");
    console.error("1. Create a .env file (recommended):");
    console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("2. Environment variable:");
    console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("Get your API key at: https://console.deepgram.com\n");
    Deno.exit(1);
  }

  return apiKey;
}

const apiKey = loadApiKey();

// ============================================================================
// SETUP - Initialize Deepgram client
// ============================================================================

const deepgram = new DeepgramClient({ apiKey });

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Get CORS headers for API responses
 */
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ============================================================================
// TYPES - TypeScript interfaces for request/response
// ============================================================================

interface ErrorResponse {
  error: {
    type: "validation_error" | "processing_error";
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates text intelligence input
 */
function validateAnalysisInput(
  text: string | undefined,
  url: string | undefined
): string | null {
  if (!text && !url) {
    return "Request must contain either 'text' or 'url' field";
  }
  if (text && url) {
    return "Request must contain only one of 'text' or 'url', not both";
  }
  return null;
}

/**
 * Formats error responses in a consistent structure
 */
function formatErrorResponse(
  error: Error,
  statusCode: number = 500,
  code?: string,
  type?: string
): Response {
  const errorBody: ErrorResponse = {
    error: {
      type: (type || (statusCode === 400 ? "validation_error" : "processing_error")) as "validation_error" | "processing_error",
      code: code || (statusCode === 400 ? "INVALID_TEXT" : "ANALYSIS_FAILED"),
      message: error.message || "An error occurred during analysis",
      details: {},
    },
  };

  return Response.json(errorBody, {
    status: statusCode,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * Serve index.html (production only)
 */
function handleServeIndex(): Response {
  if (!indexHtmlTemplate) {
    return new Response("Frontend not built. Run make build first.", { status: 404 });
  }
  return new Response(indexHtmlTemplate, {
    headers: { "Content-Type": "text/html", ...getCorsHeaders() },
  });
}

/**
 * GET /api/session
 * Issues a signed JWT session token.
 */
async function handleGetSession(): Promise<Response> {
  const token = await createSessionToken();
  return Response.json({ token }, { headers: getCorsHeaders() });
}

/**
 * Validates JWT from Authorization header. Returns error Response or null if OK.
 */
async function checkAuth(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return Response.json(
      { error: { type: "AuthenticationError", code: "MISSING_TOKEN", message: "Authorization header with Bearer token is required" } },
      { status: 401, headers: getCorsHeaders() }
    );
  }
  const token = authHeader.slice(7);
  if (!(await verifySessionToken(token))) {
    return Response.json(
      { error: { type: "AuthenticationError", code: "INVALID_TOKEN", message: "Invalid or expired session token" } },
      { status: 401, headers: getCorsHeaders() }
    );
  }
  return null;
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * POST /api/text-intelligence
 * Main text intelligence endpoint
 */
async function handleAnalysis(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const body = await req.json();
    const { text, url: textUrl } = body;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...getCorsHeaders(),
    };

    // Validate input
    const validationError = validateAnalysisInput(text, textUrl);
    if (validationError) {
      return new Response(
        JSON.stringify({
          error: {
            type: "validation_error",
            code: "INVALID_TEXT",
            message: validationError,
            details: {},
          },
        }),
        { status: 400, headers }
      );
    }

    // Extract query parameters for intelligence features
    const options: Record<string, unknown> = {
      language: url.searchParams.get("language") || "en"
    };

    const summarize = url.searchParams.get("summarize");
    if (summarize === "true") {
      options.summarize = true;
    } else if (summarize === "v2") {
      options.summarize = "v2";
    } else if (summarize === "v1") {
      // v1 is no longer supported
      return new Response(
        JSON.stringify({
          error: {
            type: "validation_error",
            code: "INVALID_TEXT",
            message: "Summarization v1 is no longer supported. Please use v2 or true.",
            details: {},
          },
        }),
        { status: 400, headers }
      );
    }

    const topics = url.searchParams.get("topics");
    if (topics === "true") options.topics = true;

    const sentiment = url.searchParams.get("sentiment");
    if (sentiment === "true") options.sentiment = true;

    const intents = url.searchParams.get("intents");
    if (intents === "true") options.intents = true;

    // Send analysis request to Deepgram (SDK v5 throws on error)
    const result = text
      ? await deepgram.read.v1.text.analyze({ ...options, body: { text } })
      : await deepgram.read.v1.text.analyze({ ...options, body: { url: textUrl } });

    // Return full results object (includes all requested features)
    return new Response(
      JSON.stringify({ results: result.results || {} }),
      { status: 200, headers }
    );
  } catch (err) {
    console.error("Analysis error:", err);
    return formatErrorResponse(err as Error);
  }
}

/**
 * GET /api/metadata
 * Returns metadata about this starter application
 */
async function handleMetadata(): Promise<Response> {
  try {
    const tomlContent = await Deno.readTextFile("./deepgram.toml");
    const config = TOML.parse(tomlContent);

    if (!config.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500, headers: getCorsHeaders() }
      );
    }

    return Response.json(config.meta, { headers: getCorsHeaders() });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

// ============================================================================
// CORS PREFLIGHT HANDLER
// ============================================================================

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handlePreflight();
  }

  // Session routes (unprotected)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return handleServeIndex();
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    return await handleGetSession();
  }

  // API Routes (auth required)
  if (req.method === "POST" && url.pathname === "/api/text-intelligence") {
    const authError = await checkAuth(req);
    if (authError) return authError;
    return handleAnalysis(req);
  }

  // Metadata (unprotected)
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // 404 for all other routes
  return Response.json(
    { error: "Not Found", message: "Endpoint not found" },
    { status: 404, headers: getCorsHeaders() }
  );
}

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`🚀 Backend API Server running at http://localhost:${config.port}`);
console.log("");
console.log(`📡 GET  /api/session`);
console.log(`📡 POST /api/text-intelligence (auth required)`);
console.log(`📡 GET  /api/metadata`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
