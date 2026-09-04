import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { withExternalApiAuthAny, type ApiAccessPrincipal } from "@/lib/api-access";
import { retrieveContext } from "@/lib/context-system";
import { createStudy, listPersonas, listStudies } from "@/lib/studies";

function toolScopeError(scope: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `This API key does not grant ${scope}.` }],
  };
}

function createMcpServer(principal: ApiAccessPrincipal) {
  const server = new McpServer({ name: "atypica-gea", version: "1.0.0" });

  server.registerTool("context_search", {
    description: "Search approved Context assets in the current workspace.",
    inputSchema: {
      query: z.string().min(2).max(1000),
      limit: z.number().int().min(1).max(20).default(8),
    },
  }, async ({ query, limit }) => {
    if (!principal.scopes.includes("context:read")) return toolScopeError("context:read");
    const snapshot = await retrieveContext({
      workspaceId: principal.viewer.workspaceId,
      userId: principal.viewer.userId,
      query,
      limit,
      purpose: "general",
    });
    return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
  });

  server.registerTool("list_personas", {
    description: "List retained Personas available in the current workspace.",
    inputSchema: {},
  }, async () => {
    if (!principal.scopes.includes("personas:read")) return toolScopeError("personas:read");
    const result = await listPersonas(principal.viewer);
    return { content: [{ type: "text", text: JSON.stringify(result.personas) }] };
  });

  server.registerTool("list_studies", {
    description: "List recent studies in the current workspace.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
  }, async ({ limit }) => {
    if (!principal.scopes.includes("studies:read")) return toolScopeError("studies:read");
    const studies = await listStudies(principal.viewer, limit);
    return { content: [{ type: "text", text: JSON.stringify(studies) }] };
  });

  server.registerTool("create_study", {
    description: "Create a research or market insight study in planning state.",
    inputSchema: {
      brief: z.string().min(12).max(4000),
      productLine: z.enum(["research", "market_insight"]).default("research"),
      gptResearcherReportType: z.enum(["research_report", "deep", "detailed_report", "subtopic_report"]).default("research_report"),
    },
  }, async ({ brief, productLine, gptResearcherReportType }) => {
    if (!principal.scopes.includes("studies:write")) return toolScopeError("studies:write");
    const publicId = await createStudy(principal.viewer, brief, productLine, undefined, gptResearcherReportType);
    return { content: [{ type: "text", text: JSON.stringify({ publicId, status: "planning" }) }] };
  });

  return server;
}

export async function POST(request: Request) {
  return withExternalApiAuthAny(
    request,
    ["context:read", "personas:read", "studies:read", "studies:write"],
    async (principal) => {
      const server = createMcpServer(principal);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      await server.close();
      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  );
}

export async function GET() {
  return NextResponse.json({ error: { code: "method_not_allowed", message: "Use POST for Streamable HTTP MCP." } }, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json({ error: { code: "method_not_allowed", message: "Stateless MCP sessions do not support DELETE." } }, { status: 405 });
}
