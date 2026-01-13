#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, createReadStream } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const server = new McpServer({
  name: "coverage-lens",
  version: "1.0.0",
});

function sanitizeInput(input: string): string {
  return input.replace(/^["']|["']$/g, "").trim();
}

function hasFileExtension(fileName: string): boolean {
  return /\.[a-zA-Z0-9]+$/.test(fileName);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCoverageReportFile(): string | null {
  const envPath = process.env.COVERAGE_REPORT_FILE_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const defaultPath = join(process.cwd(), "coverage", "clover.xml");
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  return null;
}

async function extractFileTag(
  reportFilePath: string,
  target: string,
  searchBy: "name" | "path" = "name"
): Promise<string | null> {
  const stream = createReadStream(reportFilePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let capturing = false;
  let content = "";

  let startPattern: RegExp;

  if (searchBy === "path") {
    startPattern = new RegExp(
      `<file[^>]*path="[^"]*${escapeRegex(target)}[^"]*"[^>]*>`
    );
  } else {
    startPattern = hasFileExtension(target)
      ? new RegExp(`<file[^>]*name="[^"]*${escapeRegex(target)}"[^>]*>`)
      : new RegExp(
          `<file[^>]*name="[^"]*${escapeRegex(target)}(\\.[^"]+)?"[^>]*>`
        );
  }

  try {
    for await (const line of rl) {
      if (!capturing && startPattern.test(line)) {
        capturing = true;
      }

      if (capturing) {
        content += line + "\n";

        if (line.includes("</file>")) {
          return content;
        }
      }
    }

    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

server.registerTool(
  "get_file_coverage",
  {
    description:
      "Returns coverage data for a specific file from the test report",
    inputSchema: {
      targetFile: z.string().describe("File name to get coverage for"),
    },
  },
  async ({ targetFile }) => {
    const resolvedPath = findCoverageReportFile();
    const cleanTargetFile = sanitizeInput(targetFile);

    if (!resolvedPath) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Coverage report not found at " + resolvedPath,
              suggestion:
                "Set the COVERAGE_REPORT_FILE_PATH environment variable (optional)",
            }),
          },
        ],
      };
    }

    if (!existsSync(resolvedPath)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `File not found: ${resolvedPath}`,
            }),
          },
        ],
      };
    }

    let coverage = await extractFileTag(resolvedPath, cleanTargetFile, "name");

    if (!coverage) {
      coverage = await extractFileTag(resolvedPath, cleanTargetFile, "path");
    }

    if (!coverage) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `File '${cleanTargetFile}' not found in coverage report`,
              filePath: resolvedPath,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: coverage,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("coverage-lens MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
