import type { ApiConfig, ImageQuality, ImageSize, OutputFormat, ReferenceImageInput } from "./contracts.js";
import { toFile } from "openai";
import type { Image, ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import { IMAGE_MODEL } from "./contracts.js";

export interface ImageProviderInput {
  originalPrompt: string;
  presetId: string;
  prompt: string;
  size: ImageSize;
  sizeApiValue: string;
  quality: ImageQuality;
  outputFormat: OutputFormat;
  count: number;
}

export interface EditImageProviderInput extends ImageProviderInput {
  referenceImage: ReferenceImageInput;
  referenceAssetId?: string;
}

export interface ProviderImage {
  b64Json: string;
}

export interface ProviderResult {
  model: string;
  size: string;
  images: ProviderImage[];
}

export interface ImageProvider {
  generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult>;
  edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult>;
}

export type ProviderErrorCode = "missing_api_key" | "unsupported_provider_behavior" | "upstream_failure";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface OpenAIImageProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_BYTES = 100 * 1024 * 1024;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

type FlexibleImageGenerateParams = Omit<ImageGenerateParamsNonStreaming, "size"> & {
  size: string;
};

type FlexibleImageEditParams = Omit<ImageEditParamsNonStreaming, "size"> & {
  size: string;
};

export function getOpenAIImageProviderConfig(apiConfig?: ApiConfig):
  | {
      ok: true;
      config: OpenAIImageProviderConfig;
    }
  | {
      ok: false;
      error: ProviderError;
    } {
  const apiKey = apiConfig?.apiKey?.trim();
  if (!apiKey) {
    return {
      ok: false,
      error: new ProviderError("missing_api_key", "请在 AI 面板右上角的「API 设置」中配置你自己的 API Key。", 400)
    };
  }

  const baseURL = apiConfig?.baseURL?.trim();
  if (!baseURL) {
    return {
      ok: false,
      error: new ProviderError("missing_api_key", "请在 AI 面板右上角的「API 设置」中配置 Base URL。", 400)
    };
  }

  return {
    ok: true,
    config: {
      apiKey,
      baseURL,
      model: getConfiguredImageModel(),
      timeoutMs: parsePositiveInteger(process.env.OPENAI_IMAGE_TIMEOUT_MS, DEFAULT_OPENAI_IMAGE_TIMEOUT_MS)
    }
  };
}

export function getConfiguredImageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || IMAGE_MODEL;
}

export function createOpenAIImageProvider(config: OpenAIImageProviderConfig): ImageProvider {
  return new OpenAIImageProvider(config);
}

class OpenAIImageProvider implements ImageProvider {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: OpenAIImageProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL || "https://api.openai.com/v1";
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
  }

  async generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    try {
      const response = await fetchWithRetry(
        `${this.baseURL}/images/generations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: this.model,
            prompt: input.prompt,
            size: input.sizeApiValue,
            quality: input.quality,
            output_format: input.outputFormat,
            n: input.count
          }),
          signal
        },
        this.timeoutMs
      );

      const data = (await response.json()) as ImagesResponse;
      return await normalizeProviderResponse(data, input.sizeApiValue, this.model, signal);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    try {
      const reference = await dataUrlToFile(input.referenceImage);
      const formData = new FormData();
      formData.append("model", this.model);
      formData.append("image", reference);
      formData.append("prompt", input.prompt);
      formData.append("size", input.sizeApiValue);
      formData.append("quality", input.quality);
      formData.append("output_format", input.outputFormat);
      formData.append("n", String(input.count));

      const response = await fetchWithRetry(
        `${this.baseURL}/images/generations`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`
          },
          body: formData,
          signal
        },
        this.timeoutMs
      );

      const data = (await response.json()) as ImagesResponse;
      return await normalizeProviderResponse(data, input.sizeApiValue, this.model, signal);
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

async function fetchWithRetry(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`HTTP ${response.status}: ${text}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toProviderError(error: unknown): Error {
  if (isAbortError(error)) {
    return error;
  }

  if (error instanceof ProviderError) {
    return error;
  }

  const errorWithStatus = error as { status?: number; message?: string; code?: string };
  const status = errorWithStatus.status;
  const message = errorWithStatus.message || String(error);

  if (status === 524) {
    return new ProviderError(
      "upstream_failure",
      "上游图像服务响应超时（Cloudflare 524），请稍后重试或降低分辨率。",
      504
    );
  }

  if (status === 504) {
    return new ProviderError(
      "upstream_failure",
      "OpenAI 图像服务请求超时，请稍后重试或降低分辨率。",
      504
    );
  }

  if (status === 403) {
    return new ProviderError(
      "upstream_failure",
      `OpenAI 图像服务请求被拒绝（403）。请检查 API Key 和中转服务是否支持图片生成。`,
      403
    );
  }

  if (status && status >= 400 && status < 600) {
    return new ProviderError("upstream_failure", message, providerHttpStatus(status));
  }

  if (errorWithStatus.code === "UND_ERR_SOCKET" || message.includes("socket")) {
    return new ProviderError("upstream_failure", "网络连接异常，请稍后重试。", 502);
  }

  return new ProviderError("upstream_failure", message, 502);
}

function providerHttpStatus(status: number | undefined): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortError(error: unknown): error is Error {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function normalizeProviderResponse(
  response: ImagesResponse,
  sizeApiValue: string,
  model: string,
  signal?: AbortSignal
): Promise<ProviderResult> {
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务没有返回图像结果。", 502);
  }

  const images = await Promise.all(response.data.map((item) => providerImageFromResponseItem(item, signal)));

  if (images.some((image) => !image.b64Json)) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务没有返回 base64 图像数据。", 502);
  }

  return {
    model,
    size: sizeApiValue,
    images
  };
}

async function providerImageFromResponseItem(item: Image, signal?: AbortSignal): Promise<ProviderImage> {
  if (typeof item.b64_json === "string" && item.b64_json) {
    return {
      b64Json: item.b64_json
    };
  }

  if (typeof item.url === "string" && item.url) {
    return {
      b64Json: await downloadProviderImageUrl(item.url, signal)
    };
  }

  return {
    b64Json: ""
  };
}

async function downloadProviderImageUrl(url: string, signal?: AbortSignal): Promise<string> {
  const parsedUrl = parseProviderImageUrl(url);
  if (!parsedUrl) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务返回的图片 URL 不受支持。", 502);
  }

  if (parsedUrl.protocol === "data:") {
    return dataUrlToBase64(url);
  }

  const response = await fetch(parsedUrl, { signal });
  if (!response.ok) {
    throw new ProviderError("upstream_failure", "OpenAI 图像 URL 下载失败。", providerHttpStatus(response.status));
  }

  if (!isProviderImageContentType(response.headers.get("content-type"))) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的内容不是图片。", 502);
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_PROVIDER_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的文件过大。", 502);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PROVIDER_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的文件过大。", 502);
  }
  if (!isProviderImageBytes(bytes)) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的内容不是可识别的图片。", 502);
  }

  return bytes.toString("base64");
}

function parseProviderImageUrl(url: string): URL | undefined {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:" || parsedUrl.protocol === "data:"
      ? parsedUrl
      : undefined;
  } catch {
    return undefined;
  }
}

function dataUrlToBase64(url: string): string {
  const match = /^data:image\/[^;,]+;base64,(.+)$/u.exec(url);
  if (!match) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务返回的 data URL 不受支持。", 502);
  }

  return match[1];
}

function isProviderImageContentType(value: string | null): boolean {
  if (!value) {
    return true;
  }

  const contentType = value.split(";")[0]?.trim().toLowerCase();
  return Boolean(contentType?.startsWith("image/") || contentType === "application/octet-stream");
}

function isProviderImageBytes(bytes: Buffer): boolean {
  return isPng(bytes) || isJpeg(bytes) || isWebp(bytes);
}

function isPng(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
}

function isWebp(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function dataUrlToFile(input: ReferenceImageInput): Promise<File> {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(input.dataUrl);
  if (!match) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像格式不受支持。", 400);
  }

  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType)) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像必须是 PNG、JPEG 或 WebP 格式。", 400);
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像不能超过 50MB。", 400);
  }

  const normalizedMimeType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  const extension = normalizedMimeType === "image/jpeg" ? "jpg" : normalizedMimeType.split("/")[1] || "png";
  const fileName = sanitizeFileName(input.fileName) ?? `reference.${extension}`;
  return toFile(bytes, fileName, { type: normalizedMimeType });
}

function sanitizeFileName(fileName: string | undefined): string | undefined {
  const trimmed = fileName?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]/gu, "_");
}
