import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { parsePreviewWidth, readStoredAssetPreview } from "./asset-preview.js";
import {
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  OUTPUT_FORMATS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  composePrompt,
  validateSceneImageSize,
  type ApiConfig,
  type AppConfig,
  type GenerationCount,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type ReferenceImageInput,
  type SaveStorageConfigRequest,
  type StylePresetId
} from "./contracts.js";
import { closeDatabase } from "./database.js";
import {
  ProviderError,
  createOpenAIImageProvider,
  getConfiguredImageModel,
  getOpenAIImageProviderConfig,
  type EditImageProviderInput,
  type ImageProviderInput
} from "./image-provider.js";
import { getStoredAssetFile, readStoredAsset, runReferenceImageGeneration, runTextToImageGeneration } from "./image-generation.js";
import { deleteGalleryOutput, getGalleryImages, getProjectState, saveProjectSnapshot } from "./project-store.js";
import { runtimePaths, serverConfig } from "./runtime.js";
import { getStorageConfig, saveStorageConfig, testStorageConfig } from "./storage-config.js";

const MAX_PROJECT_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const MAX_PROJECT_NAME_LENGTH = 120;

interface ProjectPayload {
  name?: string;
  snapshotJson: string;
}

export const app = new Hono();

app.onError((error, c) => {
  console.error(error);
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Internal server error."
      }
    },
    500
  );
});

app.get("/api/health", (c) =>
  c.json({
    status: "ok"
  })
);

app.get("/api/config", (c) => {
  const configuredModel = getConfiguredImageModel();
  const config: AppConfig = {
    model: configuredModel,
    models: [configuredModel],
    sizePresets: SIZE_PRESETS,
    stylePresets: STYLE_PRESETS,
    qualities: IMAGE_QUALITIES,
    outputFormats: OUTPUT_FORMATS,
    counts: GENERATION_COUNTS
  };

  return c.json(config);
});

app.get("/api/project", (c) => c.json(getProjectState()));

app.get("/api/gallery", (c) => c.json(getGalleryImages()));

app.delete("/api/gallery/:outputId", (c) => {
  const deleted = deleteGalleryOutput(c.req.param("outputId"));
  if (!deleted) {
    return c.json(errorResponse("not_found", "找不到请求的 Gallery 图片记录。"), 404);
  }

  return c.json({
    ok: true
  });
});

app.get("/api/storage/config", (c) => c.json(getStorageConfig()));

app.put("/api/storage/config", async (c) => {
  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseStorageConfigPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json(await saveStorageConfig(parsed.value));
  } catch (error) {
    return c.json(errorResponse("storage_config_error", errorToMessage(error)), 400);
  }
});

app.post("/api/storage/config/test", async (c) => {
  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseStorageConfigPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  return c.json(await testStorageConfig(parsed.value));
});

app.get("/api/assets/:id/preview", async (c) => {
  const parsedWidth = parsePreviewWidth(c.req.query("width"));
  if (!parsedWidth.ok) {
    return c.json(errorResponse(parsedWidth.code, parsedWidth.message), 400);
  }

  const preview = await readStoredAssetPreview(c.req.param("id"), parsedWidth.width);
  if (!preview) {
    return c.json(errorResponse("not_found", "Asset not found."), 404);
  }

  return new Response(new Uint8Array(preview.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${downloadFileName(c.req.param("id"))}-${preview.width}.webp"`,
      "Content-Type": "image/webp"
    }
  });
});

app.get("/api/assets/:id/download", async (c) => {
  const asset = await readStoredAsset(c.req.param("id"));
  if (!asset) {
    return c.json(errorResponse("not_found", "找不到请求的图像资源。"), 404);
  }

  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `attachment; filename="${downloadFileName(asset.file.fileName)}"`,
      "Content-Type": asset.file.mimeType
    }
  });
});

app.get("/api/assets/:id", async (c) => {
  const asset = await readStoredAsset(c.req.param("id"));
  if (!asset) {
    return c.json(errorResponse("not_found", "找不到请求的图像资源。"), 404);
  }

  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${asset.file.fileName}"`,
      "Content-Type": asset.file.mimeType
    }
  });
});

app.put("/api/project", async (c) => {
  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    logProjectSaveRejected(payload.error, c.req.raw);
    return c.json(payload.error, 400);
  }

  const parsed = parseProjectPayload(payload.value);
  if (!parsed.ok) {
    logProjectSaveRejected(parsed.error, c.req.raw);
    return c.json(parsed.error, 400);
  }

  return c.json(saveProjectSnapshot(parsed.value));
});

app.post("/api/images/generate", async (c) => {
  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseGeneratePayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  const apiConfig = parseApiConfig(payload.value);
  const providerConfig = getOpenAIImageProviderConfig(apiConfig);
  if (!providerConfig.ok) {
    return providerErrorJson(c, providerConfig.error);
  }

  try {
    const provider = createOpenAIImageProvider(providerConfig.config);
    return c.json(await runTextToImageGeneration(parsed.value, provider, c.req.raw.signal));
  } catch (error) {
    if (error instanceof ProviderError) {
      return providerErrorJson(c, error);
    }

    throw error;
  }
});

app.post("/api/images/edit", async (c) => {
  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseEditPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  const apiConfig = parseApiConfig(payload.value);
  const providerConfig = getOpenAIImageProviderConfig(apiConfig);
  if (!providerConfig.ok) {
    return providerErrorJson(c, providerConfig.error);
  }

  try {
    const provider = createOpenAIImageProvider(providerConfig.config);
    return c.json(await runReferenceImageGeneration(parsed.value, provider, c.req.raw.signal));
  } catch (error) {
    if (error instanceof ProviderError) {
      return providerErrorJson(c, error);
    }

    throw error;
  }
});

const webDistRoot = relative(process.cwd(), runtimePaths.webDistDir) || ".";

app.get("/api/*", (c) => c.json(errorResponse("not_found", "Not found."), 404));

app.get("*", serveStatic({ root: webDistRoot }));
app.get(
  "*",
  serveStatic({
    root: webDistRoot,
    path: "index.html",
    onNotFound: () => {
      console.error(`Built web bundle not found at ${runtimePaths.webDistDir}. Run pnpm build before pnpm start.`);
    }
  })
);

function errorResponse(code: string, message: string): ErrorResponseBody {
  return {
    error: {
      code,
      message
    }
  };
}

function downloadFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
}

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: ErrorResponseBody;
    };

function logProjectSaveRejected(error: ErrorResponseBody, request: Request): void {
  console.warn(
    `Project save rejected: ${error.error.code}. ${error.error.message}${formatRequestBodySummary(request)}`
  );
}

function formatRequestBodySummary(request: Request): string {
  const contentType = sanitizeHeaderValue(request.headers.get("content-type"));
  const contentLength = sanitizeHeaderValue(request.headers.get("content-length"));
  const transferEncoding = sanitizeHeaderValue(request.headers.get("transfer-encoding"));
  const bodySize = contentLength
    ? `content-length=${contentLength}`
    : transferEncoding
      ? `transfer-encoding=${transferEncoding}`
      : "content-length=unknown";

  return ` (${bodySize}, content-type=${contentType || "missing"})`;
}

function sanitizeHeaderValue(value: string | null): string {
  return (value ?? "").replace(/[\r\n]/gu, " ").trim().slice(0, 120);
}

function providerErrorJson(_c: Context, error: ProviderError) {
  const body = errorResponse(error.code, error.message);

  return new Response(JSON.stringify(body), {
    status: providerHttpStatus(error.status),
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function providerHttpStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function parseGeneratePayload(input: unknown): ParseResult<ImageProviderInput> {
  const base = parseBaseImagePayload(input);
  if (!base.ok) {
    return base;
  }

  return {
    ok: true,
    value: base.value
  };
}

function parseEditPayload(input: unknown): ParseResult<EditImageProviderInput> {
  const base = parseBaseImagePayload(input);
  if (!base.ok) {
    return base;
  }

  if (!isRecord(input) || !isRecord(input.referenceImage)) {
    return {
      ok: false,
      error: errorResponse("unsupported_provider_behavior", "编辑图像需要提供一个参考图像。")
    };
  }

  const dataUrl = input.referenceImage.dataUrl;
  if (typeof dataUrl !== "string" || dataUrl.trim().length === 0) {
    return {
      ok: false,
      error: errorResponse("unsupported_provider_behavior", "参考图像格式不受支持。")
    };
  }

  const fileName = input.referenceImage.fileName;
  const referenceAssetId = parseOptionalString(input.referenceAssetId);

  if (referenceAssetId && !getStoredAssetFile(referenceAssetId)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "找不到可记录的本地参考图像资源。")
    };
  }

  const referenceImage: ReferenceImageInput = {
    dataUrl,
    fileName: typeof fileName === "string" && fileName.trim() ? fileName.trim() : undefined
  };

  return {
    ok: true,
    value: {
      ...base.value,
      referenceImage,
      referenceAssetId
    }
  };
}

function parseStorageConfigPayload(input: unknown): ParseResult<SaveStorageConfigRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_storage_config", "Storage config payload must be a JSON object.")
    };
  }

  const enabled = input.enabled === true;
  if (!enabled) {
    return {
      ok: true,
      value: {
        enabled: false,
        provider: "cos"
      }
    };
  }

  const provider = parseOptionalString(input.provider) ?? "cos";
  if (provider !== "cos") {
    return {
      ok: false,
      error: errorResponse("invalid_storage_provider", "Only Tencent COS storage is supported.")
    };
  }

  if (!isRecord(input.cos)) {
    return {
      ok: false,
      error: errorResponse("invalid_storage_config", "COS config must be a JSON object.")
    };
  }

  return {
    ok: true,
    value: {
      enabled: true,
      provider: "cos",
      cos: {
        secretId: stringValue(input.cos.secretId) ?? "",
        secretKey: stringValue(input.cos.secretKey),
        preserveSecret: input.cos.preserveSecret === true,
        bucket: stringValue(input.cos.bucket) ?? "",
        region: stringValue(input.cos.region) ?? "",
        keyPrefix: stringValue(input.cos.keyPrefix) ?? ""
      }
    }
  };
}

function parseBaseImagePayload(input: unknown): ParseResult<ImageProviderInput> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请求内容必须是 JSON 对象。")
    };
  }

  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return {
      ok: false,
      error: errorResponse("invalid_prompt", "请输入有效的提示词。")
    };
  }

  const stylePreset = parseStylePreset(input);
  if (!stylePreset.ok) {
    return stylePreset;
  }

  const size = parseSize(input.size);
  if (!size.ok) {
    return size;
  }

  const sizePresetId = parseOptionalString(input.sizePresetId) ?? parseOptionalString(input.scenePresetId) ?? parseSizePresetFromPresetId(input.presetId);
  const resolvedSize = validateSceneImageSize({
    size: size.value,
    sizePresetId
  });

  if (!resolvedSize.ok) {
    return {
      ok: false,
      error: errorResponse(resolvedSize.code, resolvedSize.message)
    };
  }

  const quality = parseQuality(input.quality);
  if (!quality.ok) {
    return quality;
  }

  const outputFormat = parseOutputFormat(input.outputFormat);
  if (!outputFormat.ok) {
    return outputFormat;
  }

  const count = parseCount(input.count);
  if (!count.ok) {
    return count;
  }

  return {
    ok: true,
    value: {
      originalPrompt: prompt.trim(),
      presetId: stylePreset.value,
      prompt: composePrompt(prompt, stylePreset.value),
      size: resolvedSize.size,
      sizeApiValue: resolvedSize.apiValue,
      quality: quality.value,
      outputFormat: outputFormat.value,
      count: count.value
    }
  };
}

function parseStylePreset(input: Record<string, unknown>): ParseResult<StylePresetId> {
  const presetId = parseOptionalString(input.stylePresetId) ?? parseStylePresetFromPresetId(input.presetId) ?? "none";

  if (!STYLE_PRESETS.some((preset) => preset.id === presetId)) {
    return {
      ok: false,
      error: errorResponse("invalid_prompt", "不支持的风格预设。")
    };
  }

  return {
    ok: true,
    value: presetId as StylePresetId
  };
}

function parseSize(value: unknown): ParseResult<ImageSize> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: errorResponse("invalid_size", "请提供有效的图像尺寸。")
    };
  }

  return {
    ok: true,
    value: {
      width: parseDimension(value.width),
      height: parseDimension(value.height)
    }
  };
}

function parseQuality(value: unknown): ParseResult<ImageQuality> {
  if (value === undefined) {
    return {
      ok: true,
      value: "auto"
    };
  }

  if (typeof value === "string" && IMAGE_QUALITIES.includes(value as ImageQuality)) {
    return {
      ok: true,
      value: value as ImageQuality
    };
  }

  return {
    ok: false,
    error: errorResponse("invalid_request", "不支持的图像质量设置。")
  };
}

function parseOutputFormat(value: unknown): ParseResult<OutputFormat> {
  if (value === undefined) {
    return {
      ok: true,
      value: "png"
    };
  }

  if (typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat)) {
    return {
      ok: true,
      value: value as OutputFormat
    };
  }

  return {
    ok: false,
    error: errorResponse("invalid_request", "不支持的输出格式。")
  };
}

function parseCount(value: unknown): ParseResult<GenerationCount> {
  if (value === undefined) {
    return {
      ok: true,
      value: 1
    };
  }

  if (typeof value === "number" && GENERATION_COUNTS.includes(value as GenerationCount)) {
    return {
      ok: true,
      value: value as GenerationCount
    };
  }

  return {
    ok: false,
    error: errorResponse("invalid_request", "生成数量只能是 1、2 或 4。")
  };
}

function parseDimension(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseApiConfig(input: unknown): ApiConfig | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const apiKey = parseOptionalString(input.apiKey);
  const baseURL = parseOptionalString(input.baseURL);

  if (!apiKey && !baseURL) {
    return undefined;
  }

  return {
    apiKey,
    baseURL
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Request failed.";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseStylePresetFromPresetId(value: unknown): string | undefined {
  const presetId = parseOptionalString(value);
  return presetId && STYLE_PRESETS.some((preset) => preset.id === presetId) ? presetId : undefined;
}

function parseSizePresetFromPresetId(value: unknown): string | undefined {
  const presetId = parseOptionalString(value);
  return presetId && SIZE_PRESETS.some((preset) => preset.id === presetId) ? presetId : undefined;
}

async function readJson(request: Request): Promise<ParseResult<unknown>> {
  const contentType = request.headers.get("content-type");
  if (contentType && !isJsonContentType(contentType)) {
    return {
      ok: false,
      error: errorResponse("unsupported_media_type", "请求 Content-Type 必须是 application/json。")
    };
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return {
      ok: false,
      error: errorResponse("invalid_request_body", "请求体读取失败，请重试。")
    };
  }

  if (bodyText.trim().length === 0) {
    return {
      ok: false,
      error: errorResponse("empty_json", "请求体不能为空，必须是有效的 JSON。")
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(bodyText) as unknown
    };
  } catch {
    return {
      ok: false,
      error: errorResponse("invalid_json", "请求体必须是有效的 JSON。")
    };
  }
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function parseProjectPayload(input: unknown):
  | {
      ok: true;
      value: ProjectPayload;
    }
  | {
      ok: false;
      error: { error: { code: string; message: string } };
    } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_project", "Project payload must be a JSON object.")
    };
  }

  if (!Object.hasOwn(input, "snapshot")) {
    return {
      ok: false,
      error: errorResponse("missing_snapshot", "Project payload must include a snapshot.")
    };
  }

  const snapshot = input.snapshot;
  if (snapshot !== null && (!isRecord(snapshot) || Array.isArray(snapshot))) {
    return {
      ok: false,
      error: errorResponse("invalid_snapshot", "Project snapshot must be an object or null.")
    };
  }

  const snapshotJson = JSON.stringify(snapshot);
  const snapshotBytes = snapshotJson ? Buffer.byteLength(snapshotJson, "utf8") : 0;
  if (!snapshotJson || snapshotBytes > MAX_PROJECT_SNAPSHOT_BYTES) {
    return {
      ok: false,
      error: errorResponse(
        "invalid_snapshot",
        `Project snapshot is too large (${formatBytes(snapshotBytes)}). Maximum is ${formatBytes(MAX_PROJECT_SNAPSHOT_BYTES)}.`
      )
    };
  }

  const name = input.name;
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_PROJECT_NAME_LENGTH) {
      return {
        ok: false,
        error: errorResponse("invalid_name", "Project name must be a non-empty string up to 120 characters.")
      };
    }

    return {
      ok: true,
      value: {
        name: name.trim(),
        snapshotJson
      }
    };
  }

  return {
    ok: true,
    value: {
      snapshotJson
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMainModule(): boolean {
  const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  return entryUrl === import.meta.url;
}

if (isMainModule()) {
  const server = serve(
    {
      fetch: app.fetch,
      hostname: serverConfig.host,
      port: serverConfig.port
    },
    (info) => {
      console.log(`API listening at http://${info.address}:${info.port}`);
    }
  );

  const shutdown = (): void => {
    closeDatabase();
    server.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
