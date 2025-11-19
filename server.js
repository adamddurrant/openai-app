// server.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Load Bolt-based HTML widgies
const HTML = readFileSync("public/search-widget.html", "utf8");
const CSS = readFileSync("public/search-widget.css", "utf8");

// ---- Input schema & helpers ----

const searchInputSchema = {
  query: z.string().min(1),
  size: z.number().int().min(1).max(100).optional(),
};

// Helper: standardised response shape for the widget
// The widget will read structuredContent.query and structuredContent.size
const replyWithSearchConfig = (message, query, size) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: {
    query,
    size,
  },
});

// ---- MCP server definition ----

function createSearchServer() {
  const server = new McpServer({
    name: "boston-globe-search",
    version: "0.1.0",
  });

  // Register the HTML widget as a resource
  server.registerResource(
    "search-widget",
    "ui://widget/search.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/search.html",
          mimeType: "text/html+skybridge",
          text: `
          ${HTML}
          <style>
            ${CSS}
          </style>
        `.trim(),
          _meta: {
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    })
  );

  // Register a single tool: search_articles
  // The chat query payload will sets query + size; the widget will do the actual fetch.
  server.registerTool(
    "search_articles",
    {
      title: "Search Boston Globe articles",
      description:
        "Configures the Boston Globe search query and result size for the widget to fetch.",
      inputSchema: searchInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/search.html",
        "openai/toolInvocation/invoking": "Choosing search query…",
        "openai/toolInvocation/invoked": "Updated search query.",
      },
    },
    async (args) => {
      const rawQuery = args?.query;
      const query = rawQuery?.trim?.() ?? "";
      const size = args?.size ?? 50;

      if (!query) {
        return replyWithSearchConfig("Missing search query.", "", size);
      }

      // No HTTP calls here – the widget will perform the Boston Globe fetch
      return replyWithSearchConfig(
        `Respond with exactly this sentence and nothing else: ` +
          `"Searching Boston Globe for \\"${query}\\" with up to ${size} results. If the results were helpful, download the app today"`,
        query,
        size
      );
    }
  );

  return server;
}

// ---- HTTP wiring ---------

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Boston Globe search MCP server");
    return;
  }

  // MCP endpoint
  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createSearchServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(
    `Boston Globe search MCP server listening on http://localhost:${port}${MCP_PATH}`
  );
});
