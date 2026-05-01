import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  Download,
  ImageIcon,
  Loader2,
  MapPin,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  X,
  XCircle
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Tldraw,
  type Editor,
  type TLAsset,
  type TLAssetContext,
  type TLAssetId,
  type TLAssetStore,
  type TLEditorSnapshot,
  type TLImageShape,
  type TLShapePartial,
  type TLShapeId,
  type TLStoreSnapshot,
  type TLComponents,
  type TldrawOptions
} from "tldraw";
import {
  GENERATION_PLACEHOLDER_TYPE,
  GenerationPlaceholderShapeUtil,
  type GenerationPlaceholderShape
} from "./GenerationPlaceholderShape";
import {
  CUSTOM_SIZE_PRESET_ID,
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
  OUTPUT_FORMATS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  composePrompt,
  validateImageSize,
  type ApiProvider,
  type GalleryImageItem,
  type GenerationCount,
  type GenerationRecord,
  type GenerationResponse,
  type GenerationStatus,
  type GeneratedAsset,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type ProjectState,
  type ReferenceImageInput,
  type SizePreset,
  type StylePresetId,
  type StorageConfigResponse,
  type SaveStorageConfigRequest,
  type StorageTestResult
} from "@gpt-image-canvas/shared";
import {
  blobToDataUrl,
  clearAllLocalAssets,
  dataUrlToBlob,
  deleteLocalAsset,
  getLocalAsset,
  listLocalAssets,
  saveLocalAsset,
  type LocalAssetRecord
} from "./local-storage";

const AUTOSAVE_DEBOUNCE_MS = 1200;
const HISTORY_COLLAPSED_LIMIT = 3;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MOBILE_DRAWER_MEDIA_QUERY = "(max-width: 1023px)";
const ASSET_PREVIEW_WIDTHS = [256, 512, 1024, 2048] as const;
type AssetPreviewWidth = (typeof ASSET_PREVIEW_WIDTHS)[number];
const GENERATED_ASSET_INITIAL_PREVIEW_WIDTH: AssetPreviewWidth = 2048;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const initialCanvasPreviewWidths = new Map<string, AssetPreviewWidth>();
const shapeUtils = [GenerationPlaceholderShapeUtil];
const tldrawOptions = {
  debouncedZoomThreshold: 80
} satisfies Partial<TldrawOptions>;
const tldrawComponents = {
  StylePanel: null
} satisfies TLComponents;
const TLDRAW_LICENSE_KEY =
  "tldraw-2026-08-08/WyJ3dGU4bldjRyIsWyIqIl0sMTYsIjIwMjYtMDgtMDgiXQ.Xt7lTydUhMnKfHfp+g8Mrs9gtJjlB8uPyYMniFEfRfruCYdYEl9J0uZl0lMAf6o7GdDB1zXOVhWLFAipssI6Cw";

const defaultStorageConfigForm: StorageConfigFormState = {
  enabled: false,
  secretId: "",
  secretKey: "",
  bucket: "source-1253253332",
  region: "ap-nanjing",
  keyPrefix: "gpt-image-canvas/assets"
};

const canvasAssetStore: TLAssetStore = {
  async upload(_asset, file) {
    return {
      src: await blobToDataUrl(file)
    };
  },
  resolve(asset, context) {
    return resolveCanvasAssetUrl(asset, context);
  }
};

const promptStarters = [
  {
    label: "产品海报",
    prompt: "一张高端护肤品产品海报，水面反光，精致布光，留出清晰标题空间"
  },
  {
    label: "室内空间",
    prompt: "一间安静的现代工作室，清晨自然光，木质家具，干净构图"
  },
  {
    label: "角色头像",
    prompt: "一个原创角色头像，温暖表情，清爽背景，细腻插画质感"
  },
  {
    label: "城市夜景",
    prompt: "未来城市夜景，雨后街道，霓虹倒影，电影感光影"
  }
] as const;
const quickSizePresetIds = new Set(["square-1k", "poster-portrait", "poster-landscape", "story-9-16", "video-16-9", "wide-2k"]);
const quickSizePresets = SIZE_PRESETS.filter((preset) => quickSizePresetIds.has(preset.id));

type GalleryPageModule = { default: typeof import("./GalleryPage").GalleryPage };
let galleryPageModulePromise: Promise<GalleryPageModule> | undefined;

function loadGalleryPageModule(): Promise<GalleryPageModule> {
  galleryPageModulePromise ??= import("./GalleryPage").then((module) => ({ default: module.GalleryPage }));
  return galleryPageModulePromise;
}

const LazyGalleryPage = lazy(loadGalleryPageModule);

function preloadGalleryPage(): void {
  void loadGalleryPageModule();
}

type PersistedSnapshot = TLEditorSnapshot | TLStoreSnapshot;
type AppRoute = "canvas" | "gallery";
type SaveStatus = "loading" | "saved" | "pending" | "saving" | "error";
type GenerationMode = "text" | "reference";
type PanelStatusTone = "progress" | "success" | "warning" | "error";

interface PanelStatus {
  tone: PanelStatusTone;
  message: string;
  testId: "generation-progress" | "generation-message" | "generation-warning" | "validation-message" | "generation-error";
}

interface GenerationSubmitInput {
  prompt: string;
  presetId: StylePresetId;
  sizePresetId: string;
  size: {
    width: number;
    height: number;
  };
  quality: ImageQuality;
  outputFormat: OutputFormat;
  count: GenerationCount;
}

interface GenerationReferenceInput {
  referenceImage: ReferenceImageInput;
  referenceAssetId?: string;
}

interface GenerationPlaceholderPlacement {
  id: TLShapeId;
  x: number;
  y: number;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
}

interface ActiveGenerationPlaceholders {
  requestId: number;
  placements: GenerationPlaceholderPlacement[];
}

interface ActiveGenerationTask {
  requestId: number;
  temporaryRecordId: string;
  controller: AbortController;
  placeholderSet: ActiveGenerationPlaceholders;
}

interface StorageConfigFormState {
  enabled: boolean;
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  keyPrefix: string;
}

type ReferenceSelection =
  | {
      status: "none" | "multiple" | "non-image" | "unreadable";
      hint: string;
    }
  | {
      status: "ready";
      assetId: TLAssetId | null;
      localAssetId?: string;
      name: string;
      sourceUrl: string;
      width: number;
      height: number;
      hint: string;
    };

const missingReferenceSelection: ReferenceSelection = {
  status: "none",
  hint: "选择画布中的一张图片后，可用它作为参考生成到画布。"
};

const qualityLabels: Record<ImageQuality, string> = {
  auto: "自动",
  low: "快速草稿",
  medium: "标准",
  high: "高质量"
};

const formatLabels: Record<OutputFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP"
};

const stylePresetLabels: Record<StylePresetId, string> = {
  none: "无风格",
  photoreal: "真实摄影",
  product: "商业产品",
  illustration: "精致插画",
  poster: "海报视觉",
  avatar: "头像角色"
};

const sizePresetLabels: Record<string, string> = {
  "square-1k": "方形成图 1K",
  "poster-portrait": "竖版海报",
  "poster-landscape": "横版海报",
  "story-9-16": "竖屏故事",
  "video-16-9": "视频封面",
  "wide-2k": "宽屏展示 2K",
  "portrait-2k": "高清竖图 2K",
  "square-2k": "高清方图 2K",
  "wide-4k": "宽屏展示 4K"
};

const modeLabels: Record<GenerationRecord["mode"], string> = {
  generate: "提示词到画布",
  edit: "参考图到画布"
};

const statusLabels: Record<GenerationStatus, string> = {
  pending: "等待中",
  running: "生成中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消"
};

const panelStatusStyles: Record<PanelStatusTone, string> = {
  progress: "panel-status--progress",
  success: "panel-status--success",
  warning: "panel-status--warning",
  error: "panel-status--error"
};

const historyStatusStyles: Record<GenerationStatus, string> = {
  pending: "history-status--pending",
  running: "history-status--running",
  succeeded: "history-status--succeeded",
  partial: "history-status--partial",
  failed: "history-status--failed",
  cancelled: "history-status--cancelled"
};

function sizePresetLabel(preset: SizePreset): string {
  return sizePresetLabels[preset.id] ?? preset.label;
}

function sizePresetOptionLabel(preset: SizePreset): string {
  return `${sizePresetLabel(preset)} - ${preset.width} x ${preset.height}`;
}

function normalizeDimension(value: string): number {
  return Number.parseInt(value, 10);
}

function sizeValidationMessage(width: number, height: number): string {
  const result = validateImageSize({ width, height });

  if (result.ok) {
    return "";
  }

  return result.message;
}

function generationValidationMessage(promptValue: string, widthValue: number, heightValue: number): string {
  return promptValue.trim() ? sizeValidationMessage(widthValue, heightValue) : "请输入提示词。";
}

const PROJECT_SNAPSHOT_KEY = "gpt-image-canvas-project";
const GENERATION_HISTORY_KEY = "gpt-image-canvas-history";
const BASE_URL = import.meta.env.BASE_URL;

function routeFromLocation(): AppRoute {
  return window.location.pathname.endsWith("/gallery") ? "gallery" : "canvas";
}

function pathForRoute(route: AppRoute): string {
  return route === "gallery" ? `${BASE_URL}gallery` : BASE_URL;
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGenerationResponse(value: unknown): value is GenerationResponse {
  return typeof value === "object" && value !== null && "record" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoadingGenerationPlaceholderRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.typeName === "shape" &&
    value.type === GENERATION_PLACEHOLDER_TYPE &&
    isRecord(value.props) &&
    value.props.status === "loading"
  );
}

function filterLoadingPlaceholdersFromStoreSnapshot<TSnapshot>(snapshot: TSnapshot): TSnapshot {
  if (!isRecord(snapshot) || !isRecord(snapshot.store)) {
    return snapshot;
  }

  let removed = false;
  const nextStore: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(snapshot.store)) {
    if (isLoadingGenerationPlaceholderRecord(record)) {
      removed = true;
      continue;
    }

    nextStore[id] = record;
  }

  return removed ? ({ ...snapshot, store: nextStore } as TSnapshot) : snapshot;
}

function filterLoadingPlaceholdersFromSnapshot<TSnapshot>(snapshot: TSnapshot): TSnapshot {
  if (!isRecord(snapshot)) {
    return snapshot;
  }

  if (isRecord(snapshot.document)) {
    const document = filterLoadingPlaceholdersFromStoreSnapshot(snapshot.document);
    return document === snapshot.document ? snapshot : ({ ...snapshot, document } as TSnapshot);
  }

  return filterLoadingPlaceholdersFromStoreSnapshot(snapshot);
}

function coerceStylePresetId(value: string): StylePresetId {
  return STYLE_PRESETS.some((preset) => preset.id === value) ? (value as StylePresetId) : "none";
}

function coerceGenerationCount(value: number): GenerationCount {
  return GENERATION_COUNTS.includes(value as GenerationCount) ? (value as GenerationCount) : 1;
}

function sizePresetIdForSize(widthValue: number, heightValue: number): string {
  return (
    SIZE_PRESETS.find((preset) => preset.width === widthValue && preset.height === heightValue)?.id ?? CUSTOM_SIZE_PRESET_ID
  );
}

function firstDownloadableAsset(record: GenerationRecord): GeneratedAsset | undefined {
  return record.outputs.find((output) => output.status === "succeeded" && output.asset)?.asset;
}

function successfulOutputCount(record: GenerationRecord): number {
  return record.outputs.filter((output) => output.status === "succeeded" && output.asset).length;
}

function cloudFailureCount(record: GenerationRecord): number {
  return record.outputs.filter((output) => output.asset?.cloud?.status === "failed").length;
}

function firstCloudFailureMessage(record: GenerationRecord): string | undefined {
  return record.outputs.find((output) => output.asset?.cloud?.status === "failed")?.asset?.cloud?.lastError;
}

function generationModeToRecordMode(mode: GenerationMode): GenerationRecord["mode"] {
  return mode === "reference" ? "edit" : "generate";
}

function createTemporaryGenerationRecord(input: {
  requestId: number;
  submitInput: GenerationSubmitInput;
  requestMode: GenerationMode;
  referenceAssetId?: string;
}): GenerationRecord {
  const promptValue = input.submitInput.prompt.trim();

  return {
    id: `local-generation-${input.requestId}`,
    mode: generationModeToRecordMode(input.requestMode),
    prompt: promptValue,
    effectivePrompt: promptValue,
    presetId: input.submitInput.presetId,
    size: input.submitInput.size,
    quality: input.submitInput.quality,
    outputFormat: input.submitInput.outputFormat,
    count: input.submitInput.count,
    status: "running",
    referenceAssetId: input.referenceAssetId,
    createdAt: new Date().toISOString(),
    outputs: []
  };
}

function promptExcerpt(promptValue: string): string {
  const compact = promptValue.replace(/\s+/gu, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}...` : compact;
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.readOnly = true;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.append(textArea);
  textArea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command was not accepted.");
    }
  } finally {
    textArea.remove();
  }
}

function formatCreatedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function createTldrawAssetId(assetId: string): TLAssetId {
  return `asset:${assetId}` as TLAssetId;
}

function createTldrawShapeId(): TLShapeId {
  return `shape:${crypto.randomUUID()}` as TLShapeId;
}

function displaySize(size: ImageSize): { width: number; height: number } {
  const scale = Math.min(1, 340 / size.width, 300 / size.height);
  return {
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale)
  };
}

function createCenteredPlacements(editor: Editor, countValue: GenerationCount, size: ImageSize): GenerationPlaceholderPlacement[] {
  const placeholderSize = displaySize(size);
  const columns = countValue === 1 ? 1 : 2;
  const rows = Math.ceil(countValue / columns);
  const gap = 48;
  const cellWidth = placeholderSize.width;
  const cellHeight = placeholderSize.height;
  const gridWidth = columns * cellWidth + (columns - 1) * gap;
  const gridHeight = rows * cellHeight + (rows - 1) * gap;
  const viewport = editor.getViewportPageBounds();
  const originX = viewport.center.x - gridWidth / 2;
  const originY = viewport.center.y - gridHeight / 2;

  return Array.from({ length: countValue }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);

    return {
      id: createTldrawShapeId(),
      x: originX + column * (cellWidth + gap),
      y: originY + row * (cellHeight + gap),
      width: placeholderSize.width,
      height: placeholderSize.height,
      targetWidth: size.width,
      targetHeight: size.height
    };
  });
}

function createGenerationPlaceholders(
  editor: Editor,
  input: GenerationSubmitInput,
  requestId: number,
  options: { selectPlaceholders?: boolean } = {}
): ActiveGenerationPlaceholders {
  const placements = createCenteredPlacements(editor, input.count, input.size);
  const placeholderIds = placements.map((placement) => placement.id);

  editor.createShapes<GenerationPlaceholderShape>(
    placements.map((placement, index) => ({
      id: placement.id,
      type: GENERATION_PLACEHOLDER_TYPE,
      x: placement.x,
      y: placement.y,
      props: {
        w: placement.width,
        h: placement.height,
        targetWidth: placement.targetWidth,
        targetHeight: placement.targetHeight,
        status: "loading",
        error: "",
        requestId: String(requestId),
        outputIndex: index
      }
    }))
  );
  editor.bringToFront(placeholderIds);
  if (options.selectPlaceholders ?? true) {
    editor.select(...placeholderIds);
  }

  return {
    requestId,
    placements
  };
}

function isGenerationPlaceholderShape(shape: unknown): shape is GenerationPlaceholderShape {
  return isRecord(shape) && shape.type === GENERATION_PLACEHOLDER_TYPE;
}

function livePlacement(editor: Editor, placement: GenerationPlaceholderPlacement): GenerationPlaceholderPlacement {
  const shape = editor.getShape(placement.id);
  if (!isGenerationPlaceholderShape(shape)) {
    return placement;
  }

  return {
    ...placement,
    x: shape.x,
    y: shape.y,
    width: shape.props.w,
    height: shape.props.h
  };
}

function createImageAsset(asset: GeneratedAsset): TLAsset {
  initialCanvasPreviewWidths.set(asset.id, GENERATED_ASSET_INITIAL_PREVIEW_WIDTH);

  return {
    id: createTldrawAssetId(asset.id),
    typeName: "asset",
    type: "image",
    props: {
      src: asset.url,
      w: asset.width,
      h: asset.height,
      name: asset.fileName,
      mimeType: asset.mimeType,
      isAnimated: false
    },
    meta: {
      localAssetId: asset.id
    }
  };
}

function createImageShape(
  asset: GeneratedAsset,
  placement: GenerationPlaceholderPlacement,
  promptValue: string
): Partial<TLImageShape> & { id: TLShapeId; type: "image" } {
  const assetId = createTldrawAssetId(asset.id);

  return {
    id: createTldrawShapeId(),
    type: "image",
    x: placement.x,
    y: placement.y,
    props: {
      assetId,
      w: placement.width,
      h: placement.height,
      url: "",
      playing: true,
      crop: null,
      flipX: false,
      flipY: false,
      altText: promptValue
    }
  };
}

function replaceGenerationPlaceholders(editor: Editor, placeholderSet: ActiveGenerationPlaceholders, record: GenerationRecord): number {
  const assets: TLAsset[] = [];
  const imageShapes: Array<Partial<TLImageShape> & { id: TLShapeId; type: "image" }> = [];
  const replacedPlaceholderIds: TLShapeId[] = [];
  const failedUpdates: Array<TLShapePartial<GenerationPlaceholderShape>> = [];

  placeholderSet.placements.forEach((placement, index) => {
    const output = record.outputs[index];
    if (output?.status === "succeeded" && output.asset) {
      const resolvedPlacement = livePlacement(editor, placement);
      assets.push(createImageAsset(output.asset));
      imageShapes.push(createImageShape(output.asset, resolvedPlacement, record.prompt));
      if (isGenerationPlaceholderShape(editor.getShape(placement.id))) {
        replacedPlaceholderIds.push(placement.id);
      }
      return;
    }

    if (isGenerationPlaceholderShape(editor.getShape(placement.id))) {
      failedUpdates.push({
        id: placement.id,
        type: GENERATION_PLACEHOLDER_TYPE,
        props: {
          status: "failed",
          error: output?.error || record.error || "生成到画布失败。"
        }
      });
    }
  });

  editor.run(() => {
    if (replacedPlaceholderIds.length > 0) {
      editor.deleteShapes(replacedPlaceholderIds);
    }
    if (assets.length > 0) {
      editor.createAssets(assets);
    }
    if (imageShapes.length > 0) {
      editor.createShapes(imageShapes);
    }
    if (failedUpdates.length > 0) {
      editor.updateShapes<GenerationPlaceholderShape>(failedUpdates);
    }
  });

  if (imageShapes.length > 0) {
    editor.select(...imageShapes.map((shape) => shape.id));
  }

  return imageShapes.length;
}

function generatedAssetsForRecord(record: GenerationRecord): GeneratedAsset[] {
  return record.outputs.flatMap((output) => (output.status === "succeeded" && output.asset ? [output.asset] : []));
}

async function preloadGenerationRecordPreviews(record: GenerationRecord, signal: AbortSignal): Promise<void> {
  await Promise.all(generatedAssetsForRecord(record).map((asset) => preloadGeneratedAssetPreview(asset, signal)));
}

async function preloadGeneratedAssetPreview(asset: GeneratedAsset, signal: AbortSignal): Promise<void> {
  try {
    await preloadImageUrl(assetPreviewUrl(asset.id, GENERATED_ASSET_INITIAL_PREVIEW_WIDTH), signal);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
  }
}

function preloadImageUrl(url: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Image preload was aborted.", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";

    function cleanup(): void {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    }
    function complete(): void {
      cleanup();
      resolve();
    }
    function fail(): void {
      cleanup();
      reject(new Error(`Image preload failed for ${url}`));
    }
    function abort(): void {
      cleanup();
      image.src = "";
      reject(new DOMException("Image preload was aborted.", "AbortError"));
    }

    image.onload = complete;
    image.onerror = fail;
    signal.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}

function markGenerationPlaceholdersFailed(editor: Editor, placeholderSet: ActiveGenerationPlaceholders, error: string): void {
  const updates = placeholderSet.placements.flatMap((placement) => {
    const shape = editor.getShape(placement.id);
    if (!isGenerationPlaceholderShape(shape) || shape.props.status !== "loading") {
      return [];
    }

    return [
      {
        id: placement.id,
        type: GENERATION_PLACEHOLDER_TYPE,
        props: {
          status: "failed",
          error
        }
      } satisfies TLShapePartial<GenerationPlaceholderShape>
    ];
  });

  if (updates.length > 0) {
    editor.updateShapes<GenerationPlaceholderShape>(updates);
  }
}

function deleteLoadingGenerationPlaceholders(editor: Editor, placeholderSet: ActiveGenerationPlaceholders): void {
  const loadingPlaceholderIds = placeholderSet.placements.flatMap((placement) => {
    const shape = editor.getShape(placement.id);
    return isGenerationPlaceholderShape(shape) && shape.props.status === "loading" ? [placement.id] : [];
  });

  if (loadingPlaceholderIds.length > 0) {
    editor.deleteShapes(loadingPlaceholderIds);
  }
}

function firstLiveGenerationPlaceholder(editor: Editor, placeholderSet: ActiveGenerationPlaceholders): TLShapeId | undefined {
  return placeholderSet.placements.find((placement) => isGenerationPlaceholderShape(editor.getShape(placement.id)))?.id;
}

function resolveReferenceSelection(editor: Editor): ReferenceSelection {
  const selectedShapes = editor.getSelectedShapes();

  if (selectedShapes.length === 0) {
    return missingReferenceSelection;
  }

  if (selectedShapes.length > 1) {
    return {
      status: "multiple",
      hint: "当前选择了多个对象。只选择一张图片即可启用参考图到画布。"
    };
  }

  const shape = selectedShapes[0];
  if (shape.type !== "image") {
    return {
      status: "non-image",
      hint: "当前对象不是图片。请选择画布中的单张图片作为参考。"
    };
  }

  const imageShape = shape as TLImageShape;
  const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
  const sourceUrl = getImageSourceUrl(imageShape, asset);

  if (!sourceUrl) {
    return {
      status: "unreadable",
      hint: "这张图片缺少可读取的数据源，无法作为参考图。"
    };
  }

  if (!isReadableReferenceSource(sourceUrl, asset)) {
    return {
      status: "unreadable",
      hint: "这张图片当前无法被浏览器读取，请选择本地生成或已导入的 PNG、JPEG、WebP 图片。"
    };
  }

  return {
    status: "ready",
    assetId: imageShape.props.assetId,
    localAssetId: getLocalAssetId(asset, sourceUrl),
    name: getReferenceName(asset, sourceUrl),
    sourceUrl,
    width: asset?.type === "image" ? asset.props.w : imageShape.props.w,
    height: asset?.type === "image" ? asset.props.h : imageShape.props.h,
    hint: "已选中一张图片，将使用它作为本次参考图。"
  };
}

function areReferenceSelectionsEqual(left: ReferenceSelection, right: ReferenceSelection): boolean {
  if (left.status !== right.status) {
    return false;
  }

  if (left.status !== "ready" || right.status !== "ready") {
    return left.hint === right.hint;
  }

  return (
    left.assetId === right.assetId &&
    left.localAssetId === right.localAssetId &&
    left.name === right.name &&
    left.sourceUrl === right.sourceUrl &&
    left.width === right.width &&
    left.height === right.height &&
    left.hint === right.hint
  );
}

function getImageSourceUrl(shape: TLImageShape, asset: TLAsset | undefined): string | undefined {
  const assetSrc = asset?.type === "image" && typeof asset.props.src === "string" ? asset.props.src : undefined;
  return assetSrc || shape.props.url || undefined;
}

function getAssetMimeType(asset: TLAsset | undefined): string | undefined {
  return asset?.type === "image" && typeof asset.props.mimeType === "string" ? asset.props.mimeType : undefined;
}

function isReadableReferenceSource(sourceUrl: string, asset: TLAsset | undefined): boolean {
  const assetMimeType = getAssetMimeType(asset);
  if (assetMimeType && !isSupportedReferenceImageType(assetMimeType)) {
    return false;
  }

  if (sourceUrl.startsWith("data:")) {
    const mimeType = /^data:([^;,]+)/iu.exec(sourceUrl)?.[1];
    return Boolean(mimeType && isSupportedReferenceImageType(mimeType));
  }

  if (sourceUrl.startsWith("blob:")) {
    return true;
  }

  try {
    return new URL(sourceUrl, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function getReferenceName(asset: TLAsset | undefined, sourceUrl: string): string {
  if (asset?.type === "image" && asset.props.name) {
    return asset.props.name;
  }

  try {
    const pathname = new URL(sourceUrl, window.location.origin).pathname;
    return pathname.split("/").filter(Boolean).at(-1) || "reference-image";
  } catch {
    return "reference-image";
  }
}

function getLocalAssetId(asset: TLAsset | undefined, sourceUrl?: string): string | undefined {
  const localAssetId = asset?.meta && typeof asset.meta.localAssetId === "string" ? asset.meta.localAssetId : undefined;
  if (localAssetId) {
    return localAssetId;
  }

  if (!sourceUrl) {
    return undefined;
  }

  try {
    const url = new URL(sourceUrl, window.location.origin);
    if (url.origin === window.location.origin) {
      const basePath = BASE_URL.replace(/\/$/u, "");
      const match = new RegExp(`^(?:${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?/api/assets/([^/?#]+)(?:/download)?$`, 'u').exec(url.pathname);
      return match?.[1];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveCanvasAssetUrl(asset: TLAsset, context: TLAssetContext): string | null {
  if (asset.type !== "image") {
    return "src" in asset.props && typeof asset.props.src === "string" ? asset.props.src : null;
  }

  const sourceUrl = asset.props.src;
  if (!sourceUrl || context.shouldResolveToOriginal) {
    return sourceUrl || null;
  }

  if (sourceUrl.startsWith("http")) {
    return sourceUrl;
  }

  if (sourceUrl.startsWith("data:")) {
    return sourceUrl;
  }

  const localAssetId = getLocalAssetId(asset, sourceUrl);
  if (!localAssetId) {
    return sourceUrl;
  }

  const previewWidth = Math.max(
    previewWidthForAssetContext(asset, context),
    initialCanvasPreviewWidths.get(localAssetId) ?? ASSET_PREVIEW_WIDTHS[0]
  );
  return assetPreviewUrl(localAssetId, previewWidth);
}

function assetPreviewUrl(assetId: string, width: number): string {
  return `${BASE_URL}api/assets/${encodeURIComponent(assetId)}/preview?width=${width}`;
}

function previewWidthForAssetContext(asset: Extract<TLAsset, { type: "image" }>, context: TLAssetContext): AssetPreviewWidth {
  const dpr = Number.isFinite(context.dpr) && context.dpr > 0 ? context.dpr : window.devicePixelRatio || 1;
  const requestedWidth = Math.max(1, Math.ceil(asset.props.w * context.screenScale * dpr));
  return ASSET_PREVIEW_WIDTHS.find((widthValue) => widthValue >= requestedWidth) ?? ASSET_PREVIEW_WIDTHS[ASSET_PREVIEW_WIDTHS.length - 1];
}

function findCanvasImageShape(editor: Editor, record: GenerationRecord): TLShapeId | undefined {
  const assetIds = new Set(
    record.outputs.flatMap((output) => (output.status === "succeeded" && output.asset ? [output.asset.id] : []))
  );
  if (assetIds.size === 0) {
    return undefined;
  }

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== "image") {
      continue;
    }

    const imageShape = shape as TLImageShape;
    const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
    const sourceUrl = getImageSourceUrl(imageShape, asset);
    const localAssetId = getLocalAssetId(asset, sourceUrl);

    if (localAssetId && assetIds.has(localAssetId)) {
      return imageShape.id;
    }
  }

  return undefined;
}

function fileNameWithImageExtension(name: string, mimeType: string): string {
  if (/\.(png|jpe?g|webp|gif)$/iu.test(name)) {
    return name;
  }

  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return `${name}.${extension}`;
}

function isSupportedReferenceImageType(mimeType: string): boolean {
  return SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType.toLowerCase());
}

async function referenceImageToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取参考图片数据。"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("无法读取参考图片数据。"));
    };
    reader.readAsDataURL(blob);
  });
}

async function readReferenceImage(selection: Extract<ReferenceSelection, { status: "ready" }>, signal: AbortSignal): Promise<{
  dataUrl: string;
  fileName: string;
}> {
  let response: Response;

  try {
    response = await fetch(selection.sourceUrl, { signal });
  } catch {
    throw new Error("无法读取当前参考图。请确认图片来自本地生成结果或浏览器可访问的图片数据。");
  }

  if (!response.ok) {
    throw new Error("无法读取当前参考图。请确认图片文件仍然存在。");
  }

  const blob = await response.blob();
  if (!isSupportedReferenceImageType(blob.type)) {
    throw new Error("当前参考资源不是可用的图片格式。");
  }
  if (blob.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("参考图像不能超过 50MB。");
  }

  return {
    dataUrl: await referenceImageToDataUrl(blob),
    fileName: fileNameWithImageExtension(selection.name, blob.type)
  };
}

async function readStoredReferenceImage(assetId: string, signal: AbortSignal): Promise<ReferenceImageInput> {
  const response = await fetch(`${BASE_URL}api/assets/${encodeURIComponent(assetId)}`, { signal });
  if (!response.ok) {
    throw new Error("无法读取历史参考图。请确认原始资源仍然存在。");
  }

  const blob = await response.blob();
  if (!isSupportedReferenceImageType(blob.type)) {
    throw new Error("历史参考资源不是可用的图片格式。");
  }
  if (blob.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("历史参考图像不能超过 50MB。");
  }

  return {
    dataUrl: await referenceImageToDataUrl(blob),
    fileName: fileNameWithImageExtension(assetId, blob.type)
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ? `${body.error.message}（HTTP ${response.status}）` : `生成请求失败，状态 ${response.status}。`;
  } catch {
    return `生成请求失败，状态 ${response.status}。`;
  }
}

function storageConfigToForm(config: StorageConfigResponse | null): StorageConfigFormState {
  if (!config) {
    return defaultStorageConfigForm;
  }

  return {
    enabled: config.enabled,
    secretId: config.cos.secretId,
    secretKey: config.cos.secretKey.value ?? "",
    bucket: config.cos.bucket,
    region: config.cos.region,
    keyPrefix: config.cos.keyPrefix
  };
}

function storageConfigRequestBody(
  form: StorageConfigFormState,
  options: { preserveSecret: boolean; forceEnabled?: boolean }
): SaveStorageConfigRequest {
  return {
    enabled: options.forceEnabled ?? form.enabled,
    provider: "cos",
    cos: {
      secretId: form.secretId.trim(),
      secretKey: options.preserveSecret ? undefined : form.secretKey,
      preserveSecret: options.preserveSecret,
      bucket: form.bucket.trim(),
      region: form.region.trim(),
      keyPrefix: form.keyPrefix.trim()
    }
  };
}

function requestGenerationNotificationPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "default") {
    return;
  }

  void Notification.requestPermission().catch(() => undefined);
}

function showGenerationCompleteNotification(record: GenerationRecord, insertedCount: number, failedCount: number): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const isPartial = record.status === "partial" || failedCount > 0;
  const body = isPartial
    ? `已向画布插入 ${insertedCount} 张图像，${failedCount} 张失败。`
    : `已向画布插入 ${insertedCount} 张图像。`;

  new Notification(isPartial ? "生成到画布部分完成" : "已生成到画布", {
    body,
    icon: "/favicon.svg",
    tag: `generation-${record.id}`
  });
}

function saveStatusLabel(status: SaveStatus): string {
  switch (status) {
    case "loading":
      return "正在载入";
    case "pending":
      return "待保存";
    case "saving":
      return "保存中";
    case "error":
      return "保存失败";
    case "saved":
    default:
      return "已保存";
  }
}

function SaveStatusIcon({ status }: { status: SaveStatus }) {
  if (status === "saving" || status === "loading") {
    return <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />;
  }

  if (status === "error") {
    return <AlertTriangle className="size-3.5" aria-hidden="true" />;
  }

  if (status === "saved") {
    return <CheckCircle2 className="size-3.5" aria-hidden="true" />;
  }

  return <Cloud className="size-3.5" aria-hidden="true" />;
}

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <span className="brand-mark__aperture" />
      <span className="brand-mark__spark" />
    </span>
  );
}

function BrandName() {
  return (
    <p className="brand-name" title="gpt-image-canvas">
      <span className="brand-name__prefix">gpt</span>
      <span className="brand-name__dash">-</span>
      <span className="brand-name__image">image</span>
      <span className="brand-name__dash">-</span>
      <span className="brand-name__canvas">canvas</span>
    </p>
  );
}

function TopNavigation({
  route,
  onNavigate,
  onPreloadGallery,
  onExport,
  onImport
}: {
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onPreloadGallery: () => void;
  onExport: () => void;
  onImport: () => void;
}) {
  return (
    <header className="top-navigation">
      <div className="top-navigation__inner">
        <div className="brand-lockup min-w-0">
          <BrandMark />
          <div className="min-w-0">
            <BrandName />
            <p className="brand-tagline">本地 AI 图像画布</p>
          </div>
        </div>
        <nav aria-label="主要页面" className="top-navigation__links">
          <a
            aria-current={route === "canvas" ? "page" : undefined}
            className="top-navigation__link"
            data-active={route === "canvas"}
            data-testid="nav-canvas"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              onNavigate("canvas");
            }}
          >
            <Square className="size-4" aria-hidden="true" />
            画布
          </a>
          <a
            aria-current={route === "gallery" ? "page" : undefined}
            className="top-navigation__link"
            data-active={route === "gallery"}
            data-testid="nav-gallery"
            href="/gallery"
            onFocus={onPreloadGallery}
            onMouseEnter={onPreloadGallery}
            onClick={(event) => {
              event.preventDefault();
              onNavigate("gallery");
            }}
          >
            <ImageIcon className="size-4" aria-hidden="true" />
            Gallery
          </a>
        </nav>
        <div className="top-navigation__actions">
          <button
            className="top-navigation__action-btn"
            title="导出所有数据（包括画布、历史和图像）"
            type="button"
            onClick={onExport}
          >
            <Download className="size-4" aria-hidden="true" />
            <span className="sr-only">导出数据</span>
          </button>
          <button
            className="top-navigation__action-btn"
            title="导入备份数据"
            type="button"
            onClick={onImport}
          >
            <Upload className="size-4" aria-hidden="true" />
            <span className="sr-only">导入数据</span>
          </button>
        </div>
        <div className="local-storage-notice" title="所有数据（包括画布、生成历史和图像）都存储在浏览器本地。请定期导出备份。">
          <span className="local-storage-notice__icon">💾</span>
          <span className="local-storage-notice__text">数据存储在本地</span>
        </div>
      </div>
    </header>
  );
}

function PanelStatusIcon({ tone }: { tone: PanelStatusTone }) {
  if (tone === "progress") {
    return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />;
  }

  if (tone === "success") {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
  }

  if (tone === "warning") {
    return <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
  }

  return <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => routeFromLocation());
  const [generationMode, setGenerationMode] = useState<GenerationMode>("text");
  const [prompt, setPrompt] = useState("");
  const [stylePreset, setStylePreset] = useState<StylePresetId>("none");
  const [sizePresetId, setSizePresetId] = useState(SIZE_PRESETS[0].id);
  const [width, setWidth] = useState(SIZE_PRESETS[0].width);
  const [height, setHeight] = useState(SIZE_PRESETS[0].height);
  const [count, setCount] = useState<GenerationCount>(1);
  const [quality, setQuality] = useState<ImageQuality>("auto");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  const [activeGenerationCount, setActiveGenerationCount] = useState(0);
  const [isProjectLoaded, setIsProjectLoaded] = useState(false);
  const [projectSnapshot, setProjectSnapshot] = useState<PersistedSnapshot | undefined>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [saveError, setSaveError] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generationMessage, setGenerationMessage] = useState("");
  const [generationWarning, setGenerationWarning] = useState("");
  const [generationHistory, setGenerationHistory] = useState<GenerationRecord[]>([]);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [isMobileDrawer, setIsMobileDrawer] = useState(false);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [isStorageDialogOpen, setIsStorageDialogOpen] = useState(false);
  const [isApiDialogOpen, setIsApiDialogOpen] = useState(false);
  const [apiProviders, setApiProviders] = useState<ApiProvider[]>(() => {
    try {
      const saved = localStorage.getItem("api-providers");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
      const legacy = localStorage.getItem("api-config");
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (parsed.apiKey && parsed.baseURL) {
          return [{ id: crypto.randomUUID(), name: "默认供应商", apiKey: parsed.apiKey, baseURL: parsed.baseURL }];
        }
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem("api-selected-provider-id");
      if (saved) return saved;
    } catch {
      // ignore
    }
    return "";
  });
  const [apiSecretTouched, setApiSecretTouched] = useState(false);
  const [apiEditIndex, setApiEditIndex] = useState<number | null>(null);
  const [apiEditForm, setApiEditForm] = useState<{ name: string; apiKey: string; baseURL: string }>({ name: "", apiKey: "", baseURL: "" });
  const [storageConfig, setStorageConfig] = useState<StorageConfigResponse | null>(null);
  const [storageForm, setStorageForm] = useState<StorageConfigFormState>(defaultStorageConfigForm);
  const [storageSecretTouched, setStorageSecretTouched] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [isStorageSaving, setIsStorageSaving] = useState(false);
  const [isStorageTesting, setIsStorageTesting] = useState(false);
  const [referenceSelection, setReferenceSelection] = useState<ReferenceSelection>(missingReferenceSelection);
  const canvasShellRef = useRef<HTMLElement | null>(null);
  const panelCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const generationModeRef = useRef<GenerationMode>("text");
  const activeGenerationsRef = useRef<Map<number, ActiveGenerationTask>>(new Map());
  const generationRequestRef = useRef(0);
  const saveTimerRef = useRef<number | undefined>();
  const saveRequestRef = useRef(0);
  const isGenerating = activeGenerationCount > 0;

  const trimmedPrompt = prompt.trim();
  const promptValidationMessage = prompt.trim() ? "" : "请输入提示词。";
  const dimensionValidationMessage = sizeValidationMessage(width, height);
  const isReferenceMode = generationMode === "reference";
  const isReferenceReady = isReferenceMode && referenceSelection.status === "ready";
  const referenceValidationMessage = isReferenceMode && !isReferenceReady ? referenceSelection.hint : "";
  const providerValidationMessage = apiProviders.length === 0 ? "请先在 API 供应商设置中添加配置。" : (apiProviders.find((p) => p.id === selectedProviderId) ? "" : "请先在 API 供应商设置中选择要使用的供应商。");
  const validationMessage = promptValidationMessage || dimensionValidationMessage || referenceValidationMessage || providerValidationMessage;
  const shouldShowValidation = Boolean(validationMessage);
  const canGenerate = !validationMessage;

  const navigateToRoute = useCallback((nextRoute: AppRoute): void => {
    const nextPath = pathForRoute(nextRoute);
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }
    setRoute(nextRoute);
  }, []);

  const visibleHistory = useMemo(
    () => (isHistoryExpanded ? generationHistory : generationHistory.slice(0, HISTORY_COLLAPSED_LIMIT)),
    [generationHistory, isHistoryExpanded]
  );
  const hiddenHistoryCount = Math.max(0, generationHistory.length - HISTORY_COLLAPSED_LIMIT);
  const hasAdditionalHistory = hiddenHistoryCount > 0;
  const panelStatus = useMemo<PanelStatus | null>(() => {
    if (isGenerating) {
      return {
        tone: "progress",
        message: `当前 ${activeGenerationCount} 个任务正在生成到画布，可继续下发新任务。`,
        testId: "generation-progress"
      };
    }

    if (generationError) {
      return {
        tone: "error",
        message: generationError,
        testId: "generation-error"
      };
    }

    if (shouldShowValidation && validationMessage) {
      return {
        tone: "warning",
        message: validationMessage,
        testId: "validation-message"
      };
    }

    if (generationWarning) {
      return {
        tone: "warning",
        message: generationWarning,
        testId: "generation-warning"
      };
    }

    if (generationMessage) {
      return {
        tone: "success",
        message: generationMessage,
        testId: "generation-message"
      };
    }

    return null;
  }, [
    activeGenerationCount,
    generationError,
    generationMessage,
    generationWarning,
    isGenerating,
    shouldShowValidation,
    validationMessage
  ]);

  useEffect(() => {
    const updateRoute = (): void => {
      setRoute(routeFromLocation());
    };

    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const task of activeGenerationsRef.current.values()) {
        task.controller.abort();
      }
      activeGenerationsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    async function loadProject(): Promise<void> {
      setSaveStatus("loading");
      setSaveError("");

      try {
        const savedSnapshot = localStorage.getItem(PROJECT_SNAPSHOT_KEY);
        const savedHistory = localStorage.getItem(GENERATION_HISTORY_KEY);

        if (savedSnapshot) {
          const snapshot = filterLoadingPlaceholdersFromSnapshot(JSON.parse(savedSnapshot));
          if (isPersistedSnapshot(snapshot)) {
            setProjectSnapshot(snapshot);
          }
        }

        if (savedHistory) {
          setGenerationHistory(JSON.parse(savedHistory));
        }

        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
        setSaveError("无法载入已保存项目，将使用空白画布。");
      } finally {
        setIsProjectLoaded(true);
      }
    }

    void loadProject();
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_DRAWER_MEDIA_QUERY);
    const updateDrawerMode = (): void => {
      setIsMobileDrawer(mediaQuery.matches);
    };

    updateDrawerMode();
    mediaQuery.addEventListener("change", updateDrawerMode);

    return () => {
      mediaQuery.removeEventListener("change", updateDrawerMode);
    };
  }, []);

  const closeAiPanel = useCallback((): void => {
    setIsAiPanelOpen(false);
    window.requestAnimationFrame(() => {
      canvasShellRef.current?.focus({ preventScroll: true });
    });
  }, []);

  function openStorageDialog(): void {
    setStorageForm(storageConfigToForm(storageConfig));
    setStorageSecretTouched(false);
    setStorageError("");
    setStorageMessage("");
    setIsStorageDialogOpen(true);
  }

  function openApiDialog(): void {
    setApiEditIndex(null);
    setApiEditForm({ name: "", apiKey: "", baseURL: "" });
    setApiSecretTouched(false);
    setIsApiDialogOpen(true);
  }

  async function exportAllData(): Promise<void> {
    try {
      const projectSnapshot = localStorage.getItem(PROJECT_SNAPSHOT_KEY);
      const generationHistory = localStorage.getItem(GENERATION_HISTORY_KEY);
      const apiProvidersData = localStorage.getItem("api-providers");
      const assets = await listLocalAssets();

      const exportData = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        project: projectSnapshot ? JSON.parse(projectSnapshot) : null,
        history: generationHistory ? JSON.parse(generationHistory) : [],
        apiProviders: apiProvidersData ? JSON.parse(apiProvidersData) : [],
        assets: await Promise.all(assets.map(async (asset) => ({
          id: asset.id,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          createdAt: asset.createdAt,
          data: await blobToDataUrl(asset.blob)
        })))
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gpt-image-canvas-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setGenerationMessage("已导出所有数据，请妥善保存备份文件。");
    } catch {
      setGenerationError("导出失败，请重试。");
    }
  }

  async function importDataFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const importData = JSON.parse(text);

      if (!importData.version || !importData.project) {
        throw new Error("无效的备份文件格式。");
      }

      // Merge project snapshot (import as additional, don't overwrite current)
      if (importData.project) {
        const currentSnapshot = localStorage.getItem(PROJECT_SNAPSHOT_KEY);
        if (!currentSnapshot) {
          localStorage.setItem(PROJECT_SNAPSHOT_KEY, JSON.stringify(importData.project));
        }
      }

      // Merge generation history (import as additional, don't overwrite)
      if (Array.isArray(importData.history)) {
        const savedHistory = localStorage.getItem(GENERATION_HISTORY_KEY);
        const existingHistory = savedHistory ? JSON.parse(savedHistory) : [];
        const existingIds = new Set(existingHistory.map((r: { id: string }) => r.id));
        const merged = [...existingHistory, ...importData.history.filter((r: { id: string }) => !existingIds.has(r.id))];
        localStorage.setItem(GENERATION_HISTORY_KEY, JSON.stringify(merged));
      }

      // Merge API providers (import as additional, don't overwrite)
      if (importData.apiProviders) {
        const savedProviders = localStorage.getItem("api-providers");
        const existingProviders = savedProviders ? JSON.parse(savedProviders) : [];
        if (!Array.isArray(existingProviders)) {
          localStorage.setItem("api-providers", JSON.stringify(importData.apiProviders));
        } else {
          const existingNames = new Set(existingProviders.map((p: { name: string }) => p.name));
          const merged = [...existingProviders, ...importData.apiProviders.filter((p: { name: string }) => !existingNames.has(p.name))];
          localStorage.setItem("api-providers", JSON.stringify(merged));
        }
      }

      // Import assets as additional (don't overwrite existing)
      if (Array.isArray(importData.assets)) {
        const existingAssets = await listLocalAssets();
        const existingAssetIds = new Set(existingAssets.map((a) => a.id));
        let importedCount = 0;
        for (const asset of importData.assets) {
          if (existingAssetIds.has(asset.id)) {
            continue;
          }
          const blob = dataUrlToBlob(asset.data);
          await saveLocalAsset({
            id: asset.id,
            blob,
            mimeType: asset.mimeType,
            fileName: asset.fileName,
            width: asset.width,
            height: asset.height,
            createdAt: asset.createdAt
          });
          importedCount++;
        }
        setGenerationMessage(`已导入 ${importedCount} 张图片（跳过 ${importData.assets.length - importedCount} 张已存在的图片）。`);
      } else {
        setGenerationMessage("已成功导入数据，页面将刷新。");
      }
      window.location.reload();
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "导入失败，请检查文件格式。");
    }
  }

  function triggerImportFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        void importDataFile(file);
      }
    };
    input.click();
  }

  function closeApiDialog(): void {
    setIsApiDialogOpen(false);
    setApiEditIndex(null);
    setApiEditForm({ name: "", apiKey: "", baseURL: "" });
  }

  function selectProvider(id: string): void {
    setSelectedProviderId(id);
    localStorage.setItem("api-selected-provider-id", id);
  }

  function addProvider(): void {
    const name = apiEditForm.name.trim() || `供应商 ${apiProviders.length + 1}`;
    const apiKey = apiEditForm.apiKey.trim();
    const baseURL = apiEditForm.baseURL.trim();
    if (!apiKey || !baseURL) return;
    const newProvider: ApiProvider = { id: crypto.randomUUID(), name, apiKey, baseURL };
    const next = [...apiProviders, newProvider];
    setApiProviders(next);
    localStorage.setItem("api-providers", JSON.stringify(next));
    if (!selectedProviderId) selectProvider(newProvider.id);
    setApiEditIndex(null);
    setApiEditForm({ name: "", apiKey: "", baseURL: "" });
    setApiSecretTouched(false);
  }

  function startEditProvider(index: number): void {
    const p = apiProviders[index];
    setApiEditIndex(index);
    setApiEditForm({ name: p.name, apiKey: p.apiKey, baseURL: p.baseURL });
  }

  function saveEditProvider(): void {
    if (apiEditIndex === null) return;
    const name = apiEditForm.name.trim() || `供应商 ${apiEditIndex + 1}`;
    const apiKey = apiEditForm.apiKey.trim();
    const baseURL = apiEditForm.baseURL.trim();
    if (!apiKey || !baseURL) return;
    const next = apiProviders.map((p, i) => i === apiEditIndex ? { ...p, name, apiKey, baseURL } : p);
    setApiProviders(next);
    localStorage.setItem("api-providers", JSON.stringify(next));
    setApiEditIndex(null);
    setApiEditForm({ name: "", apiKey: "", baseURL: "" });
    setApiSecretTouched(false);
  }

  function deleteProvider(index: number): void {
    const provider = apiProviders[index];
    const next = apiProviders.filter((_, i) => i !== index);
    setApiProviders(next);
    localStorage.setItem("api-providers", JSON.stringify(next));
    if (selectedProviderId === provider.id) {
      selectProvider(next.length > 0 ? next[0].id : "");
    }
    if (apiEditIndex === index) {
      setApiEditIndex(null);
      setApiEditForm({ name: "", apiKey: "", baseURL: "" });
    }
  }

  function cancelEditProvider(): void {
    setApiEditIndex(null);
    setApiEditForm({ name: "", apiKey: "", baseURL: "" });
    setApiSecretTouched(false);
  }

  const selectedProvider = apiProviders.find((p) => p.id === selectedProviderId) ?? null;

  function closeStorageDialog(): void {
    setIsStorageDialogOpen(false);
    setStorageError("");
    setStorageMessage("");
  }

  function updateStorageForm(patch: Partial<StorageConfigFormState>): void {
    setStorageForm((current) => ({
      ...current,
      ...patch
    }));
    setStorageError("");
    setStorageMessage("");
  }

  async function testStorageSettings(): Promise<void> {
    setIsStorageTesting(true);
    setStorageError("");
    setStorageMessage("");

    try {
      const response = await fetch(`${BASE_URL}api/storage/config/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
          storageConfigRequestBody(storageForm, {
            preserveSecret: !storageSecretTouched && Boolean(storageConfig?.cos.secretKey.hasSecret),
            forceEnabled: true
          })
        )
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const result = (await response.json()) as StorageTestResult;
      if (!result.ok) {
        setStorageError(result.message);
        return;
      }

      setStorageMessage(result.message);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Cloud storage test failed.");
    } finally {
      setIsStorageTesting(false);
    }
  }

  async function saveStorageSettings(): Promise<void> {
    setIsStorageSaving(true);
    setStorageError("");
    setStorageMessage("");

    try {
      const response = await fetch(`${BASE_URL}api/storage/config`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
          storageConfigRequestBody(storageForm, {
            preserveSecret: !storageSecretTouched && Boolean(storageConfig?.cos.secretKey.hasSecret)
          })
        )
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const config = (await response.json()) as StorageConfigResponse;
      setStorageConfig(config);
      setStorageForm(storageConfigToForm(config));
      setStorageSecretTouched(false);
      setStorageMessage("Cloud storage settings saved.");
      setGenerationMessage(config.enabled ? "Cloud storage is enabled." : "Cloud storage is disabled.");
      setGenerationWarning("");
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Cloud storage settings could not be saved.");
    } finally {
      setIsStorageSaving(false);
    }
  }

  useEffect(() => {
    if (!isMobileDrawer || !isAiPanelOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAiPanel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeAiPanel, isAiPanelOpen, isMobileDrawer]);

  useEffect(() => {
    if (!isMobileDrawer || !isAiPanelOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      panelCloseButtonRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
    };
  }, [isAiPanelOpen, isMobileDrawer]);

  useEffect(() => {
    generationModeRef.current = generationMode;

    const editor = editorRef.current;
    if (generationMode === "reference" && editor) {
      const nextSelection = resolveReferenceSelection(editor);
      setReferenceSelection((currentSelection) =>
        areReferenceSelectionsEqual(currentSelection, nextSelection) ? currentSelection : nextSelection
      );
      return;
    }

    setReferenceSelection((currentSelection) =>
      areReferenceSelectionsEqual(currentSelection, missingReferenceSelection) ? currentSelection : missingReferenceSelection
    );
  }, [generationMode]);

  const handleEditorMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    if (!editor.user.getIsSnapMode()) {
      editor.user.updateUserPreferences({ isSnapMode: true });
    }

    let referenceSelectionFrame: number | undefined;
    const commitReferenceSelection = (): void => {
      if (generationModeRef.current !== "reference") {
        return;
      }

      const nextSelection = resolveReferenceSelection(editor);
      setReferenceSelection((currentSelection) =>
        areReferenceSelectionsEqual(currentSelection, nextSelection) ? currentSelection : nextSelection
      );
    };
    const updateReferenceSelection = (): void => {
      if (generationModeRef.current !== "reference" || referenceSelectionFrame !== undefined) {
        return;
      }

      referenceSelectionFrame = window.requestAnimationFrame(() => {
        referenceSelectionFrame = undefined;
        commitReferenceSelection();
      });
    };

    async function saveProject(): Promise<void> {
      const requestId = saveRequestRef.current + 1;
      saveRequestRef.current = requestId;
      setSaveStatus("saving");
      setSaveError("");

      try {
        const snapshot = filterLoadingPlaceholdersFromSnapshot(editor.getSnapshot());
        localStorage.setItem(PROJECT_SNAPSHOT_KEY, JSON.stringify(snapshot));

        if (saveRequestRef.current === requestId) {
          setSaveStatus("saved");
        }
      } catch {
        if (saveRequestRef.current === requestId) {
          setSaveStatus("error");
          setSaveError("自动保存失败，当前画布已保留，请稍后继续编辑。");
        }
      }
    }

    const removeListener = editor.store.listen(
      () => {
        window.clearTimeout(saveTimerRef.current);
        setSaveStatus((status) => (status === "pending" ? status : "pending"));
        setSaveError((error) => (error ? "" : error));
        saveTimerRef.current = window.setTimeout(() => {
          void saveProject();
        }, AUTOSAVE_DEBOUNCE_MS);
      },
      {
        source: "user",
        scope: "document"
      }
    );
    const removeReferenceStoreListener = editor.store.listen(updateReferenceSelection, {
      source: "all",
      scope: "all"
    });
    editor.on("change", updateReferenceSelection);
    commitReferenceSelection();

    return () => {
      window.clearTimeout(saveTimerRef.current);
      if (referenceSelectionFrame !== undefined) {
        window.cancelAnimationFrame(referenceSelectionFrame);
      }
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
      editor.off("change", updateReferenceSelection);
      removeReferenceStoreListener();
      removeListener();
    };
  }, []);

  function selectScenePreset(nextPresetId: string): void {
    if (nextPresetId === CUSTOM_SIZE_PRESET_ID) {
      setSizePresetId(CUSTOM_SIZE_PRESET_ID);
      return;
    }

    const preset = SIZE_PRESETS.find((item) => item.id === nextPresetId);
    if (!preset) {
      return;
    }

    setSizePresetId(preset.id);
    setWidth(preset.width);
    setHeight(preset.height);
  }

  function updateWidth(value: string): void {
    setWidth(normalizeDimension(value));
    setSizePresetId(CUSTOM_SIZE_PRESET_ID);
  }

  function updateHeight(value: string): void {
    setHeight(normalizeDimension(value));
    setSizePresetId(CUSTOM_SIZE_PRESET_ID);
  }

  function applyPromptStarter(starter: string): void {
    setPrompt(starter);
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");
  }

  async function executeGeneration(
    input: GenerationSubmitInput,
    requestMode: GenerationMode,
    resolveReference?: (signal: AbortSignal) => Promise<GenerationReferenceInput | undefined>,
    referenceAssetId?: string
  ): Promise<void> {
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");

    const inputValidationMessage = generationValidationMessage(input.prompt, input.size.width, input.size.height);
    if (inputValidationMessage) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      setGenerationError("画布未就绪。");
      return;
    }

    requestGenerationNotificationPermission();

    const controller = new AbortController();
    const requestId = generationRequestRef.current + 1;
    generationRequestRef.current = requestId;
    const placeholderSet = createGenerationPlaceholders(editor, input, requestId, {
      selectPlaceholders: requestMode !== "reference"
    });
    const temporaryRecord = createTemporaryGenerationRecord({
      requestId,
      submitInput: input,
      requestMode,
      referenceAssetId
    });

    activeGenerationsRef.current.set(requestId, {
      requestId,
      temporaryRecordId: temporaryRecord.id,
      controller,
      placeholderSet
    });
    setActiveGenerationCount(activeGenerationsRef.current.size);
    setGenerationHistory((history) => [temporaryRecord, ...history.filter((record) => record.id !== temporaryRecord.id)].slice(0, 20));

    try {
      const referenceForRequest = requestMode === "reference" ? await resolveReference?.(controller.signal) : undefined;
      if (requestMode === "reference" && !referenceForRequest) {
        throw new Error("请先选择一张可用的参考图像。");
      }

      if (!selectedProvider) {
        throw new Error("请先配置 API 供应商。");
      }

      const requestBody: Record<string, unknown> = {
        prompt: input.prompt.trim(),
        presetId: input.presetId,
        size: input.size,
        quality: input.quality,
        outputFormat: input.outputFormat,
        count: input.count,
        apiKey: selectedProvider.apiKey,
        baseURL: selectedProvider.baseURL
      };

      let response: Response;

      if (requestMode === "reference" && referenceForRequest) {
        requestBody.referenceImage = referenceForRequest.referenceImage;
        response = await fetch(`${BASE_URL}api/images/edit-local`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } else {
        response = await fetch(`${BASE_URL}api/images/generate-local`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      }

      if (!response.ok) {
        const errorMessage = await readErrorMessage(response);
        throw new Error(errorMessage);
      }

      const localResult = (await response.json()) as {
        recordId: string;
        outputs: Array<{
          outputId: string;
          status: "succeeded" | "failed";
          b64Json?: string;
          error?: string;
        }>;
      };

      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      const generationId = `local-gen-${Date.now()}-${requestId}`;
      const createdAt = new Date().toISOString();
      const outputs = await Promise.all(localResult.outputs.map(async (output, index) => {
        const outputId = `output-${generationId}-${index}`;
        if (output.status === "succeeded" && output.b64Json) {
          const assetId = `asset-${generationId}-${index}`;
          const mimeType = input.outputFormat === "jpeg" ? "image/jpeg" : input.outputFormat === "webp" ? "image/webp" : "image/png";
          const blob = dataUrlToBlob(`data:${mimeType};base64,${output.b64Json}`);
          const assetFileName = `${assetId}.${input.outputFormat === "jpeg" ? "jpg" : input.outputFormat}`;

          await saveLocalAsset({
            id: assetId,
            blob,
            mimeType,
            fileName: assetFileName,
            width: input.size.width,
            height: input.size.height,
            createdAt
          });

          let assetUrl = await blobToDataUrl(blob);
          let assetCloud: GeneratedAsset["cloud"] = undefined;

          try {
            const uploadResp = await fetch(`${BASE_URL}api/assets/upload-local`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ b64Json: output.b64Json, fileName: assetFileName, mimeType, createdAt })
            });
            if (uploadResp.ok) {
              const uploadResult = await uploadResp.json();
              assetUrl = uploadResult.url;
              assetCloud = uploadResult.cloud;
            }
          } catch {
            // COS upload failed, fall back to data URL
          }

          return {
            id: outputId,
            status: "succeeded" as const,
            asset: {
              id: assetId,
              url: assetUrl,
              fileName: assetFileName,
              mimeType,
              width: input.size.width,
              height: input.size.height,
              cloud: assetCloud
            }
          };
        }
        return {
          id: outputId,
          status: "failed" as const,
          error: output.error || "图像数据为空"
        };
      }));

      const successCount = outputs.filter((o) => o.status === "succeeded").length;
      const failureCount = outputs.length - successCount;
      const status = successCount > 0 && failureCount > 0 ? "partial" : successCount > 0 ? "succeeded" : "failed";

      const record: GenerationRecord = {
        id: generationId,
        mode: requestMode === "reference" ? "edit" : "generate",
        prompt: input.prompt.trim(),
        effectivePrompt: composePrompt(input.prompt.trim(), input.presetId),
        presetId: input.presetId,
        size: input.size,
        quality: input.quality,
        outputFormat: input.outputFormat,
        count: input.count,
        status,
        error: failureCount > 0 ? `${failureCount} 张图像生成失败。` : undefined,
        referenceAssetId: requestMode === "reference" && referenceForRequest ? referenceForRequest.referenceAssetId : undefined,
        createdAt: new Date().toISOString(),
        outputs
      };

      setGenerationHistory((history) =>
        [record, ...history.filter((r) => r.id !== temporaryRecord.id && r.id !== record.id)].slice(0, 20)
      );
      localStorage.setItem(GENERATION_HISTORY_KEY, JSON.stringify(
        [record, ...generationHistory.filter((r) => r.id !== temporaryRecord.id && r.id !== record.id)].slice(0, 20)
      ));

      const insertedCount = replaceGenerationPlaceholders(editor, placeholderSet, record);
      if (insertedCount > 0) {
        setGenerationMessage(
          failureCount > 0
            ? `已向画布插入 ${insertedCount} 张图像，${failureCount} 张失败。`
            : `已向画布插入 ${insertedCount} 张图像。`
        );
        showGenerationCompleteNotification(record, insertedCount, failureCount);
      } else {
        setGenerationError(record.error || "没有可插入的成功图像。");
      }
    } catch (error) {
      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      const message = error instanceof Error ? error.message : "生成失败，请重试。";
      markGenerationPlaceholdersFailed(editor, placeholderSet, message);
      setGenerationHistory((history) =>
        history.map((record) => (record.id === temporaryRecord.id ? { ...record, status: "failed", error: message } : record))
      );
      setGenerationError(message);
    } finally {
      if (activeGenerationsRef.current.delete(requestId)) {
        setActiveGenerationCount(activeGenerationsRef.current.size);
      }
    }
  }

  async function submitGeneration(): Promise<void> {
    const input: GenerationSubmitInput = {
      prompt: trimmedPrompt,
      presetId: stylePreset,
      sizePresetId,
      size: {
        width,
        height
      },
      quality,
      outputFormat,
      count
    };

    if (generationMode === "reference") {
      await executeGeneration(input, "reference", async (signal) => {
        if (referenceSelection.status !== "ready") {
          return undefined;
        }

        return {
          referenceImage: await readReferenceImage(referenceSelection, signal),
          referenceAssetId: referenceSelection.localAssetId
        };
      }, referenceSelection.status === "ready" ? referenceSelection.localAssetId : undefined);
      return;
    }

    await executeGeneration(input, "text");
  }

  function cancelReferenceSelection(): void {
    editorRef.current?.selectNone();
    setReferenceSelection(missingReferenceSelection);
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");
  }

  function locateHistoryRecord(record: GenerationRecord): void {
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");

    const editor = editorRef.current;
    if (!editor) {
      setGenerationError("画布未就绪。");
      return;
    }

    const shapeId = findCanvasImageShape(editor, record);
    if (!shapeId) {
      const activeTask = Array.from(activeGenerationsRef.current.values()).find((task) => task.temporaryRecordId === record.id);
      const placeholderId = activeTask ? firstLiveGenerationPlaceholder(editor, activeTask.placeholderSet) : undefined;
      if (!placeholderId) {
        setGenerationError("画布上找不到这张历史图片，可能已被删除。");
        return;
      }

      const bounds = editor.getShapePageBounds(placeholderId);
      editor.select(placeholderId);
      if (bounds) {
        editor.zoomToBounds(bounds, {
          animation: { duration: 220 },
          inset: 96
        });
      } else {
        editor.zoomToSelection({ animation: { duration: 220 } });
      }
      setGenerationMessage("已定位到生成中的任务。");
      return;
    }

    const bounds = editor.getShapePageBounds(shapeId);
    editor.select(shapeId);
    if (bounds) {
      editor.zoomToBounds(bounds, {
        animation: { duration: 220 },
        inset: 96
      });
    } else {
      editor.zoomToSelection({ animation: { duration: 220 } });
    }
    setGenerationMessage("已定位到历史图像。");
  }

  async function rerunHistoryRecord(record: GenerationRecord): Promise<void> {
    const nextPresetId = coerceStylePresetId(record.presetId);
    const nextSizePresetId = sizePresetIdForSize(record.size.width, record.size.height);
    const nextCount = coerceGenerationCount(record.count);

    setPrompt(record.prompt);
    setStylePreset(nextPresetId);
    setSizePresetId(nextSizePresetId);
    setWidth(record.size.width);
    setHeight(record.size.height);
    setQuality(record.quality);
    setOutputFormat(record.outputFormat);
    setCount(nextCount);

    const nextGenerationMode: GenerationMode = record.referenceAssetId ? "reference" : "text";
    setGenerationMode(nextGenerationMode);

    await executeGeneration(
      {
        prompt: record.prompt,
        presetId: nextPresetId,
        sizePresetId: nextSizePresetId,
        size: record.size,
        quality: record.quality,
        outputFormat: record.outputFormat,
        count: nextCount
      },
      nextGenerationMode,
      record.referenceAssetId
        ? async (signal) => ({
            referenceImage: await readStoredReferenceImage(record.referenceAssetId!, signal),
            referenceAssetId: record.referenceAssetId
          })
        : undefined,
      record.referenceAssetId
    );
  }

  async function downloadHistoryRecord(record: GenerationRecord): Promise<void> {
    const asset = firstDownloadableAsset(record);
    setGenerationWarning("");
    if (!asset) {
      setGenerationError("这条历史记录没有可下载的本地资源。");
      return;
    }

    try {
      const localAsset = await getLocalAsset(asset.id);
      if (!localAsset) {
        setGenerationError("本地存储中找不到该图像。");
        return;
      }

      const url = URL.createObjectURL(localAsset.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = localAsset.fileName;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setGenerationMessage("已开始下载。");
    } catch {
      setGenerationError("下载失败，请重试。");
    }
  }

  function reuseGalleryImage(item: GalleryImageItem): void {
    const nextPresetId = coerceStylePresetId(item.presetId);
    const nextSizePresetId = sizePresetIdForSize(item.size.width, item.size.height);

    setPrompt(item.prompt);
    setStylePreset(nextPresetId);
    setSizePresetId(nextSizePresetId);
    setWidth(item.size.width);
    setHeight(item.size.height);
    setQuality(item.quality);
    setOutputFormat(item.outputFormat);
    setCount(1);
    setGenerationMode("text");
    setGenerationError("");
    setGenerationWarning("");
    setGenerationMessage("已从 Gallery 填入生成参数。");
    navigateToRoute("canvas");
    if (isMobileDrawer) {
      setIsAiPanelOpen(true);
    }
  }

  function removeGalleryOutputFromHistory(outputId: string): void {
    setGenerationHistory((history) =>
      history.flatMap((record) => {
        const nextOutputs = record.outputs.filter((output) => output.id !== outputId);
        if (nextOutputs.length === record.outputs.length) {
          return [record];
        }
        if (nextOutputs.length === 0) {
          return [];
        }
        return [
          {
            ...record,
            outputs: nextOutputs
          }
        ];
      })
    );
  }

  async function copyHistoryPrompt(record: GenerationRecord): Promise<void> {
    const promptText = record.prompt.trim();
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");

    if (!promptText) {
      setGenerationError("这条历史记录没有可复制的提示词。");
      return;
    }

    try {
      await writeClipboardText(promptText);
      setGenerationMessage("已复制提示词。");
    } catch {
      setGenerationError("复制失败，请手动复制提示词。");
    }
  }

  function cancelGeneration(requestId: number): void {
    const task = activeGenerationsRef.current.get(requestId);
    if (!task) {
      return;
    }

    task.controller.abort();
    const editor = editorRef.current;
    if (editor) {
      deleteLoadingGenerationPlaceholders(editor, task.placeholderSet);
    }

    activeGenerationsRef.current.delete(requestId);
    setActiveGenerationCount(activeGenerationsRef.current.size);
    setGenerationHistory((history) =>
      history.map((record) =>
        record.id === task.temporaryRecordId ? { ...record, status: "cancelled", error: "已取消本次生成。" } : record
      )
    );
    setGenerationError("");
    setGenerationMessage("已取消本次生成。");
    setGenerationWarning("");
  }

  return (
    <div className="app-root">
      <TopNavigation
        route={route}
        onNavigate={navigateToRoute}
        onPreloadGallery={preloadGalleryPage}
        onExport={exportAllData}
        onImport={triggerImportFile}
      />
      <main className="app-shell app-view relative flex min-h-0 overflow-hidden bg-neutral-950 text-neutral-900" data-active-route={route} hidden={route !== "canvas"}>
      <section
        className="relative min-w-0 flex-1 bg-neutral-100 outline-none"
        aria-label="gpt-image-canvas 创作画布"
        data-testid="canvas-shell"
        ref={canvasShellRef}
        tabIndex={-1}
      >
        {isProjectLoaded ? (
          <Tldraw
            assets={canvasAssetStore}
            components={tldrawComponents}
            licenseKey={TLDRAW_LICENSE_KEY}
            options={tldrawOptions}
            snapshot={projectSnapshot}
            shapeUtils={shapeUtils}
            onMount={handleEditorMount}
          />
        ) : (
          <div className="canvas-loading-state">
            <BrandMark className="brand-mark--large" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-neutral-800">正在载入 gpt-image-canvas</p>
              <p className="mt-1 text-xs text-neutral-500">本地 AI 图像画布</p>
            </div>
          </div>
        )}
      </section>

      {isMobileDrawer && isAiPanelOpen ? (
        <button
          aria-label="关闭生成到画布面板"
          className="ai-panel-backdrop"
          data-testid="ai-panel-backdrop"
          type="button"
          onClick={closeAiPanel}
        />
      ) : null}

      <button
        aria-controls="ai-panel"
        aria-expanded={isAiPanelOpen}
        aria-haspopup="dialog"
        className="mobile-ai-trigger"
        data-drawer-state={isAiPanelOpen ? "open" : "closed"}
        data-testid="open-ai-panel"
        type="button"
        onClick={() => setIsAiPanelOpen(true)}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        生成到画布
      </button>

      <aside
        aria-hidden={isMobileDrawer && !isAiPanelOpen ? true : undefined}
        aria-labelledby="ai-panel-title"
        aria-modal={isMobileDrawer && isAiPanelOpen ? true : undefined}
        className="ai-panel fixed inset-y-0 right-0 z-20 flex flex-col border-l border-neutral-200 bg-white shadow-2xl shadow-neutral-950/15"
        data-drawer-state={isAiPanelOpen ? "open" : "closed"}
        data-testid="ai-panel"
        id="ai-panel"
        role={isMobileDrawer ? "dialog" : "complementary"}
        {...(isMobileDrawer && !isAiPanelOpen ? { inert: "" } : {})}
      >
        <div className="border-b border-neutral-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="brand-lockup">
              <BrandMark />
              <div className="min-w-0">
                <BrandName />
                <p className="brand-tagline">本地 AI 图像画布</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                aria-label="API 设置"
                className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition focus:outline-none focus:ring-2 focus:ring-cyan-100 ${
                  apiProviders.length > 0
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
                }`}
                data-testid="api-settings-button"
                title={apiProviders.length > 0 ? `已配置 ${apiProviders.length} 个供应商` : "API 设置"}
                type="button"
                onClick={openApiDialog}
              >
                <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              <button
                aria-label="云存储设置"
                className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition focus:outline-none focus:ring-2 focus:ring-cyan-100 ${
                  storageConfig?.enabled
                    ? "border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100"
                    : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
                }`}
                data-testid="storage-settings-button"
                title={storageConfig?.enabled ? "云存储已开启" : "云存储设置"}
                type="button"
                onClick={openStorageDialog}
              >
                <Cloud className="size-4" aria-hidden="true" />
              </button>
              <div
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${
                  saveStatus === "error" ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"
                }`}
                data-testid="save-status"
                role="status"
              >
                <SaveStatusIcon status={saveStatus} />
                {saveStatusLabel(saveStatus)}
              </div>
              <button
                aria-label="关闭生成到画布面板"
                className="ai-panel-close"
                ref={panelCloseButtonRef}
                type="button"
                onClick={closeAiPanel}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          <h1 className="mt-1 text-xl font-semibold text-neutral-950" id="ai-panel-title">
            生成到画布
          </h1>
        </div>

        <div className="ai-panel-body flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {saveError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="save-error">
              {saveError}
            </p>
          ) : null}

          <div data-testid="generation-mode-control">
            <span className="control-label">模式</span>
            <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="模式">
              <button
                className={generationMode === "text" ? "segmented-control h-9 text-xs is-active" : "segmented-control h-9 text-xs"}
                type="button"
                aria-pressed={generationMode === "text"}
                data-testid="mode-text"
                onClick={() => setGenerationMode("text")}
              >
                提示词到画布
              </button>
              <button
                className={
                  generationMode === "reference" ? "segmented-control h-9 text-xs is-active" : "segmented-control h-9 text-xs"
                }
                type="button"
                aria-pressed={generationMode === "reference"}
                data-testid="mode-reference"
                onClick={() => setGenerationMode("reference")}
              >
                参考图到画布
              </button>
            </div>
          </div>

          <label className="block">
            <span className="control-label">提示词</span>
            <textarea
              aria-invalid={Boolean(promptValidationMessage)}
              className="prompt-textarea mt-2 h-32 w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm leading-6 text-neutral-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              id="prompt-input"
              name="prompt"
              placeholder="描述画面主体、场景、光线、构图和关键细节"
              value={prompt}
              data-testid="prompt-input"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          {!trimmedPrompt ? (
            <div className="-mt-3 flex flex-wrap gap-2" data-testid="prompt-starters">
              {promptStarters.map((starter) => (
                <button
                  className="prompt-chip"
                  key={starter.label}
                  type="button"
                  title={starter.prompt}
                  data-testid="prompt-starter-chip"
                  onClick={() => applyPromptStarter(starter.prompt)}
                >
                  {starter.label}
                </button>
              ))}
            </div>
          ) : null}

          {panelStatus ? (
            <div
              aria-live={panelStatus.tone === "progress" ? "polite" : "assertive"}
              className={`panel-status-strip ${panelStatusStyles[panelStatus.tone]}`}
              data-testid={panelStatus.testId}
              role={panelStatus.tone === "success" || panelStatus.tone === "progress" ? "status" : "alert"}
            >
              <PanelStatusIcon tone={panelStatus.tone} />
              <p className="min-w-0 flex-1">{panelStatus.message}</p>
            </div>
          ) : null}

          {isReferenceMode ? (
            <section
              className={`rounded-md border px-3 py-3 ${
                isReferenceReady ? "border-blue-200 bg-blue-50 text-blue-800" : "border-neutral-200 bg-neutral-50 text-neutral-600"
              }`}
              data-reference-state={referenceSelection.status}
              data-testid="reference-state"
            >
              <div className="flex items-start gap-2">
                <ImageIcon className={`mt-0.5 size-4 ${isReferenceReady ? "text-blue-600" : "text-neutral-400"}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{isReferenceReady ? "参考图到画布已就绪" : "请选择一张参考图"}</p>
                  <p className="mt-1 text-xs leading-5" data-testid="reference-hint">
                    {referenceSelection.hint}
                  </p>
                  {referenceSelection.status === "ready" ? (
                    <div className="reference-preview-card">
                      <img
                        alt={`参考图：${referenceSelection.name}`}
                        className="reference-preview-card__image"
                        src={referenceSelection.sourceUrl}
                      />
                      <p className="min-w-0 flex-1 truncate text-xs font-medium" data-testid="reference-name">
                        {referenceSelection.name}
                        <span>{Math.round(referenceSelection.width)} x {Math.round(referenceSelection.height)}</span>
                      </p>
                      <button
                        className="secondary-action h-8 shrink-0 px-2 text-xs"
                        type="button"
                        data-testid="cancel-reference"
                        onClick={cancelReferenceSelection}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                        取消参考
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <label className="block">
            <span className="control-label">风格</span>
            <select
              className="field-control"
              id="style-preset"
              name="stylePreset"
              value={stylePreset}
              data-testid="style-preset"
              onChange={(event) => setStylePreset(event.target.value as StylePresetId)}
            >
              {STYLE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {stylePresetLabels[preset.id]}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="control-label">尺寸</span>
            <div className="quick-size-grid" data-testid="quick-size-presets">
              {quickSizePresets.map((preset) => (
                <button
                  aria-pressed={sizePresetId === preset.id}
                  className={sizePresetId === preset.id ? "quick-size-button is-active" : "quick-size-button"}
                  key={preset.id}
                  type="button"
                  onClick={() => selectScenePreset(preset.id)}
                >
                  <span>{sizePresetLabel(preset)}</span>
                  <small>
                    {preset.width} x {preset.height}
                  </small>
                </button>
              ))}
              <button
                aria-pressed={sizePresetId === CUSTOM_SIZE_PRESET_ID}
                className={sizePresetId === CUSTOM_SIZE_PRESET_ID ? "quick-size-button is-active" : "quick-size-button"}
                type="button"
                onClick={() => selectScenePreset(CUSTOM_SIZE_PRESET_ID)}
              >
                <span>自定义</span>
                <small>手动输入</small>
              </button>
            </div>
            <label className="mt-3 block">
              <span className="sr-only">全部尺寸</span>
              <select
                className="field-control"
                id="scene-preset"
                name="scenePreset"
                value={sizePresetId}
                data-testid="scene-preset"
                onChange={(event) => selectScenePreset(event.target.value)}
              >
                {SIZE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {sizePresetOptionLabel(preset)}
                  </option>
                ))}
                <option value={CUSTOM_SIZE_PRESET_ID}>自定义尺寸</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="control-label">宽度</span>
              <input
                className="field-control"
                id="custom-width"
                min={MIN_IMAGE_DIMENSION}
                max={MAX_IMAGE_DIMENSION}
                name="width"
                step={1}
                type="number"
                value={Number.isNaN(width) ? "" : width}
                data-testid="custom-width"
                onChange={(event) => updateWidth(event.target.value)}
              />
            </label>
            <label>
              <span className="control-label">高度</span>
              <input
                className="field-control"
                id="custom-height"
                min={MIN_IMAGE_DIMENSION}
                max={MAX_IMAGE_DIMENSION}
                name="height"
                step={1}
                type="number"
                value={Number.isNaN(height) ? "" : height}
                data-testid="custom-height"
                onChange={(event) => updateHeight(event.target.value)}
              />
            </label>
          </div>

          <div>
            <span className="control-label">数量</span>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {GENERATION_COUNTS.map((item) => (
                <button
                  className={item === count ? "segmented-control is-active" : "segmented-control"}
                  key={item}
                  type="button"
                  onClick={() => setCount(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <details className="rounded-md border border-neutral-200 bg-neutral-50">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-sm font-medium text-neutral-800">
              高级设置
              <ChevronDown className="size-4 text-neutral-500" aria-hidden="true" />
            </summary>
            <div className="space-y-4 border-t border-neutral-200 px-3 py-4">
              <label className="block">
                <span className="control-label">质量</span>
                <select
                  className="field-control"
                  id="quality-select"
                  name="quality"
                  value={quality}
                  data-testid="quality-select"
                  onChange={(event) => setQuality(event.target.value as ImageQuality)}
                >
                  {IMAGE_QUALITIES.map((item) => (
                    <option key={item} value={item}>
                      {qualityLabels[item]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="control-label">输出格式</span>
                <select
                  className="field-control"
                  id="format-select"
                  name="outputFormat"
                  value={outputFormat}
                  data-testid="format-select"
                  onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}
                >
                  {OUTPUT_FORMATS.map((item) => (
                    <option key={item} value={item}>
                      {formatLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>

          <section className="space-y-3" data-history-expanded={isHistoryExpanded} data-testid="generation-history">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-neutral-950">生成历史</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-500">{generationHistory.length} 条</span>
                {hasAdditionalHistory ? (
                  <button
                    aria-expanded={isHistoryExpanded}
                    className="history-toggle"
                    data-testid="history-toggle"
                    type="button"
                    onClick={() => setIsHistoryExpanded((expanded) => !expanded)}
                  >
                    {isHistoryExpanded ? "收起" : `展开 ${hiddenHistoryCount} 条`}
                    <ChevronDown className={`size-3.5 transition ${isHistoryExpanded ? "rotate-180" : ""}`} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>

            {generationHistory.length === 0 ? (
              <p className="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500">
                暂无记录。
              </p>
            ) : (
              <div className="history-list">
                {visibleHistory.map((record) => {
                  const downloadableAsset = firstDownloadableAsset(record);
                  const excerpt = promptExcerpt(record.prompt);
                  const totalOutputs = record.outputs.length || record.count;
                  const activeTask = Array.from(activeGenerationsRef.current.values()).find((task) => task.temporaryRecordId === record.id);
                  const isRecordRunning = record.status === "running" && Boolean(activeTask);
                  const cloudFailedCount = cloudFailureCount(record);
                  const cloudFailureMessage = firstCloudFailureMessage(record);

                  return (
                    <article
                      className="history-item"
                      data-testid="history-record"
                      key={record.id}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`history-status-pill ${historyStatusStyles[record.status]}`}>
                            {statusLabels[record.status]}
                          </span>
                          <span className="truncate text-xs text-neutral-500">{modeLabels[record.mode]}</span>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium leading-5 text-neutral-950" title={record.prompt}>
                          {excerpt}
                        </p>
                        <dl className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-5 text-neutral-500">
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">尺寸</dt>
                            <dd>
                              {record.size.width} x {record.size.height}
                            </dd>
                          </div>
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">输出数量</dt>
                            <dd>
                              {successfulOutputCount(record)} / {totalOutputs} 张
                            </dd>
                          </div>
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">创建时间</dt>
                            <dd>{formatCreatedTime(record.createdAt)}</dd>
                          </div>
                          {cloudFailedCount > 0 ? (
                            <div className="inline-flex items-center gap-1 text-amber-700" title={cloudFailureMessage}>
                              <dt className="sr-only">云端备份</dt>
                              <dd className="inline-flex items-center gap-1">
                                <Cloud className="size-3" aria-hidden="true" />
                                云端失败 {cloudFailedCount}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>

                      <div className="history-actions">
                        <button
                          aria-label={`复制历史提示词：${excerpt}`}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-copy-prompt"
                          title="复制提示词"
                          onClick={() => void copyHistoryPrompt(record)}
                        >
                          <Copy className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          aria-label={`定位历史记录：${excerpt}`}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-locate"
                          title="定位"
                          onClick={() => locateHistoryRecord(record)}
                        >
                          <MapPin className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          aria-label={`重跑历史记录：${excerpt}`}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-rerun"
                          disabled={isRecordRunning}
                          title={isRecordRunning ? "任务运行中" : "重跑"}
                          onClick={() => void rerunHistoryRecord(record)}
                        >
                          <RotateCcw className="size-4" aria-hidden="true" />
                        </button>
                        {activeTask && record.status === "running" ? (
                          <button
                            aria-label={`取消生成任务：${excerpt}`}
                            className="history-icon-action"
                            type="button"
                            data-testid="history-cancel"
                            title="取消"
                            onClick={() => cancelGeneration(activeTask.requestId)}
                          >
                            <XCircle className="size-4" aria-hidden="true" />
                          </button>
                        ) : (
                          <button
                            aria-label={`下载历史记录：${excerpt}`}
                            className="history-icon-action"
                            type="button"
                            data-testid="history-download"
                            disabled={!downloadableAsset}
                            title={downloadableAsset ? "下载" : "没有可下载的本地资源"}
                            onClick={() => downloadHistoryRecord(record)}
                          >
                            <Download className="size-4" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="ai-panel-actions grid grid-cols-1 gap-3 border-t border-neutral-200 bg-white px-5 py-4">
          <button
            className="primary-action"
            disabled={!canGenerate}
            type="button"
            data-generation-mode={generationMode}
            data-reference-mode={isReferenceReady ? "edit" : "generate"}
            data-testid="generate-button"
            title={validationMessage || undefined}
            onClick={submitGeneration}
          >
            {isReferenceReady ? (
              <ImageIcon className="size-4" aria-hidden="true" />
            ) : (
              <Square className="size-4" aria-hidden="true" />
            )}
            {generationMode === "reference" ? "参考图生成到画布" : "生成到画布"}
          </button>
        </div>
      </aside>

      {isStorageDialogOpen ? (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-neutral-950/45 px-4 py-6" data-testid="storage-dialog">
          <div
            aria-labelledby="storage-dialog-title"
            aria-modal="true"
            className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-neutral-950" id="storage-dialog-title">
                  云存储设置
                </h2>
                <p className="mt-1 text-xs leading-5 text-neutral-500">腾讯云 COS，生成图本地保存后同步上传。</p>
              </div>
              <button
                aria-label="关闭云存储设置"
                className="history-icon-action"
                type="button"
                onClick={closeStorageDialog}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto px-5 py-5">
              {storageError ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700" role="alert">
                  {storageError}
                </p>
              ) : null}
              {storageMessage ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-5 text-emerald-700" role="status">
                  {storageMessage}
                </p>
              ) : null}

              <label className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-3">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-neutral-900">启用 COS 双写</span>
                  <span className="mt-0.5 block text-xs leading-5 text-neutral-500">关闭后新图只写本地，已有云端对象保留。</span>
                </span>
                <input
                  checked={storageForm.enabled}
                  className="size-4 accent-blue-600"
                  data-testid="storage-enabled"
                  id="storage-enabled"
                  name="storageEnabled"
                  type="checkbox"
                  onChange={(event) => updateStorageForm({ enabled: event.target.checked })}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block sm:col-span-2">
                  <span className="control-label">SecretId</span>
                  <input
                    className="field-control"
                    data-testid="storage-secret-id"
                    id="storage-secret-id"
                    name="storageSecretId"
                    value={storageForm.secretId}
                    onChange={(event) => updateStorageForm({ secretId: event.target.value })}
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="control-label">SecretKey</span>
                  <input
                    className="field-control"
                    data-testid="storage-secret-key"
                    id="storage-secret-key"
                    name="storageSecretKey"
                    type={storageSecretTouched ? "password" : "text"}
                    value={storageForm.secretKey}
                    onChange={(event) => {
                      setStorageSecretTouched(true);
                      updateStorageForm({ secretKey: event.target.value });
                    }}
                  />
                </label>
                <label className="block">
                  <span className="control-label">Bucket</span>
                  <input
                    className="field-control"
                    data-testid="storage-bucket"
                    id="storage-bucket"
                    name="storageBucket"
                    value={storageForm.bucket}
                    onChange={(event) => updateStorageForm({ bucket: event.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="control-label">Region</span>
                  <input
                    className="field-control"
                    data-testid="storage-region"
                    id="storage-region"
                    name="storageRegion"
                    value={storageForm.region}
                    onChange={(event) => updateStorageForm({ region: event.target.value })}
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="control-label">Key Prefix</span>
                  <input
                    className="field-control"
                    data-testid="storage-prefix"
                    id="storage-prefix"
                    name="storagePrefix"
                    value={storageForm.keyPrefix}
                    onChange={(event) => updateStorageForm({ keyPrefix: event.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-neutral-200 px-5 py-4">
              <button
                className="secondary-action h-10"
                data-testid="storage-test"
                disabled={isStorageTesting || isStorageSaving}
                type="button"
                onClick={() => void testStorageSettings()}
              >
                {isStorageTesting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Cloud className="size-4" aria-hidden="true" />}
                测试
              </button>
              <button
                className="primary-action h-10"
                data-testid="storage-save"
                disabled={isStorageSaving || isStorageTesting}
                type="button"
                onClick={() => void saveStorageSettings()}
              >
                {isStorageSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isApiDialogOpen ? (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-neutral-950/45 px-4 py-6" data-testid="api-dialog">
          <div
            aria-labelledby="api-dialog-title"
            aria-modal="true"
            className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-neutral-950" id="api-dialog-title">
                  API 供应商
                </h2>
                <p className="mt-1 text-xs leading-5 text-neutral-500">管理多组 API 配置，生成时可自由切换。</p>
              </div>
              <button
                aria-label="关闭 API 设置"
                className="history-icon-action"
                type="button"
                onClick={closeApiDialog}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              {apiEditIndex !== null ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <button className="text-xs text-neutral-500 hover:text-neutral-900" type="button" onClick={cancelEditProvider}>
                      ← 返回列表
                    </button>
                    <span className="text-sm font-medium text-neutral-700">
                      {apiEditIndex === -1 ? "添加供应商" : "编辑供应商"}
                    </span>
                  </div>
                  <label className="block">
                    <span className="control-label">名称</span>
                    <input
                      className="field-control"
                      value={apiEditForm.name}
                      onChange={(event) => setApiEditForm((c) => ({ ...c, name: event.target.value }))}
                      placeholder="例如：OpenAI 官方"
                    />
                  </label>
                  <label className="block">
                    <span className="control-label">API Key</span>
                    <input
                      className="field-control"
                      data-testid="api-key"
                      type={apiSecretTouched ? "password" : "text"}
                      value={apiEditForm.apiKey}
                      onChange={(event) => {
                        setApiSecretTouched(true);
                        setApiEditForm((c) => ({ ...c, apiKey: event.target.value }));
                      }}
                      placeholder="sk-..."
                    />
                  </label>
                  <label className="block">
                    <span className="control-label">Base URL</span>
                    <input
                      className="field-control"
                      data-testid="api-base-url"
                      value={apiEditForm.baseURL}
                      onChange={(event) => setApiEditForm((c) => ({ ...c, baseURL: event.target.value }))}
                      placeholder="https://your-api.com/v1"
                    />
                  </label>
                  <div className="flex gap-2 pt-1">
                    <button
                      className="primary-action flex-1 h-9 text-sm"
                      type="button"
                      disabled={!apiEditForm.apiKey.trim() || !apiEditForm.baseURL.trim()}
                      onClick={apiEditIndex === -1 ? addProvider : saveEditProvider}
                    >
                      保存
                    </button>
                    <button className="h-9 rounded-md border border-neutral-200 px-3 text-sm text-neutral-600 hover:bg-neutral-50" type="button" onClick={cancelEditProvider}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-neutral-500">当前使用</span>
                    <div className="flex items-center gap-2">
                      <select
                        className="field-control flex-1"
                        value={selectedProviderId}
                        onChange={(event) => selectProvider(event.target.value)}
                      >
                        {apiProviders.length === 0 && (
                          <option value="">未配置供应商</option>
                        )}
                        {apiProviders.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-1 pt-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-neutral-500">供应商列表</span>
                      <button
                        className="text-xs text-cyan-600 hover:text-cyan-700"
                        type="button"
                        onClick={() => {
                          setApiEditIndex(-1);
                          setApiEditForm({ name: "", apiKey: "", baseURL: "" });
                          setApiSecretTouched(false);
                        }}
                      >
                        + 添加
                      </button>
                    </div>
                    {apiProviders.length === 0 && (
                      <p className="py-3 text-center text-xs text-neutral-400">暂无供应商，请点击「+ 添加」配置。</p>
                    )}
                    <div className="space-y-1">
                      {apiProviders.map((p, index) => (
                        <div
                          key={p.id}
                          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition ${
                            p.id === selectedProviderId
                              ? "border-cyan-200 bg-cyan-50"
                              : "border-neutral-200 hover:bg-neutral-50"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-neutral-900 truncate">{p.name}</span>
                              {p.id === selectedProviderId && (
                                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-500" />
                              )}
                            </div>
                            <div className="text-xs text-neutral-400 truncate">{p.baseURL}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              className="h-6 w-6 inline-flex items-center justify-center rounded text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100"
                              type="button"
                              onClick={() => startEditProvider(index)}
                              title="编辑"
                            >
                              <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                              </svg>
                            </button>
                            <button
                              className="h-6 w-6 inline-flex items-center justify-center rounded text-neutral-400 hover:text-red-600 hover:bg-red-50"
                              type="button"
                              onClick={() => deleteProvider(index)}
                              title="删除"
                            >
                              <X className="size-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      </main>
      {route === "gallery" ? (
        <Suspense
          fallback={
            <main className="gallery-page app-view" data-testid="gallery-loading-page">
              <div className="gallery-empty-state gallery-empty-state--boot" role="status">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <p>正在载入 Gallery...</p>
              </div>
            </main>
          }
        >
          <LazyGalleryPage onDeleted={removeGalleryOutputFromHistory} onReuse={reuseGalleryImage} />
        </Suspense>
      ) : null}
    </div>
  );
}
