import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const API_PATH = "/api/data.xls";

function readRequestBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolveBuffer, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolveBuffer(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function createDataFileApiPlugin(): Plugin {
  const rootPath = process.cwd();
  const sourceDataPath = resolve(rootPath, "data.xls");
  const publicDataPath = resolve(rootPath, "public", "data.xls");

  const middleware = async (
    request: NodeJS.ReadableStream & { method?: string; url?: string },
    response: {
      statusCode: number;
      setHeader: (name: string, value: string) => void;
      end: (content?: string | Buffer) => void;
    },
    next: () => void
  ) => {
    if (!request.url?.startsWith(API_PATH)) {
      next();
      return;
    }

    if (request.method === "GET") {
      try {
        let content: Buffer;
        try {
          content = await readFile(sourceDataPath);
        } catch {
          content = await readFile(publicDataPath);
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/vnd.ms-excel");
        response.setHeader("Cache-Control", "no-store");
        response.end(content);
      } catch (error) {
        console.error("[data-api] failed to read data.xls", error);
        response.statusCode = 500;
        response.end("failed to read data.xls");
      }
      return;
    }

    if (request.method === "POST") {
      try {
        const body = await readRequestBody(request);
        if (body.length === 0) {
          response.statusCode = 400;
          response.end("request body is empty");
          return;
        }
        await mkdir(resolve(rootPath, "public"), { recursive: true });
        await writeFile(sourceDataPath, body);
        await writeFile(publicDataPath, body);
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ ok: true, bytes: body.length }));
      } catch (error) {
        console.error("[data-api] failed to write data.xls", error);
        response.statusCode = 500;
        response.end("failed to write data.xls");
      }
      return;
    }

    response.statusCode = 405;
    response.end("method not allowed");
  };

  return {
    name: "data-file-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void middleware(request, response, next);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        void middleware(request, response, next);
      });
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), createDataFileApiPlugin()]
});
