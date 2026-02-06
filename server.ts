/**
 * Deno Text Intelligence Starter - Backend Server
 *
 * This is a simple Deno HTTP server that provides a text intelligence API endpoint
 * powered by Deepgram's Text Intelligence service. It's designed to be easily
 * modified and extended for your own projects.
 *
 * Key Features:
 * - API endpoint: POST /text-intelligence/analyze
 * - Accepts text or URL in JSON body
 * - Supports multiple intelligence features: summarization, topics, sentiment, intents
 * - Proxies to Vite dev server in development
 * - Serves static frontend in production
 * - Native TypeScript support
 * - No external web framework needed
 */

import { createClient } from "@deepgram/sdk";
import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";

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
  frontendPort: number;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8081"),
  host: Deno.env.get("HOST") || "0.0.0.0",
  frontendPort: parseInt(Deno.env.get("FRONTEND_PORT") || "8080"),
};

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

const deepgram = createClient(apiKey);

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Get CORS headers for API responses
 */
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": `http://localhost:${config.frontendPort}`,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
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
// API ROUTE HANDLERS
// ============================================================================

/**
 * POST /text-intelligence/analyze
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

    // Send analysis request to Deepgram (SDK v4 returns { result, error })
    const { result, error } = text
      ? await deepgram.read.analyzeText({ text }, options)
      : await deepgram.read.analyzeUrl({ url: textUrl }, options);

    // Handle SDK errors
    if (error) {
      console.error("Deepgram API Error:", error);
      const errorMsg = (error.message || "").toLowerCase();

      // Detect URL-related errors
      const isUrlError = textUrl && (
        errorMsg.includes('url') ||
        errorMsg.includes('unreachable') ||
        errorMsg.includes('invalid') ||
        errorMsg.includes('malformed')
      );

      return new Response(
        JSON.stringify({
          error: {
            type: "processing_error",
            code: isUrlError ? "INVALID_URL" : "INVALID_TEXT",
            message: error.message || "Failed to process text",
            details: {},
          },
        }),
        { status: 400, headers }
      );
    }

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

  // API Routes
  if (req.method === "POST" && url.pathname === "/text-intelligence/analyze") {
    return handleAnalysis(req);
  }

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
console.log(`📡 CORS enabled for http://localhost:${config.frontendPort}`);
console.log(`\n💡 Frontend should be running on http://localhost:${config.frontendPort}`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
