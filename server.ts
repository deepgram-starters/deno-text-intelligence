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
  vitePort: number;
  isDevelopment: boolean;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8080"),
  host: Deno.env.get("HOST") || "0.0.0.0",
  vitePort: parseInt(Deno.env.get("VITE_PORT") || "8081"),
  isDevelopment: Deno.env.get("NODE_ENV") === "development",
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

  return Response.json(errorBody, { status: statusCode });
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

    // Echo X-Request-Id header if provided
    const requestId = req.headers.get("x-request-id");
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (requestId) {
      headers["x-request-id"] = requestId;
    }

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
      return new Response(
        JSON.stringify({
          error: {
            type: "processing_error",
            code: "INVALID_TEXT",
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
        { status: 500 }
      );
    }

    return Response.json(config.meta);
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// FRONTEND SERVING - Development proxy or production static files
// ============================================================================

/**
 * Get content type based on file extension
 */
function getContentType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };
  return types[ext || ""] || "application/octet-stream";
}

/**
 * Serve static file from frontend/dist
 */
async function serveStaticFile(pathname: string): Promise<Response> {
  const filePath = pathname === "/"
    ? "./frontend/dist/index.html"
    : `./frontend/dist${pathname}`;

  try {
    const file = await Deno.readFile(filePath);
    const contentType = getContentType(filePath);
    return new Response(file, {
      headers: { "content-type": contentType },
    });
  } catch {
    // Return index.html for SPA routing (404s -> index.html)
    try {
      const index = await Deno.readFile("./frontend/dist/index.html");
      return new Response(index, {
        headers: { "content-type": "text/html" },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
}

/**
 * Handle frontend requests - proxy to Vite in dev, serve static in prod
 */
async function handleFrontend(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (config.isDevelopment) {
    // Proxy to Vite dev server
    const viteUrl = `http://localhost:${config.vitePort}${url.pathname}${url.search}`;

    try {
      const response = await fetch(viteUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      return response;
    } catch {
      return new Response(
        `Vite dev server not running on port ${config.vitePort}`,
        { status: 502 }
      );
    }
  }

  // Production mode - serve static files
  return serveStaticFile(url.pathname);
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // In dev mode, proxy WebSocket connections to Vite for HMR
  if (config.isDevelopment) {
    const upgrade = req.headers.get("upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      // Proxy WebSocket to Vite dev server
      const viteUrl = `ws://localhost:${config.vitePort}${url.pathname}${url.search}`;

      try {
        const { socket, response } = Deno.upgradeWebSocket(req);
        const viteWs = new WebSocket(viteUrl);

        viteWs.onopen = () => {
          socket.onmessage = (e) => viteWs.readyState === WebSocket.OPEN && viteWs.send(e.data);
          socket.onclose = () => viteWs.close();
          socket.onerror = () => viteWs.close();
        };

        viteWs.onmessage = (e) => socket.readyState === WebSocket.OPEN && socket.send(e.data);
        viteWs.onclose = () => socket.readyState === WebSocket.OPEN && socket.close();
        viteWs.onerror = () => socket.readyState === WebSocket.OPEN && socket.close();

        return response;
      } catch (err) {
        console.error("WebSocket proxy error:", err);
        return new Response("WebSocket proxy failed", { status: 500 });
      }
    }
  }

  // API Routes
  if (req.method === "POST" && url.pathname === "/text-intelligence/analyze") {
    return handleAnalysis(req);
  }

  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // Frontend (catch-all)
  return handleFrontend(req);
}

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`🚀 Deno Text Intelligence Server running at http://localhost:${config.port}`);
if (config.isDevelopment) {
  console.log(`📡 Proxying frontend from Vite dev server on port ${config.vitePort}`);
  console.log(`\n⚠️  Open your browser to http://localhost:${config.port}`);
} else {
  console.log(`📦 Serving built frontend from frontend/dist`);
}
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
